//! Native UCI adapter. Process and clock access are deliberately outside `xq-core`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use xq_core::{Game, Move, Position};
use xq_review::{Analyzer, Limit, Line, PvEnd, ReviewScore};

const POLL: Duration = Duration::from_millis(10);
const STOP_GRACE: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UciError {
    Io(String),
    Protocol(String),
    Timeout,
    Cancelled,
    EngineExited { status: Option<i32> },
}

impl std::fmt::Display for UciError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for UciError {}

/// Score, principal variation and node count of one `info ... multipv` line.
type InfoLine = (ReviewScore, Vec<Move>, u64);

/// Consecutive `info` lines with distinct ranks. A rank that repeats starts the next batch, so the
/// lines an engine re-sends after a node-limit cut never overwrite an earlier complete batch.
struct Batch {
    depth: u32,
    mixed_depth: bool,
    ranks: std::collections::BTreeMap<usize, InfoLine>,
}

#[derive(Clone, Default)]
pub struct AnalysisCancellation(Arc<AtomicBool>);
impl AnalysisCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn reset(&self) {
        self.0.store(false, Ordering::Release);
    }
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub struct UciAnalyzer {
    child: Child,
    commands: mpsc::Sender<String>,
    lines: mpsc::Receiver<String>,
    name: String,
    timeout: Duration,
    cancellation: AnalysisCancellation,
    multipv_supported: bool,
    protocol_poisoned: bool,
}

impl UciAnalyzer {
    pub fn with_args<I, S>(
        program: impl AsRef<std::ffi::OsStr>,
        args: I,
        timeout: Duration,
    ) -> Result<Self, UciError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| UciError::Io(e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| UciError::Io("missing stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| UciError::Io("missing stdout".into()))?;
        let deadline = Instant::now() + timeout;
        let (tx, lines) = mpsc::sync_channel(128);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let (commands, command_rx) = mpsc::channel::<String>();
        thread::spawn(move || write_commands(stdin, command_rx));
        let mut adapter = Self {
            child,
            commands,
            lines,
            name: String::new(),
            timeout,
            cancellation: AnalysisCancellation::default(),
            multipv_supported: false,
            protocol_poisoned: false,
        };
        let setup = (|| {
            adapter.send("uci")?;
            loop {
                let line = adapter.receive(deadline, None)?;
                if let Some(name) = line.strip_prefix("id name ") {
                    adapter.name = name.trim().to_owned();
                }
                if line.starts_with("option name MultiPV ") {
                    adapter.multipv_supported = true;
                }
                if line == "uciok" {
                    break;
                }
            }
            adapter.ready(deadline)?;
            Ok(())
        })();
        if let Err(error) = setup {
            adapter.terminate();
            return Err(error);
        }
        Ok(adapter)
    }

    pub fn name(&self) -> String {
        self.name.clone()
    }
    pub fn cancellation_handle(&self) -> AnalysisCancellation {
        self.cancellation.clone()
    }

    pub fn analyze_game_checked(
        &mut self,
        game: &Game,
        limit: Limit,
        multipv: usize,
    ) -> Result<Vec<Line>, UciError> {
        self.analyze_internal(game.position(), Some(game), limit, multipv, &mut || false)
    }

    fn analyze_internal(
        &mut self,
        position: &Position,
        game: Option<&Game>,
        limit: Limit,
        multipv: usize,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Result<Vec<Line>, UciError> {
        if limit.nodes == 0
            || multipv == 0
            || position.legal_moves_for(position.side_to_move()).is_empty()
        {
            return Ok(Vec::new());
        }
        // An engine reports at most as many lines as there are legal moves, so ask for no more.
        let multipv = multipv.min(position.legal_moves_for(position.side_to_move()).len());
        if self.protocol_poisoned {
            self.terminate();
            return Err(UciError::Protocol("duplicate bestmove".into()));
        }
        if multipv > 1 && !self.multipv_supported {
            return Err(UciError::Protocol(
                "engine does not advertise MultiPV".into(),
            ));
        }
        self.cancellation.reset();
        let deadline = Instant::now() + self.timeout;
        let result = self.search(position, game, limit, multipv, deadline, should_stop);
        if result.is_err() {
            self.terminate();
        }
        result
    }

    fn search(
        &mut self,
        position: &Position,
        game: Option<&Game>,
        limit: Limit,
        multipv: usize,
        deadline: Instant,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Result<Vec<Line>, UciError> {
        if self.multipv_supported {
            self.send(&format!("setoption name MultiPV value {multipv}"))?;
        }
        self.ready(deadline)?;
        if let Some(game) = game {
            let moves = game
                .history_moves()
                .map(|m| m.to_iccs())
                .collect::<Vec<_>>()
                .join(" ");
            let suffix = if moves.is_empty() {
                String::new()
            } else {
                format!(" moves {moves}")
            };
            self.send(&format!(
                "position fen {}{suffix}",
                game.initial_position().to_fen()
            ))?;
        } else {
            self.send(&format!("position fen {}", position.to_fen()))?;
        }
        self.send(&format!("go nodes {}", limit.nodes))?;
        let mut batches: Vec<Batch> = Vec::new();
        let best;
        loop {
            let line = match self.receive(deadline, Some(should_stop)) {
                Err(UciError::Cancelled) => {
                    let _ = self.send("stop");
                    let grace = Instant::now() + STOP_GRACE;
                    loop {
                        match self.receive(grace, None) {
                            Ok(line) if line.starts_with("bestmove ") => break,
                            Ok(_) => continue,
                            Err(_) => break,
                        }
                    }
                    return Err(UciError::Cancelled);
                }
                other => other?,
            };
            if line.starts_with("info ")
                && let Some((rank, depth, score, pv, nodes)) = parse_info(&line)
            {
                if rank == 0 || rank > multipv || depth == 0 {
                    return Err(UciError::Protocol("invalid MultiPV rank or depth".into()));
                }
                match batches.last_mut() {
                    Some(batch) if !batch.ranks.contains_key(&rank) => {
                        batch.mixed_depth |= batch.depth != depth;
                        batch.ranks.insert(rank, (score, pv, nodes));
                    }
                    _ => batches.push(Batch {
                        depth,
                        mixed_depth: false,
                        ranks: std::iter::once((rank, (score, pv, nodes))).collect(),
                    }),
                }
            }
            if let Some(text) = line.strip_prefix("bestmove ") {
                let token = text.split_whitespace().next().unwrap_or("");
                best = if token == "(none)" || token == "0000" {
                    None
                } else {
                    Some(
                        Move::from_iccs(token)
                            .map_err(|_| UciError::Protocol("invalid bestmove".into()))?,
                    )
                };
                break;
            }
        }
        // Flush protocol stragglers before accepting another search; extra bestmove is corruption.
        while let Ok(line) = self.lines.try_recv() {
            if line.starts_with("bestmove ") {
                self.protocol_poisoned = true;
            }
        }
        let Batch {
            depth: selected_depth,
            ranks: selected,
            ..
        } = batches
            .into_iter()
            .rev()
            .find(|batch| {
                !batch.mixed_depth && (1..=multipv).all(|rank| batch.ranks.contains_key(&rank))
            })
            .ok_or_else(|| UciError::Protocol("incomplete MultiPV result".into()))?;
        let mut results = Vec::with_capacity(multipv);
        for rank in 1..=multipv {
            let (score, pv, nodes) = selected.get(&rank).expect("complete rank set");
            if pv.is_empty() {
                return Err(UciError::Protocol("empty PV".into()));
            }
            let pv_end = validate_pv(position, pv)?;
            results.push(Line {
                best_move: pv[0],
                score: *score,
                principal_variation: pv.clone(),
                depth: u8::try_from(selected_depth).unwrap_or(u8::MAX),
                nodes: *nodes,
                pv_end,
            });
        }
        let distinct_first_moves = results
            .iter()
            .map(|line| line.best_move)
            .collect::<std::collections::HashSet<_>>();
        if distinct_first_moves.len() != results.len() {
            return Err(UciError::Protocol("duplicate MultiPV first move".into()));
        }
        // `bestmove` may come from an iteration the node limit cut short, so it can differ from
        // the primary line of the last complete depth. It must still be a legal move.
        if let Some(best) = best
            && !position.clone().legal_moves().contains(&best)
        {
            return Err(UciError::Protocol("illegal bestmove".into()));
        }
        Ok(results)
    }

    fn send(&mut self, command: &str) -> Result<(), UciError> {
        self.commands
            .send(command.to_owned())
            .map_err(|e| UciError::Io(e.to_string()))
    }
    fn ready(&mut self, deadline: Instant) -> Result<(), UciError> {
        self.send("isready")?;
        loop {
            let line = self.receive(deadline, None)?;
            if line.starts_with("bestmove ") {
                return Err(UciError::Protocol(
                    "unexpected bestmove before search".into(),
                ));
            }
            if line == "readyok" {
                return Ok(());
            }
        }
    }
    fn receive(
        &mut self,
        deadline: Instant,
        should_stop: Option<&mut dyn FnMut() -> bool>,
    ) -> Result<String, UciError> {
        let mut should_stop = should_stop;
        loop {
            if Instant::now() >= deadline {
                return Err(UciError::Timeout);
            }
            if self.cancellation.cancelled() || should_stop.as_mut().is_some_and(|f| f()) {
                return Err(UciError::Cancelled);
            }
            match self.lines.recv_timeout(POLL) {
                Ok(line) if Instant::now() < deadline => return Ok(line),
                Ok(_) => return Err(UciError::Timeout),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if let Some(status) = self
                        .child
                        .try_wait()
                        .map_err(|e| UciError::Io(e.to_string()))?
                    {
                        return Err(UciError::EngineExited {
                            status: status.code(),
                        });
                    }
                    thread::sleep(POLL);
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline => {
                    return Err(UciError::Timeout);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_commands(mut stdin: ChildStdin, commands: mpsc::Receiver<String>) {
    for command in commands {
        if writeln!(stdin, "{command}")
            .and_then(|_| stdin.flush())
            .is_err()
        {
            break;
        }
    }
}

impl Analyzer for UciAnalyzer {
    fn analyze(&mut self, pos: &Position, limit: Limit, multipv: usize) -> Vec<Line> {
        self.analyze_internal(pos, None, limit, multipv, &mut || false)
            .unwrap_or_default()
    }
    fn analyze_until(
        &mut self,
        pos: &Position,
        limit: Limit,
        multipv: usize,
        stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        self.analyze_internal(pos, None, limit, multipv, stop)
            .unwrap_or_default()
    }
    fn analyze_game(&mut self, game: &Game, limit: Limit, multipv: usize) -> Vec<Line> {
        self.analyze_game_checked(game, limit, multipv)
            .unwrap_or_default()
    }
    fn analyze_game_until(
        &mut self,
        game: &Game,
        limit: Limit,
        multipv: usize,
        stop: &mut dyn FnMut() -> bool,
    ) -> Vec<Line> {
        self.analyze_internal(game.position(), Some(game), limit, multipv, stop)
            .unwrap_or_default()
    }
    fn name(&self) -> String {
        self.name.clone()
    }
}

impl Drop for UciAnalyzer {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.send("quit");
        }
        self.terminate();
    }
}

fn parse_info(line: &str) -> Option<(usize, u32, ReviewScore, Vec<Move>, u64)> {
    let words: Vec<_> = line.split_whitespace().collect();
    let mut depth = 0;
    let mut nodes = 0u64;
    let mut rank = 1;
    let mut score = None;
    let mut pv_index = None;
    let mut i = 1;
    while i < words.len() {
        match words[i] {
            "depth" if i + 1 < words.len() => {
                depth = words[i + 1].parse().ok()?;
                i += 2;
            }
            "nodes" if i + 1 < words.len() => {
                nodes = words[i + 1].parse().ok()?;
                i += 2;
            }
            "multipv" if i + 1 < words.len() => {
                rank = words[i + 1].parse().ok()?;
                i += 2;
            }
            "score" if i + 2 < words.len() => {
                score = Some(match words[i + 1] {
                    "cp" => ReviewScore::centipawns(words[i + 2].parse().ok()?),
                    "mate" => {
                        let mate: i16 = words[i + 2].parse().ok()?;
                        if mate < 0 {
                            ReviewScore::mated_in(mate.saturating_abs())
                        } else {
                            ReviewScore::mate_in(mate)
                        }
                    }
                    _ => return None,
                });
                i += 3;
                if words
                    .get(i)
                    .is_some_and(|v| *v == "lowerbound" || *v == "upperbound")
                {
                    return None;
                }
            }
            "pv" => {
                pv_index = Some(i + 1);
                break;
            }
            _ => i += 1,
        }
    }
    let score = score?;
    let pv = words
        .get(pv_index?..)?
        .iter()
        .map(|s| Move::from_iccs(s).ok())
        .collect::<Option<Vec<_>>>()?;
    Some((rank, depth, score, pv, nodes))
}

/// Replays the PV. It ends at `Terminal` when the final position has no legal move;
/// otherwise the engine simply stopped reporting, which is `DepthLimit`.
fn validate_pv(position: &Position, pv: &[Move]) -> Result<PvEnd, UciError> {
    let mut position = position.clone();
    for movement in pv {
        position
            .make_move(*movement)
            .map_err(|_| UciError::Protocol("illegal PV".into()))?;
    }
    Ok(if position.legal_moves().is_empty() {
        PvEnd::Terminal
    } else {
        PvEnd::DepthLimit
    })
}

//! History-dependent game adjudication built on the pure position core.

use crate::{Move, MoveError, Position, Side, Undo};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameOutcome {
    Win(Side),
    Draw,
}

#[derive(Clone, Copy, Debug)]
struct PlayedMove {
    undo: Undo,
    movement: Move,
    mover: Side,
    gives_check: bool,
}

/// A position plus the move history needed to adjudicate repetition and draws.
#[derive(Clone, Debug)]
pub struct Game {
    initial_position: Position,
    position: Position,
    moves: Vec<PlayedMove>,
    position_hashes: Vec<u64>,
}

impl Game {
    pub fn new(position: Position) -> Self {
        let hash = position.hash();
        Self {
            initial_position: position.clone(),
            position,
            moves: Vec::new(),
            position_hashes: vec![hash],
        }
    }

    pub const fn position(&self) -> &Position {
        &self.position
    }

    /// Initial position, retained so external analyzers can replay full history.
    pub const fn initial_position(&self) -> &Position {
        &self.initial_position
    }

    /// Ordered legal moves played since the initial position.
    pub fn history_moves(&self) -> impl ExactSizeIterator<Item = Move> + '_ {
        self.moves.iter().map(|played| played.movement)
    }

    /// Number of moves made from the initial position.
    pub fn history_len(&self) -> usize {
        self.moves.len()
    }

    /// Deterministic fingerprint for search caches that depend on draw history.
    /// This 64-bit hash can collide; callers needing exact identity must retain
    /// and compare the underlying game context as well.
    pub fn context_key(&self) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        let mut add = |value: u64| {
            for byte in value.to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        add(self.position.hash());
        add(u64::from(self.position.halfmove_clock()));
        add(self.position_hashes.len() as u64);
        for key in &self.position_hashes {
            add(*key);
        }
        add(self.moves.len() as u64);
        for played in &self.moves {
            add(played.movement.from.index() as u64);
            add(played.movement.to.index() as u64);
            add(match played.mover {
                crate::Side::Red => 0,
                crate::Side::Black => 1,
            });
            add(u64::from(played.gives_check));
        }
        hash
    }

    /// Play a legal move. Illegal moves leave the position and history untouched.
    pub fn play(&mut self, movement: Move) -> Result<(), MoveError> {
        if self.outcome().is_some() {
            return Err(MoveError::IllegalMove);
        }
        let mover = self.position.side_to_move();
        let undo = self.position.make_move(movement)?;
        let gives_check = self.position.is_in_check(mover.opposite());
        self.moves.push(PlayedMove {
            undo,
            movement,
            mover,
            gives_check,
        });
        self.position_hashes.push(self.position.hash());
        Ok(())
    }

    pub fn undo_last_move(&mut self) -> Option<Move> {
        let played = self.moves.pop()?;
        self.position_hashes.pop();
        let movement = played.movement;
        self.position.unmake_move(played.undo);
        Some(movement)
    }

    pub fn outcome(&self) -> Option<GameOutcome> {
        let mut position = self.position.clone();
        if position.legal_moves().is_empty() {
            return Some(GameOutcome::Win(self.position.side_to_move().opposite()));
        }

        let current = self.position.hash();
        let occurrences: Vec<_> = self
            .position_hashes
            .iter()
            .enumerate()
            .filter_map(|(index, hash)| (*hash == current).then_some(index))
            .collect();
        if occurrences.len() >= 3 {
            // At the third occurrence, adjudicate the entire repeated segment:
            // moves from the first matching position through the current one.
            // Earlier moves in the game are not part of that segment.
            let repetition_start = occurrences[0];
            let mut red_moves = 0;
            let mut black_moves = 0;
            let mut red_always_checks = true;
            let mut black_always_checks = true;
            for played in &self.moves[repetition_start..] {
                match played.mover {
                    Side::Red => {
                        red_moves += 1;
                        red_always_checks &= played.gives_check;
                    }
                    Side::Black => {
                        black_moves += 1;
                        black_always_checks &= played.gives_check;
                    }
                }
            }
            let red_perpetual = red_moves > 0 && red_always_checks;
            let black_perpetual = black_moves > 0 && black_always_checks;
            match (red_perpetual, black_perpetual) {
                (true, false) => return Some(GameOutcome::Win(Side::Black)),
                (false, true) => return Some(GameOutcome::Win(Side::Red)),
                (false, false) => return Some(GameOutcome::Draw),
                (true, true) => return Some(GameOutcome::Draw),
            }
        }

        if self.position.halfmove_clock() >= 120 {
            return Some(GameOutcome::Draw);
        }
        None
    }
}

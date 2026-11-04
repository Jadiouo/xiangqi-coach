//! Pure parsing and recognition for supported Xiangqi text records.
use std::collections::BTreeMap;

use crate::locale::{ImportErrorText, import_error_message_zh};
use crate::notation::parse_chinese_move;
use crate::{
    Game, Move, MoveNotationError, Piece, PieceKind, Position, STARTPOS_FEN, Side, Square,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotationFormat {
    Iccs,
    Chinese,
    Pgn,
    DhtmlXq,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportErrorKind {
    UnknownFormat,
    InvalidNotation,
    IllegalMove,
    Ambiguous,
    InvalidPosition,
    MalformedRecord,
    GameOver,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportError {
    pub step: usize,
    pub token: String,
    pub decoded_move: Option<String>,
    pub kind: ImportErrorKind,
    pub candidates: Vec<String>,
    pub(crate) reason: ImportErrorText,
    raw_source_bytes: Option<Vec<u8>>,
}
impl ImportError {
    pub fn message_zh(&self) -> String {
        import_error_message_zh(self)
    }

    pub fn raw_source_bytes(&self) -> Option<&[u8]> {
        self.raw_source_bytes.as_deref()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportWarning {
    VariationsNotImported,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportResult {
    pub format: Option<NotationFormat>,
    pub initial_position: Position,
    pub moves: Vec<Move>,
    pub error: Option<ImportError>,
    pub warnings: Vec<ImportWarning>,
    pub metadata: BTreeMap<String, String>,
    pub is_standard_start: bool,
}

pub fn import_record(text: &str) -> ImportResult {
    if text.contains("[DhtmlXQ_movelist]") {
        return import_dhtml(text);
    }
    let (format, initial, body, metadata) =
        if text.lines().any(|line| line.trim_start().starts_with('[')) {
            let (headers, body) = parse_headers(text);
            let initial = if let Some(fen) = headers.get("FEN") {
                match Position::from_fen(fen) {
                    Ok(position) => position,
                    Err(_error) => {
                        let mut result = empty_result(
                            Some(NotationFormat::Pgn),
                            Position::startpos(),
                            headers.clone(),
                        );
                        result.error = Some(err(
                            0,
                            fen,
                            ImportErrorKind::InvalidPosition,
                            ImportErrorText::InvalidFen,
                        ));
                        return result;
                    }
                }
            } else {
                Position::startpos()
            };
            (Some(NotationFormat::Pgn), initial, body, headers)
        } else {
            let token = tokens(text).into_iter().next();
            let format = token.as_deref().and_then(detect_token);
            let initial = Position::startpos();
            (format, initial, text.to_string(), BTreeMap::new())
        };
    let standard = is_standard_position(&initial);
    let mut result = empty_result(format, initial, metadata);
    result.is_standard_start = standard;
    if format.is_none() {
        result.error = Some(err(
            1,
            text.trim(),
            ImportErrorKind::UnknownFormat,
            ImportErrorText::UnknownFormat,
        ));
        return result;
    }
    parse_moves(&mut result, &body);
    result
}

fn empty_result(
    format: Option<NotationFormat>,
    initial_position: Position,
    metadata: BTreeMap<String, String>,
) -> ImportResult {
    let standard = is_standard_position(&initial_position);
    ImportResult {
        format,
        initial_position,
        moves: vec![],
        error: None,
        warnings: vec![],
        metadata,
        is_standard_start: standard,
    }
}
fn err(step: usize, token: &str, kind: ImportErrorKind, reason: ImportErrorText) -> ImportError {
    ImportError {
        step,
        token: token.to_string(),
        decoded_move: None,
        kind,
        candidates: vec![],
        reason,
        raw_source_bytes: None,
    }
}

fn err_with_raw_source_bytes(
    step: usize,
    token: &str,
    kind: ImportErrorKind,
    reason: ImportErrorText,
    raw_source_bytes: &[u8],
) -> ImportError {
    let mut error = err(step, token, kind, reason);
    error.raw_source_bytes = Some(raw_source_bytes.to_vec());
    error
}

fn is_legacy_marker(marker: &[u8]) -> bool {
    marker.len() == 4
        && marker
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        && matches!(marker[2], b'X' | b'Y' | b'Z')
}

fn is_standard_position(position: &Position) -> bool {
    position.to_fen().split_whitespace().next() == STARTPOS_FEN.split_whitespace().next()
}
fn is_move_number(s: &str) -> bool {
    let s = s.trim_matches('.');
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
fn is_result(s: &str) -> bool {
    matches!(s, "*" | "1-0" | "0-1" | "1/2-1/2")
}
fn strip_attached_move_number(token: &str) -> &str {
    let digits = token.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return token;
    }
    let after_number = &token[digits..];
    let dots = after_number
        .bytes()
        .take_while(|byte| *byte == b'.')
        .count();
    if dots == 0 {
        token
    } else {
        &after_number[dots..]
    }
}
fn parse_headers(text: &str) -> (BTreeMap<String, String>, String) {
    let mut headers = BTreeMap::new();
    let mut body = String::new();
    for line in text.lines() {
        let s = line.trim();
        if s.starts_with('[') && s.ends_with(']') {
            if let Some(space) = s.find(char::is_whitespace) {
                let key = &s[1..space];
                let value = s[space..]
                    .trim()
                    .trim_start_matches('"')
                    .trim_end_matches(']')
                    .trim_end_matches('"');
                headers.insert(key.to_string(), value.to_string());
            }
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    (headers, body)
}
fn detect_token(token: &str) -> Option<NotationFormat> {
    let t = token.trim_matches(|c: char| !c.is_alphanumeric() && !('一'..='龥').contains(&c));
    if t.chars()
        .any(|c| "帥帅將将仕士相象馬马車车炮砲包兵卒進进退平前中後后".contains(c))
    {
        Some(NotationFormat::Chinese)
    } else if (t.len() == 4 || t.len() == 5)
        && t.as_bytes()
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
    {
        Some(NotationFormat::Iccs)
    } else {
        None
    }
}
fn tokens(body: &str) -> Vec<String> {
    body.split_whitespace()
        .flat_map(|word| {
            word.split(|c: char| {
                matches!(
                    c,
                    ',' | ';' | '(' | ')' | '{' | '}' | '，' | '。' | '；' | '、'
                )
            })
            .filter(|part| !part.is_empty())
            .flat_map(|part| {
                let cleaned = part.trim_matches(|c: char| c == '"' || c == '\'');
                let cleaned = strip_attached_move_number(cleaned);
                let cleaned = cleaned.trim_end_matches('.');
                if cleaned.is_empty() || is_move_number(cleaned) || is_result(cleaned) {
                    return vec![];
                }
                if cleaned.len() > 4
                    && cleaned.is_ascii()
                    && cleaned.bytes().all(|b| b.is_ascii_alphanumeric())
                    && cleaned.len().is_multiple_of(4)
                {
                    return cleaned
                        .as_bytes()
                        .chunks(4)
                        .map(|c| String::from_utf8_lossy(c).to_string())
                        .collect();
                }
                vec![cleaned.to_string()]
            })
            .collect::<Vec<_>>()
        })
        .collect()
}
fn parse_moves(result: &mut ImportResult, body: &str) {
    let entries = tokens(body)
        .into_iter()
        .map(|token| (token.clone(), token, None))
        .collect();
    parse_move_entries(result, entries);
}

fn parse_move_entries(result: &mut ImportResult, entries: Vec<(String, String, Option<String>)>) {
    let mut game = Game::new(result.initial_position.clone());
    for (index, (source_token, notation, decoded_move)) in entries.into_iter().enumerate() {
        if game.outcome().is_some() {
            let mut e = err(
                index + 1,
                &source_token,
                ImportErrorKind::GameOver,
                ImportErrorText::GameOver,
            );
            e.decoded_move = decoded_move;
            result.error = Some(e);
            break;
        }
        let position = game.position();
        let parsed = if notation
            .chars()
            .any(|c| "帥帅將将仕士相象馬马車车炮砲包兵卒進进退平前中後后".contains(c))
        {
            parse_chinese_move(position, &notation)
        } else {
            let normalized = notation.replace('-', "");
            Move::from_iccs(&normalized).map_err(|_| MoveNotationError::Unrecognized)
        };
        let movement = match parsed {
            Ok(m) => m,
            Err(MoveNotationError::Ambiguous(moves)) => {
                let mut e = err(
                    index + 1,
                    &source_token,
                    ImportErrorKind::Ambiguous,
                    ImportErrorText::Ambiguous,
                );
                e.decoded_move = decoded_move;
                e.candidates = moves.iter().map(|m| m.to_iccs()).collect();
                result.error = Some(e);
                break;
            }
            Err(_) => {
                let mut e = err(
                    index + 1,
                    &source_token,
                    ImportErrorKind::InvalidNotation,
                    ImportErrorText::InvalidNotation,
                );
                e.decoded_move = decoded_move;
                result.error = Some(e);
                break;
            }
        };
        if game.play(movement).is_err() {
            let mut e = err(
                index + 1,
                &source_token,
                ImportErrorKind::IllegalMove,
                ImportErrorText::IllegalMove,
            );
            e.decoded_move = decoded_move;
            result.error = Some(e);
            break;
        }
        result.moves.push(movement);
    }
}
fn import_dhtml(text: &str) -> ImportResult {
    let tags = parse_dhtml_tags(text);
    let mut metadata = BTreeMap::new();
    for (key, value) in &tags {
        if !key.starts_with("DhtmlXQ_move_") && key != "DhtmlXQ_movelist" && key != "DhtmlXQ_binit"
        {
            metadata.insert(
                key.trim_start_matches("DhtmlXQ_").to_string(),
                value.clone(),
            );
        }
    }
    let initial = tags
        .get("DhtmlXQ_binit")
        .map(|s| binit_position(s))
        .unwrap_or_else(|| Ok(Position::startpos()));
    let mut result = match initial {
        Ok(p) => empty_result(Some(NotationFormat::DhtmlXq), p, metadata),
        Err(()) => {
            let mut r = empty_result(
                Some(NotationFormat::DhtmlXq),
                Position::startpos(),
                metadata,
            );
            r.error = Some(err(
                1,
                "DhtmlXQ_binit",
                ImportErrorKind::InvalidPosition,
                ImportErrorText::InvalidBinit,
            ));
            return r;
        }
    };
    if tags.keys().any(|key| key.starts_with("DhtmlXQ_move_")) {
        result.warnings.push(ImportWarning::VariationsNotImported);
    }
    let Some(movelist) = tags.get("DhtmlXQ_movelist") else {
        result.error = Some(err(
            1,
            "DhtmlXQ_movelist",
            ImportErrorKind::MalformedRecord,
            ImportErrorText::MissingMoves,
        ));
        return result;
    };
    let mut raw_moves = Vec::new();
    let mut raw_move_bytes = Vec::new();
    let is_legacy_record_stream = movelist.as_bytes().get(..8).is_some_and(|prefix| {
        prefix[..4].iter().all(u8::is_ascii_digit) && is_legacy_marker(&prefix[4..8])
    });
    if is_legacy_record_stream {
        for (index, chunk) in movelist.as_bytes().chunks(12).enumerate() {
            let start = index * 12;
            let token =
                source_token_for_byte_range(movelist, start, start + chunk.len()).to_owned();
            if chunk.len() != 12 || !chunk.is_ascii() {
                result.error = Some(err_with_raw_source_bytes(
                    index + 1,
                    &token,
                    ImportErrorKind::MalformedRecord,
                    ImportErrorText::MalformedMoves,
                    chunk,
                ));
                break;
            }
            if !chunk[..4].iter().all(u8::is_ascii_digit) {
                result.error = Some(err_with_raw_source_bytes(
                    index + 1,
                    &token,
                    ImportErrorKind::MalformedRecord,
                    ImportErrorText::NonDigitCoordinates,
                    chunk,
                ));
                break;
            }
            if !is_legacy_marker(&chunk[4..8]) {
                result.error = Some(err_with_raw_source_bytes(
                    index + 1,
                    &token,
                    ImportErrorKind::MalformedRecord,
                    ImportErrorText::InvalidLegacyMarker,
                    chunk,
                ));
                break;
            }
            let sequence = &chunk[8..12];
            if !sequence.iter().all(u8::is_ascii_digit) {
                result.error = Some(err_with_raw_source_bytes(
                    index + 1,
                    &token,
                    ImportErrorKind::MalformedRecord,
                    ImportErrorText::NonDigitLegacySequence,
                    chunk,
                ));
                break;
            }
            let sequence = std::str::from_utf8(sequence)
                .ok()
                .and_then(|sequence| sequence.parse::<usize>().ok());
            if sequence != Some(index) {
                result.warnings.push(ImportWarning::VariationsNotImported);
                break;
            }
            raw_moves.push(token);
            raw_move_bytes.push(chunk.to_vec());
        }
    } else {
        for (index, chunk) in movelist.as_bytes().chunks(4).enumerate() {
            let start = index * 4;
            raw_moves
                .push(source_token_for_byte_range(movelist, start, start + chunk.len()).to_owned());
            raw_move_bytes.push(chunk.to_vec());
        }
    }
    let mut decoded = Vec::with_capacity(raw_moves.len());
    for (index, (raw, source_bytes)) in raw_moves.into_iter().zip(raw_move_bytes).enumerate() {
        let coordinates = raw.get(..4).unwrap_or("");
        let b = coordinates.as_bytes();
        if b.len() != 4 {
            result.error = Some(err_with_raw_source_bytes(
                index + 1,
                &raw,
                ImportErrorKind::MalformedRecord,
                ImportErrorText::MalformedMoves,
                &source_bytes,
            ));
            break;
        }
        if !b.iter().all(u8::is_ascii_digit) {
            result.error = Some(err_with_raw_source_bytes(
                index + 1,
                &raw,
                ImportErrorKind::MalformedRecord,
                ImportErrorText::NonDigitCoordinates,
                &source_bytes,
            ));
            break;
        }
        let x1 = b[0] - b'0';
        let y1 = b[1] - b'0';
        let x2 = b[2] - b'0';
        let y2 = b[3] - b'0';
        if x1 > 8 || x2 > 8 || y1 > 9 || y2 > 9 {
            result.error = Some(err_with_raw_source_bytes(
                index + 1,
                &raw,
                ImportErrorKind::MalformedRecord,
                ImportErrorText::CoordinatesOutOfBounds,
                &source_bytes,
            ));
            break;
        }
        decoded.push((
            raw,
            format!(
                "{}{}{}{}",
                char::from(b'a' + x1),
                9 - y1,
                char::from(b'a' + x2),
                9 - y2
            ),
        ));
    }
    if let Some(first) = decoded
        .first()
        .and_then(|(_, text)| Move::from_iccs(text).ok())
        && result
            .initial_position
            .piece_at(first.from)
            .is_some_and(|piece| piece.side == Side::Black)
    {
        result.initial_position = with_side_to_move(&result.initial_position, Side::Black);
        result.is_standard_start = is_standard_position(&result.initial_position);
    }
    let entries = decoded
        .into_iter()
        .map(|(source, decoded)| (source, decoded.clone(), Some(decoded)))
        .collect();
    parse_move_entries(&mut result, entries);
    result
}

fn source_token_for_byte_range(source: &str, start: usize, end: usize) -> &str {
    let mut start = start.min(source.len());
    while !source.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = end.min(source.len());
    while end < source.len() && !source.is_char_boundary(end) {
        end += 1;
    }
    &source[start..end]
}

fn with_side_to_move(position: &Position, side: Side) -> Position {
    let fields: Vec<_> = position
        .to_fen()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut fen = fields;
    fen[1] = if side == Side::Red { "w" } else { "b" }.to_string();
    Position::from_fen(&fen.join(" ")).expect("changing the FEN side preserves position validity")
}
fn parse_dhtml_tags(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut rest = text;
    while let Some(start) = rest.find("[DhtmlXQ_") {
        rest = &rest[start + 1..];
        let Some(end) = rest.find(']') else { break };
        let key = &rest[..end];
        let closing = format!("[/{key}]");
        let tail = &rest[end + 1..];
        let Some(close) = tail.find(&closing) else {
            break;
        };
        out.insert(key.to_string(), tail[..close].to_string());
        rest = &tail[close + closing.len()..];
    }
    out
}
fn binit_position(raw: &str) -> Result<Position, ()> {
    if raw.len() != 64 || !raw.is_ascii() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    let order = [
        PieceKind::Rook,
        PieceKind::Horse,
        PieceKind::Elephant,
        PieceKind::Advisor,
        PieceKind::King,
        PieceKind::Advisor,
        PieceKind::Elephant,
        PieceKind::Horse,
        PieceKind::Rook,
        PieceKind::Cannon,
        PieceKind::Cannon,
        PieceKind::Pawn,
        PieceKind::Pawn,
        PieceKind::Pawn,
        PieceKind::Pawn,
        PieceKind::Pawn,
    ];
    let mut board = [None; 90];
    for (index, kind) in order
        .iter()
        .copied()
        .enumerate()
        .chain(order.iter().copied().enumerate().map(|(i, k)| (i + 16, k)))
    {
        let offset = index * 2;
        let pair = &raw[offset..offset + 2];
        if pair == "99" {
            continue;
        }
        let bytes = pair.as_bytes();
        let file = bytes[0] - b'0';
        let y = bytes[1] - b'0';
        if file > 8 || y > 9 {
            return Err(());
        }
        let square = Square::new(file, 9 - y).ok_or(())?;
        if board[square.index()].is_some() {
            return Err(());
        }
        let side = if index < 16 { Side::Red } else { Side::Black };
        board[square.index()] = Some(Piece { side, kind });
    }
    let mut rows = Vec::new();
    for rank in (0..10).rev() {
        let mut row = String::new();
        let mut empty = 0;
        for file in 0..9 {
            let sq = Square::new(file, rank).ok_or(())?;
            match board[sq.index()] {
                None => empty += 1,
                Some(piece) => {
                    if empty > 0 {
                        row.push(char::from(b'0' + empty));
                        empty = 0;
                    }
                    row.push(match (piece.side, piece.kind) {
                        (Side::Red, PieceKind::King) => 'K',
                        (Side::Red, PieceKind::Advisor) => 'A',
                        (Side::Red, PieceKind::Elephant) => 'B',
                        (Side::Red, PieceKind::Horse) => 'N',
                        (Side::Red, PieceKind::Rook) => 'R',
                        (Side::Red, PieceKind::Cannon) => 'C',
                        (Side::Red, PieceKind::Pawn) => 'P',
                        (Side::Black, PieceKind::King) => 'k',
                        (Side::Black, PieceKind::Advisor) => 'a',
                        (Side::Black, PieceKind::Elephant) => 'b',
                        (Side::Black, PieceKind::Horse) => 'n',
                        (Side::Black, PieceKind::Rook) => 'r',
                        (Side::Black, PieceKind::Cannon) => 'c',
                        (Side::Black, PieceKind::Pawn) => 'p',
                    });
                }
            }
        }
        if empty > 0 {
            row.push(char::from(b'0' + empty));
        }
        rows.push(row);
    }
    Position::from_fen(&format!("{} w - - 0 1", rows.join("/"))).map_err(|_| ())
}

//! Pure notation conversion helpers. Record loading and file/network I/O live in callers.

use crate::{Move, PieceKind, Position, Side, Square};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MoveNotationError {
    IllegalMove,
    Unrecognized,
    Ambiguous(Vec<Move>),
}

/// Format one legal move as ICCS coordinate notation.
pub fn format_iccs_move(position: &Position, movement: Move) -> Result<String, MoveNotationError> {
    let mut copy = position.clone();
    if !copy.legal_moves().contains(&movement) {
        return Err(MoveNotationError::IllegalMove);
    }
    Ok(movement.to_iccs())
}

/// Format one legal move as traditional Chinese notation.
pub fn format_chinese_move(
    position: &Position,
    movement: Move,
) -> Result<String, MoveNotationError> {
    let mut copy = position.clone();
    let legal = copy.legal_moves();
    if !legal.contains(&movement) {
        return Err(MoveNotationError::IllegalMove);
    }
    forms_for_move(position, movement, &legal)
        .into_iter()
        .next()
        .ok_or(MoveNotationError::IllegalMove)
}

/// Parse one Chinese notation token against the legal moves in the position.
pub fn parse_chinese_move(position: &Position, token: &str) -> Result<Move, MoveNotationError> {
    let target = normalize_notation(token);
    let mut copy = position.clone();
    let legal = copy.legal_moves();
    let matched: Vec<_> = legal
        .iter()
        .copied()
        .filter(|movement| {
            forms_for_move(position, *movement, &legal)
                .iter()
                .any(|form| normalize_notation(form) == target)
                || base_for_move(position, *movement)
                    .is_some_and(|base| normalize_notation(&base) == target)
        })
        .collect();
    match matched.as_slice() {
        [movement] => Ok(*movement),
        [] => Err(MoveNotationError::Unrecognized),
        _ => Err(MoveNotationError::Ambiguous(matched)),
    }
}

fn forms_for_move(position: &Position, movement: Move, legal: &[Move]) -> Vec<String> {
    let Some(piece) = position.piece_at(movement.from) else {
        return Vec::new();
    };
    let base = base_notation(piece.kind, piece.side, movement);
    let collisions: Vec<_> = legal
        .iter()
        .copied()
        .filter(|candidate| {
            position
                .piece_at(candidate.from)
                .is_some_and(|other| other.kind == piece.kind && other.side == piece.side)
                && base_for_move(position, *candidate).as_deref() == Some(base.as_str())
        })
        .collect();
    if collisions.len() <= 1 {
        return vec![base];
    }

    let same_file: Vec<_> = collisions
        .iter()
        .filter_map(|candidate| {
            let source = position.piece_at(candidate.from)?;
            (candidate.from.file() == movement.from.file()
                && source.kind == piece.kind
                && source.side == piece.side)
                .then_some(candidate.from)
        })
        .collect();
    if same_file.len() <= 1 {
        return vec![base];
    }
    let ordered = ordered_file_pieces(position, piece.side, piece.kind, movement.from.file());
    let Some(ordinal) = ordered.iter().position(|square| *square == movement.from) else {
        return vec![base];
    };
    let prefix = ordinal_name(ordinal, ordered.len());
    let action_target = action_and_target(piece.kind, piece.side, movement);
    if piece.kind == PieceKind::Pawn && has_multiple_double_pawn_files(position, piece.side) {
        vec![format!(
            "{prefix}{}{}",
            side_number(piece.side, movement.from.file()),
            action_target
        )]
    } else {
        vec![format!(
            "{prefix}{}{action_target}",
            piece_letter(piece.kind, piece.side)
        )]
    }
}

fn base_for_move(position: &Position, movement: Move) -> Option<String> {
    let piece = position.piece_at(movement.from)?;
    Some(base_notation(piece.kind, piece.side, movement))
}

fn base_notation(kind: PieceKind, side: Side, movement: Move) -> String {
    format!(
        "{}{}{}",
        piece_letter(kind, side),
        side_number(side, movement.from.file()),
        action_and_target(kind, side, movement)
    )
}

fn action_and_target(kind: PieceKind, side: Side, movement: Move) -> String {
    if movement.from.rank() == movement.to.rank() {
        return format!("平{}", side_number(side, movement.to.file()));
    }
    let forward = match side {
        Side::Red => movement.to.rank() > movement.from.rank(),
        Side::Black => movement.to.rank() < movement.from.rank(),
    };
    let action = if forward { '進' } else { '退' };
    let target = match kind {
        PieceKind::Horse | PieceKind::Elephant | PieceKind::Advisor => {
            side_number(side, movement.to.file())
        }
        _ => side_digit(side, movement.to.rank().abs_diff(movement.from.rank())),
    };
    format!("{action}{target}")
}

fn ordered_file_pieces(position: &Position, side: Side, kind: PieceKind, file: u8) -> Vec<Square> {
    let mut pieces: Vec<_> = (0..90)
        .filter_map(Square::from_index)
        .filter(|square| square.file() == file)
        .filter(|square| {
            position
                .piece_at(*square)
                .is_some_and(|piece| piece.side == side && piece.kind == kind)
        })
        .collect();
    pieces.sort_by_key(|square| match side {
        Side::Red => std::cmp::Reverse(square.rank()),
        Side::Black => std::cmp::Reverse(9 - square.rank()),
    });
    pieces
}

fn has_multiple_double_pawn_files(position: &Position, side: Side) -> bool {
    let mut counts = [0_u8; 9];
    for index in 0..90 {
        let square = Square::from_index(index).expect("board index is valid");
        if position
            .piece_at(square)
            .is_some_and(|piece| piece.side == side && piece.kind == PieceKind::Pawn)
        {
            counts[square.file() as usize] += 1;
        }
    }
    counts.into_iter().filter(|count| *count >= 2).count() >= 2
}

fn ordinal_name(index: usize, total: usize) -> &'static str {
    match (index, total) {
        (0, _) => "前",
        (i, n) if i + 1 == n => "後",
        _ => "中",
    }
}

fn piece_letter(kind: PieceKind, side: Side) -> char {
    match (side, kind) {
        (Side::Red, PieceKind::King) => '帥',
        (Side::Black, PieceKind::King) => '將',
        (Side::Red, PieceKind::Advisor) => '仕',
        (Side::Black, PieceKind::Advisor) => '士',
        (Side::Red, PieceKind::Elephant) => '相',
        (Side::Black, PieceKind::Elephant) => '象',
        (_, PieceKind::Horse) => '馬',
        (_, PieceKind::Rook) => '車',
        (_, PieceKind::Cannon) => '炮',
        (Side::Red, PieceKind::Pawn) => '兵',
        (Side::Black, PieceKind::Pawn) => '卒',
    }
}

fn side_number(side: Side, file: u8) -> char {
    let number = match side {
        Side::Red => 9 - file,
        Side::Black => file + 1,
    };
    side_digit(side, number)
}

fn side_digit(side: Side, number: u8) -> char {
    match side {
        Side::Black => char::from(b'0' + number),
        Side::Red => match number {
            1 => '一',
            2 => '二',
            3 => '三',
            4 => '四',
            5 => '五',
            6 => '六',
            7 => '七',
            8 => '八',
            9 => '九',
            _ => '?',
        },
    }
}

pub(crate) fn normalize_notation(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            '马' => '馬',
            '车' => '車',
            '帅' | '将' => 'K',
            '帥' | '將' => 'K',
            '仕' | '士' => 'A',
            '相' | '象' => 'B',
            '炮' | '砲' | '包' => 'C',
            '兵' | '卒' => 'P',
            '进' => '進',
            '后' => '後',
            '１' => '1',
            '２' => '2',
            '３' => '3',
            '４' => '4',
            '５' => '5',
            '６' => '6',
            '７' => '7',
            '８' => '8',
            '９' => '9',
            other => other,
        })
        .collect()
}

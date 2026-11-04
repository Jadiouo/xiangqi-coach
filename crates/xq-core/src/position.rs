use std::fmt;

use crate::hash::{SIDE_TO_MOVE_KEY, piece_key};

pub const STARTPOS_FEN: &str =
    "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
const FILES: i8 = 9;
const RANKS: i8 = 10;
const MAX_PIECES: [u8; 7] = [1, 2, 2, 2, 2, 2, 5];

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
pub enum Side {
    Red,
    Black,
}

impl Side {
    pub const fn opposite(self) -> Self {
        match self {
            Self::Red => Self::Black,
            Self::Black => Self::Red,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
pub enum PieceKind {
    King,
    Advisor,
    Elephant,
    Horse,
    Rook,
    Cannon,
    Pawn,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Piece {
    pub side: Side,
    pub kind: PieceKind,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
pub struct Square(u8);

impl Square {
    pub const fn new(file: u8, rank: u8) -> Option<Self> {
        if file < 9 && rank < 10 {
            Some(Self(rank * 9 + file))
        } else {
            None
        }
    }

    pub const fn from_index(index: usize) -> Option<Self> {
        if index < 90 {
            Some(Self(index as u8))
        } else {
            None
        }
    }

    pub const fn file(self) -> u8 {
        self.0 % 9
    }

    pub const fn rank(self) -> u8 {
        self.0 / 9
    }

    pub const fn index(self) -> usize {
        self.0 as usize
    }

    pub fn from_iccs(text: &str) -> Result<Self, MoveError> {
        let bytes = text.as_bytes();
        if bytes.len() != 2 {
            return Err(MoveError::InvalidNotation);
        }
        let file = bytes[0].to_ascii_lowercase();
        if !(b'a'..=b'i').contains(&file) || !bytes[1].is_ascii_digit() {
            return Err(MoveError::InvalidNotation);
        }
        Self::new(file - b'a', bytes[1] - b'0').ok_or(MoveError::InvalidNotation)
    }

    pub fn to_iccs(self) -> String {
        let mut text = String::with_capacity(2);
        text.push(char::from(b'a' + self.file()));
        text.push(char::from(b'0' + self.rank()));
        text
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
pub struct Move {
    pub from: Square,
    pub to: Square,
}

impl Move {
    pub const fn new(from: Square, to: Square) -> Self {
        Self { from, to }
    }

    pub fn from_iccs(text: &str) -> Result<Self, MoveError> {
        if !text.is_ascii() || text.len() != 4 {
            return Err(MoveError::InvalidNotation);
        }
        Ok(Self::new(
            Square::from_iccs(&text[..2])?,
            Square::from_iccs(&text[2..])?,
        ))
    }

    pub fn to_iccs(self) -> String {
        format!("{}{}", self.from.to_iccs(), self.to.to_iccs())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Undo {
    movement: Move,
    moved_piece: Piece,
    captured_piece: Option<Piece>,
    previous_side: Side,
    previous_halfmove_clock: u32,
    previous_fullmove_number: u32,
    previous_hash: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FenError(&'static str);

impl fmt::Display for FenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for FenError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveError {
    InvalidNotation,
    IllegalMove,
}

impl fmt::Display for MoveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidNotation => "invalid coordinate move",
            Self::IllegalMove => "illegal move",
        })
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    board: [Option<Piece>; 90],
    side_to_move: Side,
    halfmove_clock: u32,
    fullmove_number: u32,
    hash: u64,
}

impl Position {
    pub fn startpos() -> Self {
        Self::from_fen(STARTPOS_FEN).expect("the built-in starting FEN is valid")
    }

    pub fn from_fen(fen: &str) -> Result<Self, FenError> {
        let fields: Vec<_> = fen.split_whitespace().collect();
        if fields.len() != 6 {
            return Err(FenError("FEN must contain six fields"));
        }
        let side_to_move = match fields[1] {
            "w" => Side::Red,
            "b" => Side::Black,
            _ => return Err(FenError("side to move must be w or b")),
        };
        if fields[2] != "-" || fields[3] != "-" {
            return Err(FenError(
                "Xiangqi FEN castling and en-passant fields must be -",
            ));
        }
        let halfmove_clock = fields[4]
            .parse::<u32>()
            .map_err(|_| FenError("invalid halfmove clock"))?;
        let fullmove_number = fields[5]
            .parse::<u32>()
            .ok()
            .filter(|number| *number > 0)
            .ok_or(FenError("fullmove number must be positive"))?;

        let ranks: Vec<_> = fields[0].split('/').collect();
        if ranks.len() != 10 {
            return Err(FenError("piece placement must contain ten ranks"));
        }
        let mut board = [None; 90];
        let mut counts = [[0_u8; 7]; 2];
        for (row, rank_text) in ranks.iter().enumerate() {
            let rank = 9 - row as u8;
            let mut file = 0_u8;
            for symbol in rank_text.chars() {
                if let Some(empty) = symbol.to_digit(10) {
                    if !(1..=9).contains(&empty) {
                        return Err(FenError("empty-square counts must be from 1 through 9"));
                    }
                    file = file
                        .checked_add(empty as u8)
                        .filter(|next| *next <= 9)
                        .ok_or(FenError("rank contains more than nine squares"))?;
                    continue;
                }
                let piece = parse_piece(symbol).ok_or(FenError("unknown piece letter"))?;
                if file >= 9 {
                    return Err(FenError("rank contains more than nine squares"));
                }
                let side = side_index(piece.side);
                let kind = kind_index(piece.kind);
                counts[side][kind] += 1;
                if counts[side][kind] > MAX_PIECES[kind] {
                    return Err(FenError("too many pieces of the same kind for one side"));
                }
                board[(rank * 9 + file) as usize] = Some(piece);
                file += 1;
            }
            if file != 9 {
                return Err(FenError("each rank must contain exactly nine squares"));
            }
        }
        if counts[0][kind_index(PieceKind::King)] != 1
            || counts[1][kind_index(PieceKind::King)] != 1
        {
            return Err(FenError(
                "position must contain exactly one king for each side",
            ));
        }
        let mut position = Self {
            board,
            side_to_move,
            halfmove_clock,
            fullmove_number,
            hash: 0,
        };
        position.hash = position.compute_hash();
        Ok(position)
    }

    pub fn to_fen(&self) -> String {
        let mut placement = String::new();
        for rank in (0..10).rev() {
            if rank != 9 {
                placement.push('/');
            }
            let mut empty = 0_u8;
            for file in 0..9 {
                let square = Square::new(file, rank).expect("loop coordinates are on the board");
                if let Some(piece) = self.piece_at(square) {
                    if empty > 0 {
                        placement.push(char::from(b'0' + empty));
                        empty = 0;
                    }
                    placement.push(piece_letter(piece));
                } else {
                    empty += 1;
                }
            }
            if empty > 0 {
                placement.push(char::from(b'0' + empty));
            }
        }
        let side = match self.side_to_move {
            Side::Red => 'w',
            Side::Black => 'b',
        };
        format!(
            "{placement} {side} - - {} {}",
            self.halfmove_clock, self.fullmove_number
        )
    }

    pub const fn side_to_move(&self) -> Side {
        self.side_to_move
    }

    pub const fn halfmove_clock(&self) -> u32 {
        self.halfmove_clock
    }

    pub const fn hash(&self) -> u64 {
        self.hash
    }

    pub fn piece_at(&self, square: Square) -> Option<Piece> {
        self.board[square.index()]
    }

    /// 90 ASCII cells in display order: rank 9 down to rank 0, file a to i.
    /// Uppercase means red, lowercase means black, `.` means empty.
    pub fn board_ascii(&self) -> String {
        let mut board = String::with_capacity(90);
        for rank in (0..RANKS).rev() {
            for file in 0..FILES {
                let square =
                    Square::new(file as u8, rank as u8).expect("coordinates are on the board");
                board.push(self.piece_at(square).map_or('.', |piece| {
                    let lower = match piece.kind {
                        PieceKind::King => 'k',
                        PieceKind::Advisor => 'a',
                        PieceKind::Elephant => 'b',
                        PieceKind::Horse => 'n',
                        PieceKind::Rook => 'r',
                        PieceKind::Cannon => 'c',
                        PieceKind::Pawn => 'p',
                    };
                    match piece.side {
                        Side::Red => lower.to_ascii_uppercase(),
                        Side::Black => lower,
                    }
                }));
            }
        }
        board
    }

    pub fn legal_moves(&mut self) -> Vec<Move> {
        let moving_side = self.side_to_move;
        let pseudo_moves = self.pseudo_moves();
        let mut legal = Vec::with_capacity(pseudo_moves.len());
        for movement in pseudo_moves {
            let undo = self.make_generated_move(movement);
            let leaves_king_safe = !self.is_in_check(moving_side);
            self.unmake_move(undo);
            if leaves_king_safe {
                legal.push(movement);
            }
        }
        legal
    }

    /// Generate legal moves for a side on a cloned view without changing this position.
    pub fn legal_moves_for(&self, side: Side) -> Vec<Move> {
        let mut view = self.clone();
        if view.side_to_move != side {
            view.side_to_move = side;
            view.hash = view.compute_hash();
        }
        view.legal_moves()
    }

    pub fn make_move(&mut self, movement: Move) -> Result<Undo, MoveError> {
        if !self.is_pseudo_legal(movement) {
            return Err(MoveError::IllegalMove);
        }
        let mover = self.side_to_move;
        let undo = self.make_generated_move(movement);
        if self.is_in_check(mover) {
            self.unmake_move(undo);
            return Err(MoveError::IllegalMove);
        }
        Ok(undo)
    }

    pub fn unmake_move(&mut self, undo: Undo) {
        self.board[undo.movement.from.index()] = Some(undo.moved_piece);
        self.board[undo.movement.to.index()] = undo.captured_piece;
        self.side_to_move = undo.previous_side;
        self.halfmove_clock = undo.previous_halfmove_clock;
        self.fullmove_number = undo.previous_fullmove_number;
        self.hash = undo.previous_hash;
    }

    pub fn perft(&self, depth: u8) -> u64 {
        fn count(position: &mut Position, depth: u8) -> u64 {
            if depth == 0 {
                return 1;
            }
            let moves = position.legal_moves();
            if depth == 1 {
                return moves.len() as u64;
            }
            let mut nodes = 0_u64;
            for movement in moves {
                let undo = position.make_generated_move(movement);
                nodes += count(position, depth - 1);
                position.unmake_move(undo);
            }
            nodes
        }
        count(&mut self.clone(), depth)
    }

    pub(super) fn make_generated_move(&mut self, movement: Move) -> Undo {
        let moved_piece =
            self.board[movement.from.index()].expect("a generated move has a source piece");
        let captured_piece = self.board[movement.to.index()];
        let undo = Undo {
            movement,
            moved_piece,
            captured_piece,
            previous_side: self.side_to_move,
            previous_halfmove_clock: self.halfmove_clock,
            previous_fullmove_number: self.fullmove_number,
            previous_hash: self.hash,
        };
        self.board[movement.from.index()] = None;
        self.board[movement.to.index()] = Some(moved_piece);
        self.hash ^= piece_key(movement.from, moved_piece) ^ piece_key(movement.to, moved_piece);
        if let Some(captured) = captured_piece {
            self.hash ^= piece_key(movement.to, captured);
        }
        if captured_piece.is_some() {
            self.halfmove_clock = 0;
        } else {
            self.halfmove_clock = self.halfmove_clock.saturating_add(1);
        }
        if self.side_to_move == Side::Black {
            self.fullmove_number = self.fullmove_number.saturating_add(1);
        }
        self.side_to_move = self.side_to_move.opposite();
        self.hash ^= SIDE_TO_MOVE_KEY;
        undo
    }

    /// Whether the specified side's king is currently attacked.
    pub fn is_in_check(&self, side: Side) -> bool {
        let Some(king_square) = self.board.iter().enumerate().find_map(|(index, piece)| {
            piece
                .filter(|piece| piece.side == side && piece.kind == PieceKind::King)
                .map(|_| Square(index as u8))
        }) else {
            return true;
        };
        self.is_square_attacked(king_square, side.opposite())
    }

    fn compute_hash(&self) -> u64 {
        let mut hash = 0;
        for (index, piece) in self.board.iter().enumerate() {
            if let Some(piece) = piece {
                hash ^= piece_key(Square(index as u8), *piece);
            }
        }
        if self.side_to_move == Side::Black {
            hash ^= SIDE_TO_MOVE_KEY;
        }
        hash
    }

    fn pseudo_moves(&self) -> Vec<Move> {
        let mut moves = Vec::with_capacity(64);
        for index in 0..90 {
            let from = Square(index as u8);
            let Some(piece) = self.board[index] else {
                continue;
            };
            if piece.side != self.side_to_move {
                continue;
            }
            match piece.kind {
                PieceKind::King => {
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        self.push_target(&mut moves, from, piece, dx, dy, |to| {
                            in_palace(piece.side, to)
                        });
                    }
                }
                PieceKind::Advisor => {
                    for (dx, dy) in [(1, 1), (1, -1), (-1, 1), (-1, -1)] {
                        self.push_target(&mut moves, from, piece, dx, dy, |to| {
                            in_palace(piece.side, to)
                        });
                    }
                }
                PieceKind::Elephant => {
                    for (dx, dy) in [(2, 2), (2, -2), (-2, 2), (-2, -2)] {
                        if let Some(to) =
                            offset(from, dx, dy).filter(|to| on_own_bank(piece.side, *to))
                        {
                            let eye =
                                offset(from, dx / 2, dy / 2).expect("elephant eye is in bounds");
                            if self.board[eye.index()].is_none() {
                                self.push_if_enemy_or_empty(&mut moves, from, to, piece.side);
                            }
                        }
                    }
                }
                PieceKind::Horse => {
                    for (dx, dy, leg_x, leg_y) in [
                        (1, 2, 0, 1),
                        (-1, 2, 0, 1),
                        (1, -2, 0, -1),
                        (-1, -2, 0, -1),
                        (2, 1, 1, 0),
                        (2, -1, 1, 0),
                        (-2, 1, -1, 0),
                        (-2, -1, -1, 0),
                    ] {
                        let Some(to) = offset(from, dx, dy) else {
                            continue;
                        };
                        let leg = offset(from, leg_x, leg_y).expect("horse leg is in bounds");
                        if self.board[leg.index()].is_none() {
                            self.push_if_enemy_or_empty(&mut moves, from, to, piece.side);
                        }
                    }
                }
                PieceKind::Rook => self.add_sliding_moves(&mut moves, from, piece, false),
                PieceKind::Cannon => self.add_sliding_moves(&mut moves, from, piece, true),
                PieceKind::Pawn => {
                    let forward = if piece.side == Side::Red { 1 } else { -1 };
                    self.push_target(&mut moves, from, piece, 0, forward, |_| true);
                    if has_crossed_river(piece.side, from) {
                        self.push_target(&mut moves, from, piece, 1, 0, |_| true);
                        self.push_target(&mut moves, from, piece, -1, 0, |_| true);
                    }
                }
            }
        }
        moves
    }

    fn add_sliding_moves(&self, moves: &mut Vec<Move>, from: Square, piece: Piece, cannon: bool) {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let mut current = from;
            let mut screen = false;
            while let Some(to) = offset(current, dx, dy) {
                current = to;
                match self.board[to.index()] {
                    None if !screen => moves.push(Move::new(from, to)),
                    None => {}
                    Some(target) if !screen => {
                        if cannon {
                            screen = true;
                        } else {
                            if target.side != piece.side && target.kind != PieceKind::King {
                                moves.push(Move::new(from, to));
                            }
                            break;
                        }
                    }
                    Some(target) => {
                        if cannon && target.side != piece.side && target.kind != PieceKind::King {
                            moves.push(Move::new(from, to));
                        }
                        break;
                    }
                }
            }
        }
    }

    fn push_target(
        &self,
        moves: &mut Vec<Move>,
        from: Square,
        piece: Piece,
        dx: i8,
        dy: i8,
        allowed: impl FnOnce(Square) -> bool,
    ) {
        if let Some(to) = offset(from, dx, dy).filter(|to| allowed(*to)) {
            self.push_if_enemy_or_empty(moves, from, to, piece.side);
        }
    }

    fn push_if_enemy_or_empty(&self, moves: &mut Vec<Move>, from: Square, to: Square, side: Side) {
        match self.board[to.index()] {
            Some(piece) if piece.side == side || piece.kind == PieceKind::King => {}
            _ => moves.push(Move::new(from, to)),
        }
    }

    fn is_pseudo_legal(&self, movement: Move) -> bool {
        if movement.from == movement.to {
            return false;
        }
        let Some(piece) = self.piece_at(movement.from) else {
            return false;
        };
        if piece.side != self.side_to_move
            || self
                .piece_at(movement.to)
                .is_some_and(|target| target.side == piece.side || target.kind == PieceKind::King)
        {
            return false;
        }
        let dx = movement.to.file() as i8 - movement.from.file() as i8;
        let dy = movement.to.rank() as i8 - movement.from.rank() as i8;
        let ax = dx.abs();
        let ay = dy.abs();
        match piece.kind {
            PieceKind::King => ax + ay == 1 && in_palace(piece.side, movement.to),
            PieceKind::Advisor => ax == 1 && ay == 1 && in_palace(piece.side, movement.to),
            PieceKind::Elephant => {
                if ax != 2 || ay != 2 || !on_own_bank(piece.side, movement.to) {
                    return false;
                }
                let eye = offset(movement.from, dx / 2, dy / 2).expect("elephant eye in bounds");
                self.board[eye.index()].is_none()
            }
            PieceKind::Horse => {
                let is_horse = (ax == 1 && ay == 2) || (ax == 2 && ay == 1);
                if !is_horse {
                    return false;
                }
                let (leg_x, leg_y) = if ax == 1 {
                    (
                        movement.from.file() as i8,
                        movement.from.rank() as i8 + dy.signum(),
                    )
                } else {
                    (
                        movement.from.file() as i8 + dx.signum(),
                        movement.from.rank() as i8,
                    )
                };
                self.board[Square::new(leg_x as u8, leg_y as u8)
                    .expect("horse leg in bounds")
                    .index()]
                .is_none()
            }
            PieceKind::Rook => {
                if dx != 0 && dy != 0 {
                    return false;
                }
                self.squares_between(movement.from, movement.to) == 0
            }
            PieceKind::Cannon => {
                if dx != 0 && dy != 0 {
                    return false;
                }
                let screens = self.squares_between(movement.from, movement.to);
                if self.piece_at(movement.to).is_some() {
                    screens == 1
                } else {
                    screens == 0
                }
            }
            PieceKind::Pawn => {
                let forward = if piece.side == Side::Red { 1 } else { -1 };
                (dx == 0 && dy == forward)
                    || (dy == 0 && ax == 1 && has_crossed_river(piece.side, movement.from))
            }
        }
    }

    fn squares_between(&self, from: Square, to: Square) -> u8 {
        let dx = (to.file() as i8 - from.file() as i8).signum();
        let dy = (to.rank() as i8 - from.rank() as i8).signum();
        let mut x = from.file() as i8 + dx;
        let mut y = from.rank() as i8 + dy;
        let mut count = 0;
        while x != to.file() as i8 || y != to.rank() as i8 {
            let square = Square::new(x as u8, y as u8).expect("intermediate square is in bounds");
            if self.piece_at(square).is_some() {
                count += 1;
            }
            x += dx;
            y += dy;
        }
        count
    }

    fn is_square_attacked(&self, target: Square, by_side: Side) -> bool {
        for (index, piece) in self.board.iter().enumerate() {
            let Some(piece) = piece.filter(|piece| piece.side == by_side) else {
                continue;
            };
            let from = Square(index as u8);
            let dx = target.file() as i8 - from.file() as i8;
            let dy = target.rank() as i8 - from.rank() as i8;
            let ax = dx.abs();
            let ay = dy.abs();
            let attacks = match piece.kind {
                PieceKind::King => {
                    (ax + ay == 1 && in_palace(by_side, target))
                        || (dx == 0 && dy != 0 && self.squares_between(from, target) == 0)
                }
                PieceKind::Advisor => ax == 1 && ay == 1 && in_palace(by_side, target),
                PieceKind::Elephant => {
                    ax == 2
                        && ay == 2
                        && on_own_bank(by_side, target)
                        && offset(from, dx / 2, dy / 2)
                            .is_some_and(|eye| self.piece_at(eye).is_none())
                }
                PieceKind::Horse => {
                    if (ax == 1 && ay == 2) || (ax == 2 && ay == 1) {
                        let (leg_x, leg_y) = if ax == 1 {
                            (from.file() as i8, from.rank() as i8 + dy.signum())
                        } else {
                            (from.file() as i8 + dx.signum(), from.rank() as i8)
                        };
                        Square::new(leg_x as u8, leg_y as u8)
                            .is_some_and(|leg| self.piece_at(leg).is_none())
                    } else {
                        false
                    }
                }
                PieceKind::Rook => {
                    (dx == 0 || dy == 0)
                        && (dx != 0 || dy != 0)
                        && self.squares_between(from, target) == 0
                }
                PieceKind::Cannon => {
                    (dx == 0 || dy == 0)
                        && (dx != 0 || dy != 0)
                        && self.squares_between(from, target) == 1
                }
                PieceKind::Pawn => {
                    let forward = if by_side == Side::Red { 1 } else { -1 };
                    (dx == 0 && dy == forward)
                        || (dy == 0 && ax == 1 && has_crossed_river(by_side, from))
                }
            };
            if attacks {
                return true;
            }
        }
        false
    }
}

/// Inspect the legal recaptures after a hypothetical legal capture, without
/// changing the supplied position. Returns the captured piece and recaptures
/// onto the capture square. `None` means the proposed capture is not legal.
pub fn legal_recaptures_after_hypothetical_capture(
    position: &Position,
    attacker_side: Side,
    capture: Move,
) -> Option<(Piece, Vec<Move>)> {
    let mut view = position.clone();
    if view.side_to_move != attacker_side {
        view.side_to_move = attacker_side;
        view.hash = view.compute_hash();
    }
    let victim = view.piece_at(capture.to)?;
    if victim.side == attacker_side || !view.legal_moves().contains(&capture) {
        return None;
    }
    view.make_move(capture).ok()?;
    let recaptures = view
        .legal_moves()
        .into_iter()
        .filter(|movement| movement.to == capture.to)
        .collect();
    Some((victim, recaptures))
}

/// The position after `side` plays `movement`, even when it is not `side`'s turn. `None`
/// means the move is not legal for that side. The supplied position is not changed.
pub fn position_after_hypothetical_move(
    position: &Position,
    side: Side,
    movement: Move,
) -> Option<Position> {
    let mut view = position.clone();
    if view.side_to_move != side {
        view.side_to_move = side;
        view.hash = view.compute_hash();
    }
    if !view.legal_moves().contains(&movement) {
        return None;
    }
    view.make_move(movement).ok()?;
    Some(view)
}

fn offset(square: Square, dx: i8, dy: i8) -> Option<Square> {
    let file = square.file() as i8 + dx;
    let rank = square.rank() as i8 + dy;
    if (0..FILES).contains(&file) && (0..RANKS).contains(&rank) {
        Square::new(file as u8, rank as u8)
    } else {
        None
    }
}

fn in_palace(side: Side, square: Square) -> bool {
    (3..=5).contains(&square.file())
        && match side {
            Side::Red => (0..=2).contains(&square.rank()),
            Side::Black => (7..=9).contains(&square.rank()),
        }
}

fn on_own_bank(side: Side, square: Square) -> bool {
    match side {
        Side::Red => square.rank() <= 4,
        Side::Black => square.rank() >= 5,
    }
}

fn has_crossed_river(side: Side, square: Square) -> bool {
    match side {
        Side::Red => square.rank() >= 5,
        Side::Black => square.rank() <= 4,
    }
}

const fn kind_index(kind: PieceKind) -> usize {
    match kind {
        PieceKind::King => 0,
        PieceKind::Advisor => 1,
        PieceKind::Elephant => 2,
        PieceKind::Horse => 3,
        PieceKind::Rook => 4,
        PieceKind::Cannon => 5,
        PieceKind::Pawn => 6,
    }
}

const fn side_index(side: Side) -> usize {
    match side {
        Side::Red => 0,
        Side::Black => 1,
    }
}

fn parse_piece(symbol: char) -> Option<Piece> {
    let side = if symbol.is_ascii_uppercase() {
        Side::Red
    } else {
        Side::Black
    };
    let kind = match symbol.to_ascii_uppercase() {
        'K' => PieceKind::King,
        'A' => PieceKind::Advisor,
        'B' | 'E' => PieceKind::Elephant,
        'N' | 'H' => PieceKind::Horse,
        'R' => PieceKind::Rook,
        'C' => PieceKind::Cannon,
        'P' => PieceKind::Pawn,
        _ => return None,
    };
    Some(Piece { side, kind })
}

fn piece_letter(piece: Piece) -> char {
    let letter = match piece.kind {
        PieceKind::King => 'K',
        PieceKind::Advisor => 'A',
        PieceKind::Elephant => 'B',
        PieceKind::Horse => 'N',
        PieceKind::Rook => 'R',
        PieceKind::Cannon => 'C',
        PieceKind::Pawn => 'P',
    };
    match piece.side {
        Side::Red => letter,
        Side::Black => letter.to_ascii_lowercase(),
    }
}

use crate::{Piece, PieceKind, Side, Square};

const KEY_SEED: u64 = 0x5849_414e_4751_4901;
const MULTIPLIER: u64 = 0x9e37_79b9_7f4a_7c15;
pub(crate) const SIDE_TO_MOVE_KEY: u64 = splitmix64(KEY_SEED ^ 0xa5a5_5a5a_d3c4_b2e1);

pub(crate) fn piece_key(square: Square, piece: Piece) -> u64 {
    let side = match piece.side {
        Side::Red => 0_u64,
        Side::Black => 1,
    };
    let kind = match piece.kind {
        PieceKind::King => 0_u64,
        PieceKind::Advisor => 1,
        PieceKind::Elephant => 2,
        PieceKind::Horse => 3,
        PieceKind::Rook => 4,
        PieceKind::Cannon => 5,
        PieceKind::Pawn => 6,
    };
    let index = (side * 7 + kind) * 90 + square.index() as u64;
    splitmix64(KEY_SEED.wrapping_add(index.wrapping_mul(MULTIPLIER)))
}

const fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(MULTIPLIER);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

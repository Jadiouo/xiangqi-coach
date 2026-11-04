use xq_core::{Piece, Side, Square};

/// A supported, evidence-backed explanation attached to a marked review move.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reason {
    pub kind: ReasonKind,
    /// Mate distance from the engine score, expressed in attacker moves.
    pub moves: u16,
    /// Capture ledger for material reasons; absent for mate explanations.
    pub material: Option<MaterialEvidence>,
    /// Evidence for `SentPiece` and `AbandonedProtection`.
    pub protection: Option<ProtectionEvidence>,
    /// Evidence for `CheckCapture`.
    pub check_capture: Option<CheckCaptureEvidence>,
    /// Evidence for `CannonMount`.
    pub cannon_mount: Option<CannonMountEvidence>,
    /// Evidence for `PositionType`.
    pub position: Option<PositionEvidence>,
}

impl Reason {
    /// A reason that carries only a kind and a mate distance (all evidence absent).
    pub fn bare(kind: ReasonKind, moves: u16) -> Self {
        Self {
            kind,
            moves,
            material: None,
            protection: None,
            check_capture: None,
            cannon_mount: None,
            position: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialEvidence {
    pub mover: Side,
    pub best_net: i32,
    pub played_net: i32,
    /// Plies of the longer compared line (each line is cut at `COMPARISON_PLIES`).
    pub plies: u8,
    /// False when a compared line captured something and the side to move at its end still has
    /// a capture: the exchange is not over, so the nets may change.
    pub settled: bool,
    pub best_captures: Vec<MaterialCapture>,
    pub played_captures: Vec<MaterialCapture>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MaterialCapture {
    /// The captured piece, including its side, immediately before capture.
    pub piece: Piece,
    pub square: Square,
    pub capturer: Side,
    pub ply: u8,
}

/// A piece that can be taken after the played move, with the exchange result for the mover.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectionEvidence {
    /// The piece that moved (for `AbandonedProtection`, the piece that stopped protecting).
    pub piece: Piece,
    pub from: Square,
    pub to: Square,
    /// Square where the opponent captures.
    pub captured_at: Square,
    pub capturer: Side,
    /// The opponent piece that makes the capture.
    pub attacker: Piece,
    /// Mover's material result of the exchange on `captured_at`; negative is a loss.
    pub net: i32,
    /// For `AbandonedProtection`, the piece whose protection was released.
    pub protected_piece: Option<Piece>,
    pub protected_square: Option<Square>,
}

/// A capture that also gives check, which the played move made possible.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckCaptureEvidence {
    pub victim: Piece,
    pub victim_square: Square,
    pub attacker: Piece,
    pub attacker_from: Square,
    /// Mover's material result (the victim cannot be recaptured, so this is its value, negated).
    pub net: i32,
}

/// The moved piece became the screen ("炮架") an enemy cannon needs to capture `victim`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CannonMountEvidence {
    /// The piece the mover just moved, now standing between the cannon and the victim.
    pub screen: Piece,
    pub screen_square: Square,
    pub cannon: Piece,
    pub cannon_from: Square,
    pub victim: Piece,
    pub victim_square: Square,
    /// Mover's material result of the capture and the cheapest recapture; negative is a loss.
    pub net: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvalComponent {
    Material,
    Position,
    Mobility,
    KingSafety,
}

/// The evaluation component in which the played move is worse than the best move by the most.
/// All numbers are from the mover's point of view, after the move.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PositionEvidence {
    pub component: EvalComponent,
    pub played_value: i32,
    pub best_value: i32,
    /// Mover's legal move count before the move, and after the played move.
    pub mobility_before: u16,
    pub mobility_after: u16,
    /// Same count after the best move, so a sentence can say how many moves it would have kept.
    pub mobility_after_best: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReasonKind {
    WalkedIntoMate,
    MissedMate,
    DroppedMaterial,
    MissedMaterial,
    SentPiece,
    CannonMount,
    AbandonedProtection,
    CheckCapture,
    PositionType,
}

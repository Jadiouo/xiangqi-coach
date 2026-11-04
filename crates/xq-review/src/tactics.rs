//! Rule-based explanations for SPEC 8.4 items 5 to 9. Every function reads positions only:
//! it never searches and never changes an evaluation score.
//!
//! The exchange model is deliberately small and stated here, because it decides what the
//! reviewer is allowed to claim: a capture is judged by the first capture and the cheapest
//! legal recapture only (no longer capture chains). A claim is made only when the mover ends
//! that two-ply exchange behind.

use xq_core::{
    Game, Move, Piece, PieceKind, Position, Side, Square,
    legal_recaptures_after_hypothetical_capture, position_after_hypothetical_move,
};

use crate::material_value;
use crate::reason::{
    CannonMountEvidence, CheckCaptureEvidence, EvalComponent, PositionEvidence, ProtectionEvidence,
    Reason, ReasonKind,
};

struct Exchange {
    victim: Piece,
    attacker: Piece,
    recaptures: Vec<Move>,
    /// Mover's material result of the capture and the best-case recapture; negative is a loss.
    net: i32,
}

/// Judge `capture` (legal for `attacker_side`, even when it is not that side's turn).
fn exchange(position: &Position, attacker_side: Side, capture: Move) -> Option<Exchange> {
    let attacker = position.piece_at(capture.from)?;
    let (victim, recaptures) =
        legal_recaptures_after_hypothetical_capture(position, attacker_side, capture)?;
    let mut net = -material_value(victim.kind);
    if !recaptures.is_empty() {
        net += material_value(attacker.kind);
    }
    Some(Exchange {
        victim,
        attacker,
        recaptures,
        net,
    })
}

/// The engine's best reply to the played move, when known, must be the capture a rule claims;
/// otherwise the explanation would contradict the engine's own line. No reply: no constraint.
fn agrees(reply: Option<Move>, capture: Move) -> bool {
    reply.is_none_or(|engine| engine == capture)
}

/// Same, but only the captured square has to match (abandoned protection names the piece
/// left hanging, and the engine may take it with a different attacker).
fn agrees_on_target(reply: Option<Move>, capture: Move) -> bool {
    reply.is_none_or(|engine| engine.to == capture.to)
}

fn captures_of(position: &Position, side: Side, victim_side: Side) -> Vec<Move> {
    position
        .legal_moves_for(side)
        .into_iter()
        .filter(|movement| {
            position
                .piece_at(movement.to)
                .is_some_and(|piece| piece.side == victim_side)
        })
        .collect()
}

fn played_position(game: &Game, played: Move) -> Option<Position> {
    let mut after = game.position().clone();
    after.make_move(played).ok()?;
    Some(after)
}

/// SPEC 8.4 item 5: the moved piece can be taken and the exchange leaves the mover behind.
pub(crate) fn sent_piece(game: &Game, played: Move, reply: Option<Move>) -> Option<Reason> {
    let before = game.position();
    let mover = before.side_to_move();
    let moved = before.piece_at(played.from)?;
    let gained = before
        .piece_at(played.to)
        .map_or(0, |piece| material_value(piece.kind));
    let after = played_position(game, played)?;
    let opponent = mover.opposite();
    let worst = captures_of(&after, opponent, mover)
        .into_iter()
        .filter(|capture| capture.to == played.to)
        .filter(|capture| agrees(reply, *capture))
        .filter_map(|capture| exchange(&after, opponent, capture).map(|result| (capture, result)))
        .map(|(_, result)| (result.attacker, gained + result.net))
        .min_by_key(|(_, net)| *net)?;
    if worst.1 >= 0 {
        return None;
    }
    Some(Reason {
        protection: Some(ProtectionEvidence {
            piece: moved,
            from: played.from,
            to: played.to,
            captured_at: played.to,
            capturer: opponent,
            attacker: worst.0,
            net: worst.1,
            protected_piece: None,
            protected_square: None,
        }),
        ..Reason::bare(ReasonKind::SentPiece, 0)
    })
}

/// The pieces strictly between two squares on one file or rank (empty if they share neither).
fn pieces_between(position: &Position, from: Square, to: Square) -> Vec<Square> {
    let (df, dr) = (
        i32::from(to.file()) - i32::from(from.file()),
        i32::from(to.rank()) - i32::from(from.rank()),
    );
    if (df != 0 && dr != 0) || (df == 0 && dr == 0) {
        return Vec::new();
    }
    let (step_f, step_r) = (df.signum(), dr.signum());
    let (mut file, mut rank) = (
        i32::from(from.file()) + step_f,
        i32::from(from.rank()) + step_r,
    );
    let mut found = Vec::new();
    while (file, rank) != (i32::from(to.file()), i32::from(to.rank())) {
        if let Some(square) = Square::new(file as u8, rank as u8)
            && position.piece_at(square).is_some()
        {
            found.push(square);
        }
        file += step_f;
        rank += step_r;
    }
    found
}

/// SPEC 8.4 item 6: the moved piece stands between an enemy cannon and one of the mover's
/// pieces, so the cannon can now capture it, which it could not before the move. The capture
/// must be the engine's own reply when it is known, and must leave the mover behind.
pub(crate) fn cannon_mount(game: &Game, played: Move, reply: Option<Move>) -> Option<Reason> {
    let before = game.position();
    let mover = before.side_to_move();
    let opponent = mover.opposite();
    let screen = before.piece_at(played.from)?;
    let after = played_position(game, played)?;
    let already_possible = captures_of(before, opponent, mover);
    let worst = captures_of(&after, opponent, mover)
        .into_iter()
        .filter(|capture| {
            after
                .piece_at(capture.from)
                .is_some_and(|piece| piece.kind == PieceKind::Cannon)
        })
        // The moved piece is the one and only screen; the screen itself is not the victim.
        .filter(|capture| pieces_between(&after, capture.from, capture.to) == [played.to])
        .filter(|capture| !already_possible.contains(capture))
        .filter(|capture| agrees(reply, *capture))
        .filter_map(|capture| exchange(&after, opponent, capture).map(|result| (capture, result)))
        .filter(|(_, result)| result.net < 0)
        .min_by_key(|(_, result)| result.net)?;
    let (capture, result) = worst;
    Some(Reason {
        cannon_mount: Some(CannonMountEvidence {
            screen,
            screen_square: played.to,
            cannon: result.attacker,
            cannon_from: capture.from,
            victim: result.victim,
            victim_square: capture.to,
            net: result.net,
        }),
        ..Reason::bare(ReasonKind::CannonMount, 0)
    })
}

/// SPEC 8.4 item 7: a piece that was safe because the moved piece could take back is now
/// capturable at a loss.
pub(crate) fn abandoned_protection(
    game: &Game,
    played: Move,
    reply: Option<Move>,
) -> Option<Reason> {
    let before = game.position();
    let mover = before.side_to_move();
    let moved = before.piece_at(played.from)?;
    let after = played_position(game, played)?;
    let opponent = mover.opposite();
    let mut worst: Option<(Move, Piece, Piece, i32)> = None;
    let mut engine_choice: Option<(Move, Piece, Piece, i32)> = None;
    for capture in captures_of(before, opponent, mover) {
        if capture.to == played.from || !agrees_on_target(reply, capture) {
            continue;
        }
        let Some(was) = exchange(before, opponent, capture) else {
            continue;
        };
        let protected_by_mover = was.recaptures.iter().any(|reply| reply.from == played.from);
        if was.net < 0 || !protected_by_mover {
            continue;
        }
        let Some(now) = exchange(&after, opponent, capture) else {
            continue;
        };
        if now.net < 0 {
            let candidate = (capture, now.victim, now.attacker, now.net);
            // The capture the engine itself plays is the evidence; otherwise the worst one.
            if reply == Some(capture) {
                engine_choice = Some(candidate);
            } else if worst.is_none_or(|(_, _, _, net)| now.net < net) {
                worst = Some(candidate);
            }
        }
    }
    let (capture, protected_piece, attacker, net) = engine_choice.or(worst)?;
    Some(Reason {
        protection: Some(ProtectionEvidence {
            piece: moved,
            from: played.from,
            to: played.to,
            captured_at: capture.to,
            capturer: opponent,
            attacker,
            net,
            protected_piece: Some(protected_piece),
            protected_square: Some(capture.to),
        }),
        ..Reason::bare(ReasonKind::AbandonedProtection, 0)
    })
}

/// A capture that gives check and cannot be taken back: the check forces the reply, so the
/// victim is simply lost.
fn checking_capture(
    position: &Position,
    attacker_side: Side,
    capture: Move,
) -> Option<CheckCaptureEvidence> {
    let result = exchange(position, attacker_side, capture)?;
    if !result.recaptures.is_empty() || result.victim.side == attacker_side {
        return None;
    }
    let after = position_after_hypothetical_move(position, attacker_side, capture)?;
    if !after.is_in_check(result.victim.side) {
        return None;
    }
    Some(CheckCaptureEvidence {
        victim: result.victim,
        victim_square: capture.to,
        attacker: result.attacker,
        attacker_from: capture.from,
        net: -material_value(result.victim.kind),
    })
}

/// SPEC 8.4 item 8: after this move the opponent can give check and win a piece in the same
/// move, and could not do so before it.
pub(crate) fn check_capture(game: &Game, played: Move, reply: Option<Move>) -> Option<Reason> {
    let before = game.position();
    let mover = before.side_to_move();
    let opponent = mover.opposite();
    let after = played_position(game, played)?;
    let already_possible: Vec<Move> = captures_of(before, opponent, mover)
        .into_iter()
        .filter(|capture| checking_capture(before, opponent, *capture).is_some())
        .collect();
    let best = captures_of(&after, opponent, mover)
        .into_iter()
        .filter(|capture| !already_possible.contains(capture))
        .filter(|capture| agrees(reply, *capture))
        .filter_map(|capture| checking_capture(&after, opponent, capture))
        .filter(|evidence| evidence.victim.side == mover && evidence.net < 0)
        .min_by_key(|evidence| evidence.net)?;
    Some(Reason {
        check_capture: Some(best),
        ..Reason::bare(ReasonKind::CheckCapture, 0)
    })
}

/// The four evaluation terms from the mover's point of view, in report order.
fn components(position: &Position, mover: Side) -> [(EvalComponent, i32); 4] {
    let evaluation = xq_engine::evaluate(position);
    let sign = if position.side_to_move() == mover {
        1
    } else {
        -1
    };
    [
        (EvalComponent::Material, sign * evaluation.material),
        (EvalComponent::Mobility, sign * evaluation.mobility),
        (EvalComponent::Position, sign * evaluation.position),
        (EvalComponent::KingSafety, sign * evaluation.king_safety),
    ]
}

/// SPEC 8.4 item 9: Mobility is only named when the best move leaves at least this many more
/// legal moves than the played one. Keep equal to `MOBILITY_GAP_STEPS` in web/src/locale/zh-TW.ts.
pub const MOBILITY_GAP_STEPS: u16 = 3;

/// SPEC 8.4 item 9: nothing tactical applies, so name the evaluation term in which the played
/// move is furthest behind the best move. Reads `xq_engine::evaluate`'s breakdown only.
pub(crate) fn position_type(game: &Game, played: Move, best_move: Move) -> Option<Reason> {
    if played == best_move {
        return None;
    }
    let mover = game.position().side_to_move();
    let after_played = played_position(game, played)?;
    let after_best = played_position(game, best_move)?;
    let played_terms = components(&after_played, mover);
    let best_terms = components(&after_best, mover);
    let steps_after_played = after_played.legal_moves_for(mover).len() as u16;
    let steps_after_best = after_best.legal_moves_for(mover).len() as u16;
    let mut chosen: Option<(usize, i32)> = None;
    for index in 0..4 {
        // Too small a step difference cannot honestly be called a mobility problem.
        if played_terms[index].0 == EvalComponent::Mobility
            && (steps_after_best as i32) - (steps_after_played as i32) < MOBILITY_GAP_STEPS as i32
        {
            continue;
        }
        let deficit = best_terms[index].1 - played_terms[index].1;
        if deficit > 0 && chosen.is_none_or(|(_, top)| deficit > top) {
            chosen = Some((index, deficit));
        }
    }
    let (index, _) = chosen?;
    Some(Reason {
        position: Some(PositionEvidence {
            component: played_terms[index].0,
            played_value: played_terms[index].1,
            best_value: best_terms[index].1,
            mobility_before: game.position().legal_moves_for(mover).len() as u16,
            mobility_after: steps_after_played,
            mobility_after_best: steps_after_best,
        }),
        ..Reason::bare(ReasonKind::PositionType, 0)
    })
}

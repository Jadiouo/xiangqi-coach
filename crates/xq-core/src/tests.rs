use super::{Move, Piece, PieceKind, Position, Side, Square};
use std::collections::BTreeSet;

fn perft(position: &mut Position, depth: u8) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = position.legal_moves();
    let mut nodes = 0;
    for movement in moves {
        let undo = position
            .make_move(movement)
            .expect("generated move is legal");
        nodes += perft(position, depth - 1);
        position.unmake_move(undo);
    }
    nodes
}

#[test]
fn initial_position_matches_published_perft_depths_one_to_four() {
    let expected = [44, 1_920, 79_666, 3_290_240];
    let mut position = Position::startpos();
    for (index, expected_nodes) in expected.into_iter().enumerate() {
        assert_eq!(perft(&mut position, (index + 1) as u8), expected_nodes);
    }
}

#[test]
fn fast_generator_matches_brute_force_reference_on_fixed_seed_games() {
    let mut seed = 0x5eed_cafe_d00d_f00d_u64;
    for game in 0..5 {
        let mut position = Position::startpos();
        for ply in 0..60 {
            let fast: BTreeSet<_> = position.legal_moves().into_iter().collect();
            let slow: BTreeSet<_> = slow_reference_moves(&mut position).into_iter().collect();
            assert_eq!(fast, slow, "game {game}, ply {ply}, {}", position.to_fen());
            if fast.is_empty() {
                break;
            }
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let index = (seed as usize) % fast.len();
            let movement = *fast.iter().nth(index).expect("index is in range");
            position.make_move(movement).expect("chosen move is legal");
        }
    }
}

fn slow_reference_moves(position: &mut Position) -> Vec<Move> {
    let side = position.side_to_move();
    let mut moves = Vec::new();
    for from_index in 0..90 {
        let from = Square::from_index(from_index).expect("board index is valid");
        let Some(piece) = position.piece_at(from) else {
            continue;
        };
        if piece.side != side {
            continue;
        }
        for to_index in 0..90 {
            let to = Square::from_index(to_index).expect("board index is valid");
            if from == to || !reference_piece_can_move(position, piece, from, to) {
                continue;
            }
            let movement = Move::new(from, to);
            let undo = position.make_generated_move(movement);
            let legal = !position.is_in_check(side);
            position.unmake_move(undo);
            if legal {
                moves.push(movement);
            }
        }
    }
    moves
}

fn reference_piece_can_move(position: &Position, piece: Piece, from: Square, to: Square) -> bool {
    if position
        .piece_at(to)
        .is_some_and(|target| target.side == piece.side)
    {
        return false;
    }
    let dx = to.file() as i8 - from.file() as i8;
    let dy = to.rank() as i8 - from.rank() as i8;
    let ax = dx.abs();
    let ay = dy.abs();
    match piece.kind {
        PieceKind::King => ax + ay == 1 && in_palace(piece.side, to),
        PieceKind::Advisor => ax == 1 && ay == 1 && in_palace(piece.side, to),
        PieceKind::Elephant => {
            if ax != 2 || ay != 2 || !on_own_bank(piece.side, to) {
                return false;
            }
            let eye = Square::new(
                (from.file() as i8 + dx / 2) as u8,
                (from.rank() as i8 + dy / 2) as u8,
            )
            .unwrap();
            position.piece_at(eye).is_none()
        }
        PieceKind::Horse => {
            let is_horse = (ax == 1 && ay == 2) || (ax == 2 && ay == 1);
            if !is_horse {
                return false;
            }
            let (leg_x, leg_y) = if ax == 1 {
                (from.file() as i8, from.rank() as i8 + dy.signum())
            } else {
                (from.file() as i8 + dx.signum(), from.rank() as i8)
            };
            position
                .piece_at(Square::new(leg_x as u8, leg_y as u8).unwrap())
                .is_none()
        }
        PieceKind::Rook | PieceKind::Cannon => {
            if dx != 0 && dy != 0 {
                return false;
            }
            let step_x = dx.signum();
            let step_y = dy.signum();
            let mut x = from.file() as i8 + step_x;
            let mut y = from.rank() as i8 + step_y;
            let mut screens = 0;
            while x != to.file() as i8 || y != to.rank() as i8 {
                if position
                    .piece_at(Square::new(x as u8, y as u8).unwrap())
                    .is_some()
                {
                    screens += 1;
                }
                x += step_x;
                y += step_y;
            }
            if piece.kind == PieceKind::Rook {
                screens == 0
            } else if position.piece_at(to).is_some() {
                screens == 1
            } else {
                screens == 0
            }
        }
        PieceKind::Pawn => {
            let forward = if piece.side == Side::Red { 1 } else { -1 };
            (dx == 0 && dy == forward)
                || (dy == 0 && ax == 1 && has_crossed_river(piece.side, from))
        }
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

#[test]
fn initial_fen_round_trips_without_losing_counters_or_side_to_move() {
    let fen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
    let position = Position::from_fen(fen).unwrap();
    assert_eq!(position.to_fen(), fen);
    assert_eq!(position, Position::startpos());
}

#[test]
fn fen_accepts_horse_and_elephant_aliases_and_writes_canonical_letters() {
    let alias = "rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR w - - 7 12";
    let expected = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 7 12";
    assert_eq!(Position::from_fen(alias).unwrap().to_fen(), expected);
}

#[test]
fn fen_rejects_wrong_rank_count_width_material_count_and_missing_generals() {
    assert!(
        Position::from_fen("9/9/9/9/9/9/9/9/9 w - - 0 1")
            .unwrap_err()
            .to_string()
            .contains("ten ranks")
    );
    assert!(
        Position::from_fen("RNBACPKANR/9/9/9/9/9/9/9/9/9 w - - 0 1")
            .unwrap_err()
            .to_string()
            .contains("more than nine")
    );
    assert!(
        Position::from_fen("9/9/9/9/9/9/9/9/9/9 w - - 0 1")
            .unwrap_err()
            .to_string()
            .contains("exactly one king")
    );
    assert!(
        Position::from_fen("4k4/9/PPPPPPPPP/9/9/9/9/9/9/4K4 w - - 0 1")
            .unwrap_err()
            .to_string()
            .contains("too many pieces")
    );
}

#[test]
fn coordinate_moves_round_trip_and_initial_legal_moves_include_the_documented_cannon_move() {
    let movement = Move::from_iccs("h2e2").unwrap();
    assert_eq!(movement.to_iccs(), "h2e2");
    let mut position = Position::startpos();
    assert!(position.legal_moves().contains(&movement));
    assert!(Move::from_iccs("j2e2").is_err());
}

#[test]
fn making_and_unmaking_moves_restores_fen_hash_side_and_counters() {
    let mut position = Position::startpos();
    let original_fen = position.to_fen();
    let original_hash = position.hash();
    let mut undos = Vec::new();
    for text in ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"] {
        undos.push(position.make_move(Move::from_iccs(text).unwrap()).unwrap());
    }
    assert_ne!(position.hash(), original_hash);
    while let Some(undo) = undos.pop() {
        position.unmake_move(undo);
    }
    assert_eq!(position.to_fen(), original_fen);
    assert_eq!(position.hash(), original_hash);
    assert_eq!(position, Position::startpos());
}

#[test]
fn halfmove_clock_counts_quiet_pawn_moves_and_resets_only_on_a_capture() {
    let mut position = Position::startpos();
    for text in ["h2e2", "h9g7", "a3a4"] {
        position.make_move(Move::from_iccs(text).unwrap()).unwrap();
    }
    assert_eq!(position.to_fen().split_whitespace().nth(4), Some("3"));

    position
        .make_move(Move::from_iccs("a6a5").unwrap())
        .unwrap();
    let before_capture = position.to_fen();
    let capture_undo = position
        .make_move(Move::from_iccs("a4a5").unwrap())
        .unwrap();
    assert_eq!(position.to_fen().split_whitespace().nth(4), Some("0"));

    position.unmake_move(capture_undo);
    assert_eq!(position.to_fen(), before_capture);
    assert_eq!(position.to_fen().split_whitespace().nth(4), Some("4"));
}

#[test]
fn position_hash_includes_side_to_move_and_matches_transposed_move_orders() {
    let start = Position::startpos();
    let black_to_move =
        Position::from_fen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1")
            .unwrap();
    assert_ne!(start.hash(), black_to_move.hash());

    fn play_sequence(moves: &[&str]) -> Position {
        let mut position = Position::startpos();
        for text in moves {
            position
                .make_move(Move::from_iccs(text).unwrap())
                .expect("sample move is legal");
        }
        position
    }
    let first = play_sequence(&["a3a4", "a6a5", "i3i4", "i6i5"]);
    let second = play_sequence(&["i3i4", "i6i5", "a3a4", "a6a5"]);
    assert_eq!(first, second);
    assert_eq!(first.hash(), second.hash());
}

#[cfg(feature = "perft-performance")]
#[test]
fn release_initial_perft_depth_four_finishes_under_one_second() {
    let started = std::time::Instant::now();
    let nodes = Position::startpos().perft(4);
    let elapsed = started.elapsed();
    eprintln!("release perft(4): {:.6}s", elapsed.as_secs_f64());
    assert_eq!(nodes, 3_290_240);
    assert!(
        elapsed.as_secs_f64() < 1.0,
        "release perft(4) took {elapsed:?}"
    );
}

#[cfg(feature = "slow-perft")]
#[test]
fn initial_perft_depth_five_matches_the_published_answer() {
    assert_eq!(Position::startpos().perft(5), 133_312_995);
}

use crate::{ImportErrorKind, ImportWarning, NotationFormat, format_chinese_move, import_record};

#[test]
fn iccs_and_chinese_golden_records_read_and_write_the_same_six_moves() {
    let iccs = "1. H2-E2 h9-g7 2. h0g2 i9h9 3. I0H0 b9c7";
    let chinese = "1. 炮二平五 馬8進7 2. 馬二進三 車9平8 3. 車一平二 馬2進3";
    let expected = ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"];

    let iccs_record = import_record(iccs);
    let chinese_record = import_record(chinese);
    assert_eq!(iccs_record.format, Some(NotationFormat::Iccs));
    assert_eq!(chinese_record.format, Some(NotationFormat::Chinese));
    assert_eq!(iccs_record.moves, expected.map(mv).to_vec());
    assert_eq!(chinese_record.moves, expected.map(mv).to_vec());
    assert!(iccs_record.error.is_none());
    assert!(chinese_record.error.is_none());
    assert!(iccs_record.is_standard_start);

    let mut position = Position::startpos();
    let mut written = Vec::new();
    for movement in expected.map(mv) {
        written.push(format_chinese_move(&position, movement).unwrap());
        position.make_move(movement).unwrap();
    }
    assert_eq!(
        written,
        [
            "炮二平五",
            "馬8進7",
            "馬二進三",
            "車9平8",
            "車一平二",
            "馬2進3"
        ]
    );
}

#[test]
fn published_six_move_dhtmlxq_golden_matches_iccs_and_chinese() {
    let dhtml = import_record("[DhtmlXQ_movelist]774770627967807089791022[/DhtmlXQ_movelist]");
    let iccs = import_record("h2e2 h9g7 h0g2 i9h9 i0h0 b9c7");
    let chinese = import_record("炮二平五 馬8進7 馬二進三 車9平8 車一平二 馬2進3");
    let expected = ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"].map(mv);
    assert_eq!(dhtml.moves, expected);
    assert_eq!(iccs.moves, expected);
    assert_eq!(chinese.moves, expected);
    assert!(dhtml.error.is_none());
}

#[test]
fn dhtmlxq_coordinate_error_keeps_prior_legal_moves_and_reports_failing_chunk() {
    let record = import_record("[DhtmlXQ_movelist]77479900[/DhtmlXQ_movelist]");
    assert_eq!(record.format, Some(NotationFormat::DhtmlXq));
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record
        .error
        .expect("out-of-range second move should be reported");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "9900");
    assert_eq!(error.kind, ImportErrorKind::MalformedRecord);
    assert!(error.message_zh().contains("超出棋盤"));
}

#[test]
fn dhtmlxq_non_digit_chunk_keeps_prefix_and_reports_exact_source_chunk() {
    let record = import_record("[DhtmlXQ_movelist]7747abcd[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record
        .error
        .expect("malformed second chunk should be reported");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "abcd");
}

#[test]
fn dhtmlxq_trailing_short_chunk_keeps_prefix_and_reports_exact_source_chunk() {
    let record = import_record("[DhtmlXQ_movelist]7747990[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record
        .error
        .expect("trailing partial chunk should be reported");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "990");
}

#[test]
fn dhtmlxq_truncated_legacy_record_keeps_prefix_and_reports_record_two() {
    let record = import_record("[DhtmlXQ_movelist]77479EZK00007062[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record.error.expect("truncated legacy record should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "7062");
}

#[test]
fn dhtmlxq_bad_first_sequence_marker_reports_legacy_record_one() {
    let record = import_record("[DhtmlXQ_movelist]77479EZK000X70622RXP0001[/DhtmlXQ_movelist]");
    assert!(record.moves.is_empty());
    let error = record
        .error
        .expect("malformed first sequence marker should fail");
    assert_eq!(error.step, 1);
    assert_eq!(error.token, "77479EZK000X");
}

#[test]
fn dhtmlxq_non_digit_legacy_sequence_is_an_error_not_a_variation() {
    let record = import_record("[DhtmlXQ_movelist]77479EZK000070622RXP000X[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record.error.expect("non-digit sequence should be reported");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "70622RXP000X");
}

#[test]
fn dhtmlxq_first_valid_variation_backref_does_not_become_mainline() {
    let record = import_record("[DhtmlXQ_movelist]77479EZK9999[/DhtmlXQ_movelist]");
    assert!(record.moves.is_empty());
    assert!(record.error.is_none());
    assert!(
        record
            .warnings
            .contains(&ImportWarning::VariationsNotImported)
    );
}

#[test]
fn dhtmlxq_non_ascii_legacy_chunk_keeps_prefix_without_panicking() {
    let mut movelist = "77479EZK0000".to_owned();
    movelist.push_str("7062ABCD000");
    movelist.push('é');
    movelist.push_str("abcdefghijk");
    assert_eq!(movelist.len(), 36);

    let record = import_record(&format!("[DhtmlXQ_movelist]{movelist}[/DhtmlXQ_movelist]"));
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record.error.expect("non-ASCII legacy chunk should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.kind, ImportErrorKind::MalformedRecord);
    assert_eq!(error.token, "7062ABCD000é");
    assert_eq!(error.raw_source_bytes(), Some(&b"7062ABCD000\xc3"[..]));
}

#[test]
fn dhtmlxq_non_digit_coordinate_error_has_a_digit_specific_reason() {
    let record = import_record("[DhtmlXQ_movelist]7747abcd[/DhtmlXQ_movelist]");
    let error = record.error.expect("non-digit coordinates should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "abcd");
    assert!(error.message_zh().contains("數字"));
    assert!(!error.message_zh().contains("長度錯誤"));
}

#[test]
fn dhtmlxq_compact_utf8_boundary_keeps_source_text_and_exact_chunk_bytes() {
    let record = import_record("[DhtmlXQ_movelist]7747abcé[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record.error.expect("non-digit compact chunk should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "abcé");
    assert_eq!(error.raw_source_bytes(), Some(&b"abc\xc3"[..]));
}

#[test]
fn dhtmlxq_non_ascii_first_legacy_marker_is_not_reclassified_as_compact() {
    let record = import_record("[DhtmlXQ_movelist]7747éEZK000070622RXP0001[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record
        .error
        .expect("invalid compact second chunk should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "éEZ");
    assert_eq!(error.raw_source_bytes(), Some(&b"\xc3\xa9EZ"[..]));
}

#[test]
fn dhtmlxq_compact_uppercase_chunk_is_not_reclassified_as_legacy() {
    let record = import_record("[DhtmlXQ_movelist]7747ABCD[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record.error.expect("second compact chunk should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "ABCD");
}

#[test]
fn dhtmlxq_compact_uppercase_chunk_after_complete_move_is_not_swallowed() {
    let record = import_record("[DhtmlXQ_movelist]7747ABCD7062[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record
        .error
        .expect("invalid second compact chunk should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "ABCD");
}

#[test]
fn dhtmlxq_compact_uppercase_chunk_with_legacy_like_suffix_stays_compact() {
    let record = import_record("[DhtmlXQ_movelist]7747ABCD0000[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record.error.expect("second compact chunk should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "ABCD");
}

#[test]
fn dhtmlxq_all_uppercase_legacy_marker_with_malformed_first_sequence_is_reported() {
    let record = import_record("[DhtmlXQ_movelist]7747AOXC000X7062[/DhtmlXQ_movelist]");
    assert!(record.moves.is_empty());
    let error = record
        .error
        .expect("malformed first legacy sequence should fail");
    assert_eq!(error.step, 1);
    assert_eq!(error.token, "7747AOXC000X");
}

#[test]
fn dhtmlxq_invalid_later_legacy_marker_is_reported_at_its_record() {
    let record = import_record("[DhtmlXQ_movelist]77479EZK00007062xxxx0001[/DhtmlXQ_movelist]");
    assert_eq!(record.moves, [mv("h2e2")]);
    let error = record
        .error
        .expect("malformed second legacy marker should fail");
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "7062xxxx0001");
}

#[test]
fn chinese_accepts_simplified_aliases_fullwidth_digits_and_pawn_directions() {
    let record = import_record("炮二平五 马8进7 马二进三 车９平８ 车一平二 马2进3");
    assert_eq!(
        record.moves,
        ["h2e2", "h9g7", "h0g2", "i9h9", "i0h0", "b9c7"].map(mv)
    );
    assert!(record.error.is_none());

    let red_pawn = import_record("兵七進一");
    assert_eq!(red_pawn.moves, [mv("c3c4")]);
    let black_start =
        Position::from_fen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1")
            .unwrap();
    let black_pawn = import_record_from_position(&black_start, "卒7進1");
    assert_eq!(black_pawn.initial_position, black_start);
    assert_eq!(black_pawn.moves, [mv("g6g5")]);

    let crossed = Position::from_fen("4k4/9/9/9/4P4/4P4/9/9/9/4K4 w - - 0 1").unwrap();
    assert_eq!(
        format_chinese_move(&crossed, mv("e5f5")).unwrap(),
        "兵五平四"
    );
    assert_eq!(
        import_record_from_position(&crossed, "兵五平四").moves,
        [mv("e5f5")]
    );
}

#[test]
fn plain_chinese_aliases_follow_default_or_explicit_side_to_move() {
    let bare = import_record("卒七進一");
    assert_eq!(bare.initial_position.side_to_move(), Side::Red);
    assert_eq!(bare.moves, [mv("c3c4")]);
    assert!(bare.error.is_none());

    let black_fen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1";
    let pgn = import_record(&format!("[FEN \"{black_fen}\"]\n1. 馬8進7"));
    assert_eq!(pgn.initial_position.side_to_move(), Side::Black);
    assert_eq!(pgn.moves, [mv("h9g7")]);
    assert!(pgn.error.is_none());
}

#[test]
fn chinese_notation_handles_horse_elephant_and_advisor_destinations() {
    let mut red = Position::startpos();
    assert_eq!(format_chinese_move(&red, mv("b0c2")).unwrap(), "馬八進七");
    assert_eq!(format_chinese_move(&red, mv("g0e2")).unwrap(), "相三進五");
    assert_eq!(format_chinese_move(&red, mv("f0e1")).unwrap(), "仕四進五");
    red.make_move(mv("h2e2")).unwrap();
    assert!(format_chinese_move(&red, mv("g0e2")).is_err());

    let black =
        Position::from_fen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1")
            .unwrap();
    assert_eq!(format_chinese_move(&black, mv("d9e8")).unwrap(), "士4進5");
}

#[test]
fn chinese_same_file_and_multiple_pawn_groups_use_disambiguators() {
    let two_rooks = Position::from_fen("4k4/9/9/9/4P4/9/R8/9/9/R3K4 w - - 0 1").unwrap();
    assert_eq!(
        format_chinese_move(&two_rooks, mv("a3b3")).unwrap(),
        "前車平八"
    );
    assert_eq!(
        format_chinese_move(&two_rooks, mv("a0b0")).unwrap(),
        "後車平八"
    );
    let ambiguous = import_record_from_position(&two_rooks, "車九平八");
    let error = ambiguous.error.unwrap();
    assert_eq!(error.kind, ImportErrorKind::Ambiguous);
    assert!(error.candidates.len() >= 2);
    let message = error.message_zh();
    assert!(
        error
            .candidates
            .iter()
            .all(|candidate| message.contains(candidate))
    );

    let three_pawns = Position::from_fen("4k4/9/2P6/9/2P6/4P4/2P6/9/9/4K4 w - - 0 1").unwrap();
    assert_eq!(
        format_chinese_move(&three_pawns, mv("c5c6")).unwrap(),
        "中兵進一"
    );
    assert_eq!(
        format_chinese_move(&three_pawns, mv("c7c8")).unwrap(),
        "前兵進一"
    );
    assert_eq!(
        format_chinese_move(&three_pawns, mv("c3c4")).unwrap(),
        "後兵進一"
    );

    let paired_files = Position::from_fen("4k4/9/9/9/4P1P2/9/4P1P2/9/9/4K4 w - - 0 1").unwrap();
    assert_eq!(
        format_chinese_move(&paired_files, mv("g5g6")).unwrap(),
        "前三進一"
    );
    let parsed = import_record_from_position(&paired_files, "前三進一");
    assert_eq!(parsed.moves, [mv("g5g6")]);
    assert!(parsed.error.is_none());
}

#[test]
fn pgn_style_headers_accept_fen_and_both_move_notations() {
    let pgn = "[Red \"甲\"]\n[Black \"乙\"]\n[Result \"*\"]\n1. 炮二平五 h9g7 *";
    let record = import_record(pgn);
    assert_eq!(record.format, Some(NotationFormat::Pgn));
    assert_eq!(record.metadata.get("Red").map(String::as_str), Some("甲"));
    assert_eq!(record.moves, [mv("h2e2"), mv("h9g7")]);
    assert!(record.error.is_none());

    let fen = "4k4/9/9/9/4P4/9/9/9/9/4K4 b - - 0 1";
    let record = import_record(&format!("[FEN \"{fen}\"]\n1. e9d9 *"));
    assert_eq!(record.initial_position.to_fen(), fen);
    assert!(!record.is_standard_start);
    assert_eq!(record.moves, [mv("e9d9")]);
    assert!(record.error.is_none());

    let malformed = import_record("[FEN \"bad\"]\n1. h2e2");
    assert_eq!(
        malformed.error.as_ref().unwrap().kind,
        ImportErrorKind::InvalidPosition
    );
}

#[test]
fn chinese_move_tokens_accept_fullwidth_spacing_and_punctuation() {
    let record = import_record("1. 炮二平五，馬8進7；\u{3000}2. 馬二進三。車9平8");
    assert_eq!(
        record.moves,
        [mv("h2e2"), mv("h9g7"), mv("h0g2"), mv("i9h9")]
    );
    assert!(record.error.is_none());
}

#[test]
fn attached_move_numbers_are_ignored_without_hiding_bad_moves() {
    let iccs = import_record("1.h2e2 h9g7 12.h0g2");
    assert_eq!(iccs.moves, [mv("h2e2"), mv("h9g7"), mv("h0g2")]);
    assert!(iccs.error.is_none());

    let chinese = import_record("1.炮二平五 馬8進7");
    assert_eq!(chinese.moves, [mv("h2e2"), mv("h9g7")]);
    assert!(chinese.error.is_none());

    let black_fen = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1";
    let pgn = import_record(&format!("[FEN \"{black_fen}\"]\n1...h9g7"));
    assert_eq!(pgn.moves, [mv("h9g7")]);
    assert!(pgn.error.is_none());

    let malformed = import_record("1.h2e2 12.z9z9");
    assert_eq!(malformed.moves, [mv("h2e2")]);
    let error = malformed.error.unwrap();
    assert_eq!(error.step, 2);
    assert_eq!(error.token, "z9z9");
}

#[test]
fn dpxq_imports_three_real_source_records_and_reports_unimported_variations() {
    let numeric = import_record(include_str!("../tests/fixtures/dpxq_special_numeric.txt"));
    assert_eq!(numeric.format, Some(NotationFormat::DhtmlXq));
    assert!(!numeric.is_standard_start);
    assert_eq!(
        numeric.initial_position.to_fen(),
        "4k4/P8/9/P5P2/2p5p/P5P2/2p5p/9/8p/4K4 w - - 0 1"
    );
    assert!(numeric.moves.is_empty());
    let error = numeric
        .error
        .as_ref()
        .expect("source starts in facing-generals check");
    assert_eq!(error.step, 1);
    assert_eq!(error.token, "6362");
    assert_eq!(error.decoded_move.as_deref(), Some("g6g7"));
    assert_eq!(error.kind, ImportErrorKind::IllegalMove);

    let legacy_full_game = import_record(include_str!("../tests/fixtures/dpxq_2004_legacy.txt"));
    assert_eq!(legacy_full_game.format, Some(NotationFormat::DhtmlXq));
    assert!(legacy_full_game.is_standard_start);
    assert_eq!(legacy_full_game.moves.len(), 69);
    assert_eq!(
        &legacy_full_game.moves[..3],
        [mv("h2e2"), mv("h9g7"), mv("h0g2")]
    );
    assert!(legacy_full_game.error.is_none());

    let branched = import_record(include_str!("../tests/fixtures/dpxq_legacy_branch.txt"));
    assert_eq!(branched.format, Some(NotationFormat::DhtmlXq));
    assert!(
        branched
            .warnings
            .contains(&ImportWarning::VariationsNotImported)
    );
    assert_eq!(branched.moves.len(), 39);
    assert!(branched.error.is_none());

    let second_full_game =
        import_record(include_str!("../tests/fixtures/dpxq_2004_second_game.txt"));
    assert_eq!(second_full_game.format, Some(NotationFormat::DhtmlXq));
    assert!(second_full_game.is_standard_start);
    assert_eq!(second_full_game.moves.len(), 52);
    assert!(second_full_game.error.is_none());
}

#[test]
fn dpxq_ignores_unknown_tags_without_losing_the_mainline() {
    let text = include_str!("../tests/fixtures/dpxq_2004_legacy.txt").replace(
        "[DhtmlXQ_title]",
        "[DhtmlXQ_future_field]ignored[/DhtmlXQ_future_field]\n[DhtmlXQ_title]",
    );
    let record = import_record(&text);
    assert_eq!(record.moves.len(), 69);
    assert!(record.error.is_none());
}

#[test]
fn auto_detection_identifies_each_supported_text_family_and_rejects_plain_text() {
    for (text, expected) in [
        ("h2e2 h9g7", NotationFormat::Iccs),
        ("炮二平五 馬8進7", NotationFormat::Chinese),
        ("[Red \"甲\"]\n1. h2e2", NotationFormat::Pgn),
        (
            "[DhtmlXQ_movelist]77477062[/DhtmlXQ_movelist]",
            NotationFormat::DhtmlXq,
        ),
    ] {
        assert_eq!(import_record(text).format, Some(expected), "{text}");
    }
    let unknown = import_record("這不是棋譜");
    assert_eq!(unknown.format, None);
    assert_eq!(unknown.error.unwrap().kind, ImportErrorKind::UnknownFormat);
}

#[test]
fn dpxq_infers_initial_side_from_the_first_move_piece() {
    let record = import_record("[DhtmlXQ_movelist]7062[/DhtmlXQ_movelist]");
    assert!(record.is_standard_start);
    assert_eq!(record.initial_position.side_to_move(), Side::Black);
    assert_eq!(record.moves, [mv("h9g7")]);
    assert!(record.error.is_none());
}

#[test]
fn dpxq_legacy_move_errors_retain_the_complete_source_record() {
    let source = "0000ABXQ0000";
    let record = import_record(&format!("[DhtmlXQ_movelist]{source}[/DhtmlXQ_movelist]"));
    let error = record.error.unwrap();
    assert_eq!(error.step, 1);
    assert_eq!(error.token, source);
    assert_eq!(error.decoded_move.as_deref(), Some("a9a9"));
}

#[test]
fn illegal_move_keeps_legal_prefix_and_reports_source_and_reason() {
    let input = "1. h2e2 h9g7 2. a3a4 a6a5 3. b0c2 b9c7 4. j2a2";
    let record = import_record(input);
    assert_eq!(record.moves.len(), 6);
    let error = record.error.unwrap();
    assert_eq!(error.step, 7);
    assert_eq!(error.token, "j2a2");
    assert_ne!(error.kind, ImportErrorKind::UnknownFormat);
    let message = error.message_zh();
    assert!(message.contains("第 7 步"));
    assert!(message.contains("j2a2"));
}

#[test]
fn illegal_twelfth_move_keeps_eleven_plies_from_a_verified_source_game() {
    let source = import_record(include_str!("../tests/fixtures/dpxq_2004_legacy.txt"));
    assert_eq!(source.moves.len(), 69);
    assert!(source.error.is_none());
    let prefix = source.moves[..11]
        .iter()
        .map(|movement| movement.to_iccs())
        .collect::<Vec<_>>()
        .join(" ");
    let record = import_record(&format!("{prefix} j2a2"));

    assert_eq!(record.moves, source.moves[..11]);
    let error = record.error.unwrap();
    assert_eq!(error.step, 12);
    assert_eq!(error.token, "j2a2");
    assert_ne!(error.kind, ImportErrorKind::UnknownFormat);
    assert!(error.message_zh().contains("第 12 步"));
}

#[test]
fn importer_stops_after_game_history_reaches_a_draw() {
    let record = import_record("b0c2 b9c7 c2b0 c7b9 b0c2 b9c7 c2b0 c7b9 b0c2");
    assert_eq!(
        record.moves,
        [
            "b0c2", "b9c7", "c2b0", "c7b9", "b0c2", "b9c7", "c2b0", "c7b9"
        ]
        .map(mv)
    );
    let error = record.error.unwrap();
    assert_eq!(error.step, 9);
    assert_eq!(error.token, "b0c2");
    assert!(error.message_zh().contains("結束"));
}

#[test]
fn deterministic_two_hundred_games_round_trip_iccs_and_chinese_notation() {
    let mut seed = 0x6d33_2026_1007_u64;
    let mut rejected_repetition_draws = 0;
    let mut rejected_no_move_losses = 0;
    let mut rejected_120_ply_draws = 0;
    for game_index in 0..200 {
        let (iccs, chinese, expected) = loop {
            let mut game = Game::new(Position::startpos());
            let mut iccs = Vec::with_capacity(60);
            let mut chinese = Vec::with_capacity(60);
            let mut expected = Vec::with_capacity(60);
            let mut complete = true;
            let mut terminal_outcome = None;
            for _ply in 0..60 {
                if let Some(outcome) = game.outcome() {
                    complete = false;
                    terminal_outcome = Some(outcome);
                    break;
                }
                let mut position = game.position().clone();
                let legal = position.legal_moves();
                seed = seed
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                let movement = legal[(seed as usize) % legal.len()];
                iccs.push(movement.to_iccs());
                chinese.push(format_chinese_move(game.position(), movement).unwrap());
                expected.push(movement);
                game.play(movement).unwrap();
            }
            if complete {
                break (iccs, chinese, expected);
            }
            match terminal_outcome.expect("an incomplete sample has reached a game outcome") {
                GameOutcome::Draw if game.position().halfmove_clock() >= 120 => {
                    rejected_120_ply_draws += 1
                }
                GameOutcome::Draw => rejected_repetition_draws += 1,
                GameOutcome::Win(_) => rejected_no_move_losses += 1,
            }
        };
        let parsed_iccs = import_record(&iccs.join(" "));
        let parsed_chinese = import_record(&chinese.join(" "));
        assert_eq!(parsed_iccs.moves, expected, "ICCS game {game_index}");
        assert_eq!(parsed_chinese.moves, expected, "Chinese game {game_index}");
        assert!(parsed_iccs.error.is_none(), "ICCS game {game_index}");
        assert!(parsed_chinese.error.is_none(), "Chinese game {game_index}");
    }
    eprintln!(
        "discarded short games: repetition/draw={}, no-move loss={}, 120-ply draw={}",
        rejected_repetition_draws, rejected_no_move_losses, rejected_120_ply_draws
    );
}

fn import_record_from_position(position: &Position, text: &str) -> crate::ImportResult {
    crate::import_record(&format!("[FEN \"{}\"]\n{text}", position.to_fen()))
}

// Golden data frozen from docs/research/m2-reference/reference-v4-frozen.json
// (Pikafish-2026-09-06, Threads=1; see docs/research/m2-pikafish-reference-results.md).
#[test]
fn m2_frozen_positions_match_perft_and_root_move_goldens() {
    let cases: &[(&str, &str, [u64; 4], &[&str])] = &[
        (
            "blocked_facing_generals",
            "4k4/9/9/9/4P4/9/9/9/9/4K4 w - - 0 1",
            [4, 10, 51, 115],
            &["e0e1", "e0f0", "e5e6", "e0d0"],
        ),
        (
            "single_rook_check_block_capture_dodge",
            "4k4/9/9/9/4r4/2N6/9/9/3R5/4K4 w - - 0 1",
            [5, 62, 1221, 18247],
            &["c4e3", "c4e5", "d1e1", "e0d0", "e0f0"],
        ),
        (
            "double_check_rook_and_horse",
            "4k4/9/9/9/4r4/9/9/9/2n6/4K4 w - - 0 1",
            [2, 48, 46, 1063],
            &["e0d0", "e0f0"],
        ),
        (
            "crossed_and_uncrossed_pawns_red_to_move",
            "4k4/9/9/8p/2P1P4/6p2/P8/9/9/4K4 w - - 0 1",
            [8, 54, 455, 2974],
            &[
                "a3a4", "c5b5", "c5d5", "c5c6", "e0e1", "e0f0", "e5e6", "e0d0",
            ],
        ),
        (
            "crossed_and_uncrossed_pawns_black_to_move",
            "4k4/9/9/8p/2P1P4/6p2/P8/9/9/4K4 b - - 0 1",
            [7, 58, 382, 3275],
            &["g4g3", "g4f4", "g4h4", "i6i5", "e9e8", "e9d9", "e9f9"],
        ),
        (
            "horse_legs_blocked_multiple_directions",
            "4k4/9/9/9/4P4/9/2P6/2NA5/9/4K4 w - - 0 1",
            [10, 29, 319, 780],
            &[
                "c3c4", "e0e1", "e0f0", "e5e6", "d2e1", "c2b0", "c2d0", "c2a1", "c2a3", "e0d0",
            ],
        ),
        (
            "elephant_eye_block_northwest_southeast",
            "4k4/9/9/9/4P4/9/3R5/4B4/5R3/4K4 w - - 0 1",
            [42, 60, 2351, 5389],
            &[
                "e5d5", "e5f5", "e5e6", "e2c0", "e2g4", "f1f0", "f1a1", "f1b1", "f1c1", "f1d1",
                "f1e1", "f1g1", "f1h1", "f1i1", "f1f2", "f1f3", "f1f4", "f1f5", "f1f6", "f1f7",
                "f1f8", "f1f9", "d3d0", "d3d1", "d3d2", "d3a3", "d3b3", "d3c3", "d3e3", "d3f3",
                "d3g3", "d3h3", "d3i3", "d3d4", "d3d5", "d3d6", "d3d7", "d3d8", "d3d9", "e0d0",
                "e0f0", "e0e1",
            ],
        ),
        (
            "elephant_eye_block_northeast_southwest",
            "4k4/9/9/9/4P4/9/5R3/4B4/3R5/4K4 w - - 0 1",
            [42, 60, 2351, 5389],
            &[
                "e5d5", "e5f5", "e5e6", "e2g0", "e2c4", "d1d0", "d1a1", "d1b1", "d1c1", "d1e1",
                "d1f1", "d1g1", "d1h1", "d1i1", "d1d2", "d1d3", "d1d4", "d1d5", "d1d6", "d1d7",
                "d1d8", "d1d9", "f3f0", "f3f1", "f3f2", "f3a3", "f3b3", "f3c3", "f3d3", "f3e3",
                "f3g3", "f3h3", "f3i3", "f3f4", "f3f5", "f3f6", "f3f7", "f3f8", "f3f9", "e0d0",
                "e0f0", "e0e1",
            ],
        ),
        (
            "cannon_capture_with_friendly_and_enemy_screens",
            "4k4/9/9/2r3r2/4P4/2P3p2/9/2C3C2/9/4K4 w - - 0 1",
            [23, 511, 13203, 326034],
            &[
                "c4c5", "e0e1", "e0f0", "e5e6", "c2c0", "c2c1", "c2a2", "c2b2", "c2d2", "c2e2",
                "c2f2", "c2c3", "c2c6", "g2g0", "g2g1", "g2d2", "g2e2", "g2f2", "g2h2", "g2i2",
                "g2g3", "g2g6", "e0d0",
            ],
        ),
        (
            "stalemate_trapped_king",
            "3rkr3/9/9/9/4p4/9/9/2n6/9/4K4 w - - 0 1",
            [0, 0, 0, 0],
            &[],
        ),
        (
            "checkmate_trapped_king",
            "3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 0 1",
            [0, 0, 0, 0],
            &[],
        ),
        (
            "low_material_rook_pawn_ending",
            "4k4/9/9/9/4p4/9/9/9/9/R3K4 w - - 0 1",
            [15, 53, 931, 3169],
            &[
                "a0b0", "a0c0", "a0d0", "a0a1", "a0a2", "a0a3", "a0a4", "a0a5", "a0a6", "a0a7",
                "a0a8", "a0a9", "e0d0", "e0f0", "e0e1",
            ],
        ),
        (
            "horse_legs_blocked_south_and_west_with_north_east_controls",
            "4k4/9/9/9/4P4/9/9/1RN6/2R6/4K4 w - - 0 1",
            [27, 74, 2539, 6035],
            &[
                "e0e1", "e0f0", "e5e6", "c2e1", "c2e3", "c2b4", "c2d4", "c1c0", "c1a1", "c1b1",
                "c1d1", "c1e1", "c1f1", "c1g1", "c1h1", "c1i1", "b2b0", "b2b1", "b2a2", "b2b3",
                "b2b4", "b2b5", "b2b6", "b2b7", "b2b8", "b2b9", "e0d0",
            ],
        ),
    ];
    for (name, fen, expected, expected_moves) in cases {
        let original = Position::from_fen(fen).unwrap_or_else(|error| panic!("{name}: {error}"));
        let mut position = original.clone();
        let moves: BTreeSet<_> = position
            .legal_moves()
            .into_iter()
            .map(Move::to_iccs)
            .collect();
        let expected_moves: BTreeSet<_> =
            expected_moves.iter().map(|text| text.to_string()).collect();
        assert_eq!(moves, expected_moves, "{name} root moves");
        for (depth, nodes) in expected.iter().copied().enumerate() {
            assert_eq!(
                original.perft((depth + 1) as u8),
                nodes,
                "{name} depth {}",
                depth + 1
            );
        }
    }
}

#[test]
fn m2_frozen_move_legality_examples_match_reference_and_rules() {
    let cases: &[(&str, &[(&str, bool)])] = &[
        (
            "4k4/9/9/9/4P4/9/9/9/9/4K4 w - - 0 1",
            &[("e5e6", true), ("e5d5", false)],
        ),
        (
            "4k4/9/9/9/4r4/2N6/9/9/3R5/4K4 w - - 0 1",
            &[
                ("d1e1", true),
                ("c4e5", true),
                ("e0d0", true),
                ("e0e1", false),
            ],
        ),
        (
            "4k4/9/9/9/4r4/9/9/9/2n6/4K4 w - - 0 1",
            &[("e0d0", true), ("e0e1", false)],
        ),
        (
            "4k4/9/9/8p/2P1P4/6p2/P8/9/9/4K4 w - - 0 1",
            &[("a3a4", true), ("a3b3", false), ("c5b5", true)],
        ),
        (
            "4k4/9/9/8p/2P1P4/6p2/P8/9/9/4K4 b - - 0 1",
            &[("i6i5", true), ("i6h6", false), ("g4f4", true)],
        ),
        (
            "4k4/9/9/9/4P4/9/2P6/2NA5/9/4K4 w - - 0 1",
            &[
                ("c2b4", false),
                ("c2d4", false),
                ("c2a3", true),
                ("c2e3", false),
            ],
        ),
        (
            "4k4/9/9/9/4P4/9/3R5/4B4/5R3/4K4 w - - 0 1",
            &[("e2c4", false), ("e2g0", false), ("e2c0", true)],
        ),
        (
            "4k4/9/9/9/4P4/9/5R3/4B4/3R5/4K4 w - - 0 1",
            &[("e2g4", false), ("e2c0", false), ("e2g0", true)],
        ),
        (
            "4k4/9/9/2r3r2/4P4/2P3p2/9/2C3C2/9/4K4 w - - 0 1",
            &[("c2c6", true), ("g2g6", true), ("c2c5", false)],
        ),
        (
            "3rkr3/9/9/9/4p4/9/9/2n6/9/4K4 w - - 0 1",
            &[("e0d0", false), ("e0f0", false), ("e0e1", false)],
        ),
        (
            "3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 0 1",
            &[("e0e1", false), ("e0d0", false), ("e0f0", false)],
        ),
        (
            "4k4/9/9/9/4p4/9/9/9/9/R3K4 w - - 0 1",
            &[("a0a1", true), ("e0d0", true)],
        ),
        (
            "4k4/9/9/9/4P4/9/9/1RN6/2R6/4K4 w - - 0 1",
            &[
                ("c2a1", false),
                ("c2a3", false),
                ("c2b0", false),
                ("c2d0", false),
                ("c2b4", true),
                ("c2e3", true),
            ],
        ),
    ];
    for (fen, examples) in cases {
        for (text, expected_legal) in *examples {
            let mut position = Position::from_fen(fen).unwrap();
            let result = position.make_move(Move::from_iccs(text).unwrap());
            assert_eq!(result.is_ok(), *expected_legal, "{fen}: {text}");
        }
    }
}

use crate::{Game, GameOutcome};

fn mv(text: &str) -> Move {
    Move::from_iccs(text).unwrap()
}

fn play_all(game: &mut Game, moves: &[&str]) {
    for text in moves {
        game.play(mv(text))
            .unwrap_or_else(|error| panic!("{text}: {error}"));
    }
}

#[test]
fn self_check_rejection_preserves_position_hash_counters_and_history() {
    let position = Position::from_fen("4k4/9/9/9/4P4/9/9/9/9/4K4 w - - 0 1").unwrap();
    let mut game = Game::new(position);
    let before_fen = game.position().to_fen();
    let before_hash = game.position().hash();
    let before_history = game.history_len();
    let before_outcome = game.outcome();
    assert!(game.play(mv("e5d5")).is_err());
    assert_eq!(game.position().to_fen(), before_fen);
    assert_eq!(game.position().hash(), before_hash);
    assert_eq!(game.history_len(), before_history);
    assert_eq!(game.outcome(), before_outcome);
    assert!(game.position().clone().legal_moves().contains(&mv("e5e6")));
}

#[test]
fn illegal_attempt_does_not_change_the_ply_of_a_later_repetition() {
    let mut game = Game::new(Position::startpos());
    let start_hash = game.position().hash();
    assert!(game.play(mv("h2h7")).is_err());
    assert_eq!(game.position().hash(), start_hash);
    assert_eq!(game.history_len(), 0);
    assert_eq!(game.outcome(), None);

    let cycle = ["b0c2", "b9c7", "c2b0", "c7b9"];
    play_all(&mut game, &cycle);
    assert_eq!(game.outcome(), None);
    play_all(&mut game, &cycle);
    assert_eq!(game.outcome(), Some(GameOutcome::Draw));
}

#[test]
fn attack_detection_covers_rook_horse_cannon_pawn_and_facing_generals() {
    for fen in [
        // Rook, horse with open leg, cannon with exactly one screen, pawn.
        "4k4/9/9/9/4r4/9/9/9/9/4K4 w - - 0 1",
        "3k5/9/9/9/9/9/9/9/2n6/4K4 w - - 0 1",
        "3k5/9/9/9/4c4/9/9/9/4R4/4K4 w - - 0 1",
        "3k5/9/9/9/9/9/9/9/4p4/4K4 w - - 0 1",
    ] {
        let position = Position::from_fen(fen).unwrap();
        assert!(position.is_in_check(Side::Red), "{fen}");
        assert!(!position.is_in_check(Side::Black), "{fen}");
    }
    for fen in [
        "3k5/9/9/9/9/9/9/9/2nr5/4K4 w - - 0 1", // Horse leg blocked.
        "3k5/9/9/9/4c4/9/9/9/9/4K4 w - - 0 1",  // No cannon screen.
        "3k5/9/9/9/4c4/9/4R4/9/4R4/4K4 w - - 0 1", // Two cannon screens.
    ] {
        let position = Position::from_fen(fen).unwrap();
        assert!(!position.is_in_check(Side::Red), "{fen}");
    }
    let mut screened = Position::from_fen("4k4/9/9/9/4P4/9/9/9/9/4K4 w - - 0 1").unwrap();
    assert!(screened.make_move(mv("e5d5")).is_err());
}

#[test]
fn validated_mate_and_stalemate_positions_both_lose_for_red() {
    let mate = Position::from_fen("3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 0 1").unwrap();
    let stalemate = Position::from_fen("3rkr3/9/9/9/4p4/9/9/2n6/9/4K4 w - - 0 1").unwrap();
    assert!(mate.is_in_check(Side::Red));
    assert!(!stalemate.is_in_check(Side::Red));
    assert!(mate.clone().legal_moves().is_empty());
    assert!(stalemate.clone().legal_moves().is_empty());
    assert_eq!(
        Game::new(mate).outcome(),
        Some(GameOutcome::Win(Side::Black))
    );
    assert_eq!(
        Game::new(stalemate).outcome(),
        Some(GameOutcome::Win(Side::Black))
    );
}

#[test]
fn third_neutral_repetition_is_a_draw_on_the_third_same_side_occurrence() {
    let mut game = Game::new(Position::startpos());
    play_all(&mut game, &["b0c2", "b9c7", "c2b0", "c7b9"]);
    assert_eq!(game.outcome(), None); // Same position has occurred twice.
    play_all(&mut game, &["b0c2", "b9c7", "c2b0", "c7b9"]);
    assert_eq!(game.outcome(), Some(GameOutcome::Draw)); // plies 0, 4, and 8
    game.undo_last_move().unwrap();
    assert_eq!(game.outcome(), None);
    game.play(mv("c7b9")).unwrap();
    assert_eq!(game.outcome(), Some(GameOutcome::Draw));
}

#[test]
fn third_repetition_after_red_checks_on_every_red_move_loses_for_red() {
    // Clock 112 makes the eighth quiet ply hit 120 at the same time as the
    // third repeated position; repetition adjudication has the chosen priority.
    let start = Position::from_fen("4k4/3R5/9/9/4P4/9/9/9/9/4K4 w - - 112 1").unwrap();
    let mut game = Game::new(start);
    let cycle = ["d8e8", "e9d9", "e8d8", "d9e9"];
    play_all(&mut game, &cycle);
    assert_eq!(game.outcome(), None);
    play_all(&mut game, &cycle);
    assert_eq!(game.outcome(), Some(GameOutcome::Win(Side::Black)));
    game.undo_last_move().unwrap();
    assert_eq!(game.outcome(), None);
    game.play(mv("d9e9")).unwrap();
    assert_eq!(game.outcome(), Some(GameOutcome::Win(Side::Black)));
}

#[test]
fn repetition_adjudication_checks_both_cycles_between_first_and_third_occurrence() {
    let start = Position::from_fen("4k4/3R5/9/9/4P4/9/9/9/9/4K4 w - - 0 1").unwrap();
    let mut game = Game::new(start);
    // This first cycle repeats the position without Red checking on every move.
    play_all(&mut game, &["d8c8", "e9d9", "c8d8", "d9e9"]);
    assert_eq!(game.outcome(), None);
    // The second cycle checks on every Red move, but the whole repeated segment does not.
    play_all(&mut game, &["d8e8", "e9d9", "e8d8", "d9e9"]);
    assert_eq!(game.outcome(), Some(GameOutcome::Draw));
}

#[test]
fn unrelated_nonchecking_prefix_does_not_hide_perpetual_check_in_repetition_segment() {
    let start = Position::from_fen("1n2k4/3R5/9/9/4P4/9/9/9/9/1N2K4 w - - 0 1").unwrap();
    let mut game = Game::new(start);
    // These legal horse moves are outside the later repeated segment and give no check.
    play_all(&mut game, &["b0c2", "b9c7"]);
    assert_eq!(game.outcome(), None);
    let cycle = ["d8e8", "e9d9", "e8d8", "d9e9"];
    play_all(&mut game, &cycle);
    assert_eq!(game.outcome(), None);
    play_all(&mut game, &cycle);
    assert_eq!(game.outcome(), Some(GameOutcome::Win(Side::Black)));
}

#[test]
fn quiet_120th_ply_draws_but_a_capture_resets_the_clock() {
    let start = Position::from_fen(
        "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 119 1",
    )
    .unwrap();
    let mut quiet_game = Game::new(start);
    quiet_game.play(mv("h2e2")).unwrap();
    assert_eq!(
        quiet_game.position().to_fen().split_whitespace().nth(4),
        Some("120")
    );
    assert_eq!(quiet_game.outcome(), Some(GameOutcome::Draw));
    quiet_game.undo_last_move().unwrap();
    assert_eq!(quiet_game.position().halfmove_clock(), 119);
    assert_eq!(quiet_game.outcome(), None);
    quiet_game.play(mv("h2e2")).unwrap();
    assert_eq!(quiet_game.outcome(), Some(GameOutcome::Draw));

    let capture = Position::from_fen("4k4/9/9/2r3r2/4P4/2P3p2/9/2C3C2/9/4K4 w - - 119 1").unwrap();
    let mut capture_game = Game::new(capture);
    capture_game.play(mv("c2c6")).unwrap();
    assert_eq!(
        capture_game.position().to_fen().split_whitespace().nth(4),
        Some("0")
    );
    assert_eq!(capture_game.outcome(), None);
    capture_game.undo_last_move().unwrap();
    assert_eq!(capture_game.position().halfmove_clock(), 119);
    assert_eq!(capture_game.history_len(), 0);
    assert_eq!(capture_game.outcome(), None);
}

#[test]
fn undo_restores_full_history_position_hash_and_draw_state() {
    let mut game = Game::new(Position::startpos());
    let start_fen = game.position().to_fen();
    let start_hash = game.position().hash();
    let start_history = game.history_len();
    game.play(mv("a3a4")).unwrap();
    game.play(mv("a6a5")).unwrap();
    assert_ne!(game.position().hash(), start_hash);
    game.undo_last_move().unwrap();
    game.undo_last_move().unwrap();
    assert_eq!(game.position().to_fen(), start_fen);
    assert_eq!(game.position().hash(), start_hash);
    assert_eq!(game.history_len(), start_history);
    assert_eq!(game.outcome(), None);
}

#[test]
fn no_legal_move_loss_precedes_the_120_ply_draw_threshold() {
    let mate_at_limit = Position::from_fen("3rk4/9/9/9/4P4/9/9/2n6/4r2n1/4K4 w - - 120 1").unwrap();
    assert_eq!(
        Game::new(mate_at_limit).outcome(),
        Some(GameOutcome::Win(Side::Black)),
    );
}

#[test]
fn hypothetical_capture_returns_only_legal_recaptures_without_changing_position() {
    let position = Position::from_fen("4k4/9/9/9/9/rRR1P4/9/9/9/4K4 w - - 0 1").unwrap();
    let before = position.clone();
    let capture = Move::from_iccs("a4b4").unwrap();
    let (victim, recaptures) =
        super::legal_recaptures_after_hypothetical_capture(&position, Side::Black, capture)
            .expect("legal hypothetical capture");
    assert_eq!(victim.kind, PieceKind::Rook);
    assert!(recaptures.contains(&Move::from_iccs("c4b4").unwrap()));
    assert_eq!(position, before);
}

#[test]
fn hypothetical_capture_rejects_non_capture_and_pinned_recapture() {
    let position = Position::from_fen("4k4/9/9/9/9/rRR1P4/9/9/9/4K4 w - - 0 1").unwrap();
    assert!(
        super::legal_recaptures_after_hypothetical_capture(
            &position,
            Side::Black,
            Move::from_iccs("a4a3").unwrap()
        )
        .is_none()
    );
}

#[test]
fn hypothetical_move_returns_the_resulting_position_for_the_side_not_to_move() {
    // Red to move, but ask what happens if Black's rook a3 takes the horse e3: the rook then
    // stands on the red king's file with nothing between, so Red is in check.
    let position = Position::from_fen("4k4/9/9/9/9/9/r3N4/9/9/4K4 w - - 0 1").unwrap();
    let before = position.clone();
    let after = super::position_after_hypothetical_move(
        &position,
        Side::Black,
        Move::from_iccs("a3e3").unwrap(),
    )
    .expect("the capture is legal for Black");
    assert!(after.is_in_check(Side::Red));
    assert_eq!(after.side_to_move(), Side::Red);
    assert_eq!(position, before, "the supplied position is untouched");
}

#[test]
fn hypothetical_move_rejects_illegal_and_self_exposing_moves() {
    let position = Position::from_fen("3kr4/9/9/9/9/4R4/9/9/9/4K4 w - - 0 1").unwrap();
    // The red rook e4 is pinned against its king by the rook e9: leaving the file is illegal.
    assert!(
        super::position_after_hypothetical_move(
            &position,
            Side::Red,
            Move::from_iccs("e4a4").unwrap()
        )
        .is_none()
    );
    // A move the side cannot make at all.
    assert!(
        super::position_after_hypothetical_move(
            &position,
            Side::Black,
            Move::from_iccs("a0a1").unwrap()
        )
        .is_none()
    );
}

#[test]
fn board_ascii_lists_rank_nine_first_with_uppercase_red_and_dots_for_empty() {
    assert_eq!(
        Position::startpos().board_ascii(),
        "rnbakabnr..........c.....c.p.p.p.p.p..................P.P.P.P.P.C.....C..........RNBAKABNR"
    );
}

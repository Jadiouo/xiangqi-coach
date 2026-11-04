import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from difficulty_match import (
    DifficultyMatchError,
    MAX_PLY,
    WORKERS,
    _opening_set_digest,
    aggregate_pair,
    audit_batch,
    BASELINE_OPTIONS,
    derive_game_seed,
    derive_move_seed,
    schedule_pair,
    validate_opening_count,
    apply_run_kind_gate,
    audit_run_directory,
    validate_pair_levels,
)


OPENINGS = [
    {"id": "tiny-start", "source": "synthetic-source", "moves": []},
    {"id": "tiny-start-2", "source": "synthetic-source-2", "moves": []},
]
DRAW_CYCLE = ["h0g2", "h9g7", "g2h0", "g7h9"] * 2


class PairProtocolTests(unittest.TestCase):
    def test_provisional_pilot_profile_uses_adopted_killer_history_flag(self):
        self.assertEqual(BASELINE_OPTIONS["RootAlpha"], "true")
        self.assertEqual(BASELINE_OPTIONS["CheckExtensions"], "true")
        self.assertEqual(BASELINE_OPTIONS["KillerHistoryOrdering"], "true")

    def test_pilot_accepts_fixed_subsets_but_never_passes_formal_gate(self):
        self.assertEqual(validate_opening_count(3, "pilot"), 3)
        self.assertEqual(validate_opening_count(50, "pilot"), 50)
        self.assertEqual(validate_opening_count(50, "final"), 50)
        with self.assertRaises(DifficultyMatchError):
            validate_opening_count(3, "final")
        with self.assertRaises(DifficultyMatchError):
            validate_opening_count(0, "pilot")
        pilot = apply_run_kind_gate({"formal_gate_eligible": True, "passed": True}, "pilot")
        self.assertFalse(pilot["formal_gate_eligible"])
        self.assertFalse(pilot["passed"])
        self.assertEqual(pilot["run_kind"], "pilot")

    def test_pair_schedule_contains_each_opening_with_high_side_both_colors(self):
        schedule = schedule_pair(OPENINGS, lower_level=1, master_seed=5)
        self.assertEqual(len(schedule), 4)
        self.assertEqual({row["opening_id"] for row in schedule}, {row["id"] for row in OPENINGS})
        self.assertEqual({row["high_is_red"] for row in schedule}, {True, False})
        self.assertTrue(all(row["high_level"] == 3 and row["low_level"] == 1 for row in schedule))
        self.assertEqual(len({row["game_id"] for row in schedule}), 4)

    def test_pilot_rows_cannot_be_relabelled_as_final(self):
        openings = [{"id": f"opening-{index:02d}", "source": "frozen-tuning-set", "moves": []}
                    for index in range(50)]
        games = schedule_pair(openings, lower_level=1, master_seed=9, run_kind="pilot")
        for row in games:
            row.update(run_kind="final", result_for_high="win")
        summary = aggregate_pair(games, openings, lower_level=1)
        self.assertFalse(summary["complete"])
        self.assertFalse(summary["formal_gate_eligible"])
        self.assertTrue(any(error.startswith("unexpected_game:") for error in summary["errors"]))

    def test_game_and_per_ply_seeds_are_deterministic_and_side_specific(self):
        high = derive_game_seed(42, "g-1", "A")
        low = derive_game_seed(42, "g-1", "B")
        self.assertEqual(high, derive_game_seed(42, "g-1", "A"))
        self.assertNotEqual(high, low)
        self.assertEqual(derive_move_seed(high, 7), derive_move_seed(high, 7))
        self.assertNotEqual(derive_move_seed(high, 7), derive_move_seed(high, 8))

    def test_run_kind_is_part_of_game_and_random_seed_identity(self):
        pilot = schedule_pair(OPENINGS[:1], lower_level=1, master_seed=5, run_kind="pilot")[0]
        final_openings = [dict(OPENINGS[0])] + [
            dict(OPENINGS[1], id=f"opening-{index}") for index in range(49)
        ]
        final = next(row for row in schedule_pair(
            final_openings, lower_level=1, master_seed=5, run_kind="final"
        ) if row["opening_id"] == OPENINGS[0]["id"] and row["high_is_red"])
        self.assertNotEqual(pilot["game_id"], final["game_id"])
        self.assertNotEqual(pilot["game_seed_high"], final["game_seed_high"])
        self.assertNotEqual(
            derive_move_seed(pilot["game_seed_high"], 12),
            derive_move_seed(final["game_seed_high"], 12),
        )

    def test_wrong_level_pair_is_rejected(self):
        for low, high in ((0, 2), (1, 4), (9, 11)):
            with self.subTest(low=low, high=high), self.assertRaises(DifficultyMatchError):
                validate_pair_levels(low, high)

    def test_draws_do_not_count_as_higher_level_wins(self):
        openings = [
            {"id": "o0", "source": "src-0", "moves": []},
            {"id": "o1", "source": "src-1", "moves": []},
        ]
        games = [dict(row, result_for_high=result) for row, result in zip(
            schedule_pair(openings, lower_level=1, master_seed=1), ["win", "win", "draw", "loss"]
        )]
        summary = aggregate_pair(games, openings, lower_level=1)
        self.assertEqual(summary["higher_wins"], 2)
        self.assertEqual(summary["completed_games"], 4)
        self.assertEqual(summary["win_fraction"], 0.5)
        self.assertFalse(summary["passed"])

    def test_wrong_pair_unfinished_or_incomplete_rows_never_pass(self):
        schedule = schedule_pair(OPENINGS, lower_level=1, master_seed=5)
        games = [dict(row, result_for_high="win") for row in schedule]
        wrong = [dict(row) for row in games]
        wrong[0]["low_level"] = 4
        self.assertFalse(aggregate_pair(wrong, OPENINGS, lower_level=1)["complete"])
        unfinished = [dict(row) for row in games]
        unfinished[0]["result_for_high"] = "unfinished"
        self.assertFalse(aggregate_pair(unfinished, OPENINGS, lower_level=1)["complete"])
        self.assertFalse(aggregate_pair(games[:1], OPENINGS, lower_level=1)["complete"])


class RustGameAuditTests(unittest.TestCase):
    def _tiny_draw_rows(self):
        rows = schedule_pair(OPENINGS[:1], lower_level=1, master_seed=5, run_kind="pilot")
        for game in rows:
            game.update({
                "moves": DRAW_CYCLE,
                "terminal_outcome": "draw",
                "result_for_high": "draw",
                "unfinished_reason": None,
                "protocol_error": None,
                "nodes": 100000,
                "max_ply": 4096,
                "decision_trace": [],
            })
            game["decision_trace"] = self._trace_for(game, DRAW_CYCLE)
        return rows

    def _trace_for(self, game, moves):
        return [
                {
                    "decision_index": ply,
                    "absolute_ply": ply,
                    "actor": "A" if (ply % 2 == 0) == game["high_is_red"] else "B",
                    "game_seed": game["game_seed_high"] if ((ply % 2 == 0) == game["high_is_red"]) else game["game_seed_low"],
                    "random_seed": derive_move_seed(
                        game["game_seed_high"] if ((ply % 2 == 0) == game["high_is_red"]) else game["game_seed_low"], ply
                    ),
                    "level": game["high_level"] if ((ply % 2 == 0) == game["high_is_red"]) else game["low_level"],
                }
                for ply in range(len(moves) + 1)
            ]

    def _write_raw_logs(self, rows, directory):
        logs = {"A": [], "B": []}
        for actor, level in (("A", 3), ("B", 1)):
            logs[actor].extend(f"stdin: setoption name {name} value {value}"
                               for name, value in BASELINE_OPTIONS.items())
            logs[actor].append(f"stdin: setoption name DifficultyLevel value {level}")
            logs[actor].append("stdin: setoption name Strategy value difficulty")
            first = rows[0]
            batch_context = {
                "schema": "m5-difficulty-raw-v1", "run_kind": first["run_kind"],
                "lower_level": first["low_level"], "higher_level": first["high_level"],
                "master_seed": first["master_seed"], "seed_scheme": first["seed_scheme"],
                "opening_set_sha256": first["opening_set_sha256"],
            }
            logs[actor].append("context: batch " + json.dumps(batch_context, sort_keys=True, separators=(",", ":")))
        for game in rows:
            for actor, level in (("A", game["high_level"]), ("B", game["low_level"])):
                logs[actor].extend(f"stdin: setoption name {name} value {value}"
                                   for name, value in BASELINE_OPTIONS.items())
                logs[actor].append(f"stdin: setoption name DifficultyLevel value {level}")
            for decision in game["decision_trace"]:
                actor = decision["actor"]
                logs[actor].append(
                    f"context: game_id={game['game_id']} actor={actor} decision_index={decision['decision_index']}"
                )
                logs[actor].append(f"stdin: setoption name Strategy value difficulty")
                logs[actor].append(f"stdin: setoption name RandomSeed value {decision['random_seed']}")
                position = game["moves"][:decision["decision_index"]]
                logs[actor].append("stdin: position startpos moves " + " ".join(position))
                logs[actor].append("stdin: go nodes 100000")
                if decision["decision_index"] < len(game["moves"]):
                    move = game["moves"][decision["decision_index"]]
                    logs[actor].append(f"stdout: info string difficulty-selected {move} level {decision['level']}")
                    logs[actor].append(f"stdout: bestmove {move}")
                else:
                    logs[actor].append("stdout: info string outcome draw")
                    logs[actor].append("stdout: bestmove 0000")
        paths = {}
        for actor, lines in logs.items():
            path = directory / f"engine-{actor.lower()}.log"
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            paths[actor] = path
        return paths

    def test_tiny_synthetic_batch_is_replayed_by_trusted_xq_core_game(self):
        rows = self._tiny_draw_rows()
        with tempfile.TemporaryDirectory() as tmp:
            raw_paths = self._write_raw_logs(rows, Path(tmp))
            result = audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                                 caller_nodes=100000, raw_paths=raw_paths)
        self.assertTrue(result["game_replay_valid"])
        self.assertEqual(result["replayed_games"], 2)
        self.assertFalse(result["formal_gate_eligible"])
        self.assertEqual(result["higher_wins"], 0)

    def test_final_manifest_cannot_promote_pilot_rows_or_raw(self):
        openings = [
            {"id": f"o{index:02}", "source": f"src{index:02}", "moves": [],
             "source_group_sha256": f"{index + 1:064x}"}
            for index in range(50)
        ]
        rows = schedule_pair(openings, lower_level=1, master_seed=9, run_kind="pilot")
        for row in rows:
            row.update({
                "moves": DRAW_CYCLE, "terminal_outcome": "draw", "result_for_high": "draw",
                "unfinished_reason": None, "protocol_error": None, "nodes": 100000,
                "max_ply": MAX_PLY, "decision_trace": self._trace_for(row, DRAW_CYCLE),
            })

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            original = self._write_raw_logs(rows, run_dir)
            for actor in ("A", "B"):
                lines = original[actor].read_text(encoding="utf-8").splitlines()
                batch_context = next(line for line in lines if line.startswith("context: batch "))
                for worker in range(1, WORKERS + 1):
                    target = run_dir / "workers" / f"worker-{worker:02d}" / f"engine-{actor.lower()}.log"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("\n".join(lines if worker == 1 else [batch_context]) + "\n",
                                      encoding="utf-8")

            binary = Path("/bin/true").resolve()
            pilot_groups = {"f" * 64}
            manifest = {
                "schema": "m5-difficulty-pair-v1",
                "status": "awaiting_independent_game_and_raw_audit",
                "run_kind": "final",
                "lower_level": 1, "higher_level": 3,
                "opening_count": 50, "requested_games": 100, "observed_games": 100,
                "caller_nodes": 100000, "max_ply": MAX_PLY, "workers": WORKERS,
                "engine_timeout_seconds": 30.0, "master_seed": 9,
                "engine_options": BASELINE_OPTIONS,
                "opening_set_sha256": _opening_set_digest(openings),
                "pilot_source_groups": sorted(pilot_groups),
                "engine": {"command": str(binary), "path": str(binary),
                           "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()},
            }
            (run_dir / "run-manifest.json").write_text(
                json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            (run_dir / "games.jsonl").write_text(
                "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
            summary = apply_run_kind_gate(aggregate_pair(rows, openings, lower_level=1), "final")
            (run_dir / "summary.json").write_text(
                json.dumps(summary, sort_keys=True, indent=2) + "\n", encoding="utf-8")

            with self.assertRaises(DifficultyMatchError):
                audit_run_directory(run_dir, openings, pilot_source_groups=pilot_groups)

    def test_illegal_moves_wrong_seed_or_selected_move_mismatch_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = self._tiny_draw_rows()
            illegal = [dict(row) for row in rows]
            illegal[0]["moves"] = ["b0b9"]
            illegal[0]["decision_trace"] = self._trace_for(illegal[0], illegal[0]["moves"])
            raw_paths = self._write_raw_logs(illegal, Path(tmp))
            with self.assertRaises(DifficultyMatchError):
                audit_batch(illegal, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=raw_paths)
            wrong_seed = [dict(row) for row in rows]
            wrong_seed[0] = dict(wrong_seed[0], game_seed_high=wrong_seed[0]["game_seed_high"] ^ 1)
            with self.assertRaises(DifficultyMatchError):
                audit_batch(wrong_seed, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=raw_paths)
            selected_mismatch = dict(raw_paths)
            selected_mismatch["A"] = Path(tmp) / "tampered.log"
            selected_mismatch["A"].write_text(raw_paths["A"].read_text().replace(
                "difficulty-selected h0g2 level 3", "difficulty-selected h0h1 level 3", 1
            ))
            with self.assertRaises(DifficultyMatchError):
                audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=selected_mismatch)

    def test_raw_flags_are_checked_at_each_go_not_only_at_log_end(self):
        rows = self._tiny_draw_rows()
        with tempfile.TemporaryDirectory() as tmp:
            raw_paths = self._write_raw_logs(rows, Path(tmp))
            path = raw_paths["A"]
            contents = path.read_text(encoding="utf-8")
            contents = contents.replace(
                "stdin: setoption name RootAlpha value true\n",
                "stdin: setoption name RootAlpha value false\n",
            )
            path.write_text(contents + "stdin: setoption name RootAlpha value true\n", encoding="utf-8")
            with self.assertRaises(DifficultyMatchError):
                audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=raw_paths)

    def test_raw_flag_drift_between_games_is_rejected_and_reapply_is_allowed(self):
        rows = self._tiny_draw_rows()
        with tempfile.TemporaryDirectory() as tmp:
            raw_paths = self._write_raw_logs(rows, Path(tmp))
            path = raw_paths["A"]
            contents = path.read_text(encoding="utf-8")
            contexts = [line for line in contents.splitlines() if line.startswith("context:")]
            self.assertGreaterEqual(len(contexts), 2)
            contents = contents.replace(contexts[1],
                "stdin: setoption name RootAlpha value false\n" + contexts[1], 1)
            path.write_text(contents + "stdin: setoption name RootAlpha value true\n", encoding="utf-8")
            with self.assertRaises(DifficultyMatchError):
                audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=raw_paths)

            valid_paths = self._write_raw_logs(rows, Path(tmp))
            valid_a = valid_paths["A"]
            valid_a.write_text(valid_a.read_text(encoding="utf-8") +
                               "stdin: setoption name RootAlpha value true\n", encoding="utf-8")
            result = audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                                 caller_nodes=100000, raw_paths=valid_paths)
            self.assertTrue(result["raw_replay_valid"])

    def test_missing_initial_fixed_option_is_rejected_even_if_added_after_games(self):
        rows = self._tiny_draw_rows()
        with tempfile.TemporaryDirectory() as tmp:
            raw_paths = self._write_raw_logs(rows, Path(tmp))
            path = raw_paths["A"]
            contents = path.read_text(encoding="utf-8")
            contents = contents.replace("stdin: setoption name RootAlpha value true\n", "")
            path.write_text(contents + "stdin: setoption name RootAlpha value true\n", encoding="utf-8")
            with self.assertRaises(DifficultyMatchError):
                audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=raw_paths)

    def test_raw_batch_identity_must_match_pilot_manifest_identity(self):
        rows = self._tiny_draw_rows()
        with tempfile.TemporaryDirectory() as tmp:
            raw_paths = self._write_raw_logs(rows, Path(tmp))
            path = raw_paths["A"]
            contents = path.read_text(encoding="utf-8")
            self.assertIn("context: batch ", contents)
            path.write_text(contents.replace('"run_kind":"pilot"', '"run_kind":"final"'), encoding="utf-8")
            with self.assertRaises(DifficultyMatchError):
                audit_batch(rows, OPENINGS[:1], lower_level=1, master_seed=5,
                            caller_nodes=100000, raw_paths=raw_paths)


if __name__ == "__main__":
    unittest.main()

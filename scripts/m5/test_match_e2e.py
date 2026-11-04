"""Synthetic-only integration: M5 sample → shared runner → xq-core replay → M5 audit."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import io
import contextlib
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "scripts/m5"), str(ROOT / "scripts/m4")]
import protocol
import audit
import future_openings
import match
import m5


class M5EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        replay = ROOT / "target/debug/match-replay"
        if not replay.is_file():
            subprocess.run(["cargo", "build", "-q", "-p", "xq-uci", "--bin", "match-replay"], cwd=ROOT, check=True)

    def test_synthetic_full_protocol_produces_audited_receipt(self):
        from test_future_openings import FutureOpeningToolTests
        fixture = FutureOpeningToolTests()
        fixture.setUp()
        try:
            prefix = "b0c2 b9c7 c2b0 c7b9"
            base = fixture.root / "docs/research/m4-openings"
            future = fixture.root / "docs/research/m4-validation/future-opening-protocol"
            eligible_path = base / "eligible-population.jsonl"
            eligible = [json.loads(row) for row in eligible_path.read_text().splitlines()]
            for row in eligible:
                row["iccs_prefix"] = prefix
            old, remaining = eligible[:50], eligible[50:]
            (base / "eligible-population.jsonl").write_text(fixture._jsonl(eligible))
            (base / "selected-50.jsonl").write_text(fixture._jsonl(old))
            (future / "remaining-153.jsonl").write_text(fixture._jsonl(remaining))
            (base / "selected-50.tsv").write_text(
                "opening_id\tsource_ref\ticcs_prefix\n" + "".join(
                    f"{row['opening_id']}\t{row['source_url']}\t{prefix}\n" for row in old))
            first_hashes = {name: fixture._sha(base / name) for name in
                            ("eligible-population.jsonl", "selected-50.jsonl", "selected-50.tsv")}
            (base / "opening-selection-protocol.json").write_text(json.dumps({
                "eligible_population_sha256": first_hashes["eligible-population.jsonl"],
                "selected_population_sha256": first_hashes["selected-50.jsonl"],
                "runner_tsv_sha256": first_hashes["selected-50.tsv"],
                "eligible_population_count": 203, "selected_count": 50,
            }))
            source_hashes = {name: fixture._sha(base / name) for name in (
                "eligible-population.jsonl", "selected-50.jsonl", "selected-50.tsv", "opening-selection-protocol.json")}
            (future / "protocol-proposal.md").write_text("Synthetic protocol fixture.\n")
            (future / "manifest.json").write_text(json.dumps({
                "schema": "future-opening-remaining-v1", "status": "synthetic test only",
                "population_size": 153, "selection_executed": False,
                "source_files_sha256": source_hashes, "excluded_old_selected_count": 50,
                "entries_file": "remaining-153.jsonl", "entries_sha256": fixture._sha(future / "remaining-153.jsonl"),
                "current_protocol_sha256": fixture._sha(future / "protocol-proposal.md"),
            }))
            fixture.fixture_pins = fixture._pin_fixture_sources(fixture.root)

            candidate = fixture.candidate
            flags = {**protocol.BASELINE_FLAGS, "NullMove": True}
            config = {"candidate_id": "synthetic-nullmove", "target": "NullMove",
                      "baseline_flags": protocol.BASELINE_FLAGS, "candidate_flags": flags,
                      "common_options": protocol.M5_COMMON_OPTIONS}
            candidate["config"].write_text(json.dumps(config) + "\n")
            subprocess.run(["git", "-C", str(candidate["repo"]), "add", "config.json"], check=True)
            subprocess.run(["git", "-C", str(candidate["repo"]), "commit", "-qm", "freeze synthetic M5 config"], check=True)
            fake = candidate["binary"]
            fake.write_text("""#!/usr/bin/env python3
import sys
cycle=['b0c2','b9c7','c2b0','c7b9']
for raw in sys.stdin:
 line=raw.strip()
 if line=='uci':
  print('id name synthetic-loop-engine')
  for name in ['UCI_Variant','MultiPV','Strategy','RandomSeed','RootAlpha','CheckExtensions','KillerHistoryOrdering','NullMove','LateMoveReductions']:
   if name=='UCI_Variant': print('option name UCI_Variant type combo default xiangqi var xiangqi')
   elif name=='MultiPV': print('option name MultiPV type spin default 1 min 1 max 16')
   elif name=='Strategy': print('option name Strategy type combo default search var search var random var greedy')
   elif name=='RandomSeed': print('option name RandomSeed type spin default 1 min 0 max 999999999')
   else: print(f'option name {name} type check default false')
  print('uciok',flush=True)
 elif line=='isready': print('readyok',flush=True)
 elif line.startswith('position startpos moves '): moves=line.removeprefix('position startpos moves ').split()
 elif line.startswith('go nodes '):
  if len(moves)>=8:
   print('info string outcome draw')
   print('bestmove 0000',flush=True)
  else: print('bestmove '+cycle[len(moves)%4],flush=True)
 elif line=='quit': break
""", encoding="utf-8")
            fake.chmod(0o755)
            lock = {"schema": protocol.LOCK_SCHEMA, "status": "locked", "candidate_id": "synthetic-nullmove",
                    "target": "NullMove", "baseline_flags": protocol.BASELINE_FLAGS, "candidate_flags": flags,
                    "common_options": protocol.M5_COMMON_OPTIONS,
                    "git_repo_path": str(candidate["repo"]),
                    "git_head": subprocess.check_output(["git", "-C", str(candidate["repo"]), "rev-parse", "HEAD"], text=True).strip(),
                    "config_path": "config.json", "config_sha256": protocol.sha(candidate["config"]),
                    "binary_path": str(fake), "binary_sha256": protocol.sha(fake)}
            fixture.lock_path.write_text(json.dumps(lock) + "\n")
            sample = fixture.root.parent / "synthetic-m5-sample"
            with patch.dict(future_openings.SOURCE_SHA256S, fixture.fixture_pins, clear=True), \
                 patch.object(future_openings.secrets, "token_bytes", return_value=(999).to_bytes(8, "big")), \
                 patch.object(sys, "argv", ["m5.py", "sample", "--source-repo", str(fixture.root),
                                             "--candidate-lock", str(fixture.lock_path), "--output-dir", str(sample)]), \
                 contextlib.redirect_stdout(io.StringIO()):
                m5.main()
            manifest = sample / "selection-manifest.json"
            binding = sample / "m5-selection-binding.json"
            look1_tsv = sample / "look1.tsv"
            run_dir = fixture.root.parent / "synthetic-m5-run"
            command = [sys.executable, str(ROOT / "scripts/m4/match.py"),
                       "--engine-a", str(fake), "--engine-b", str(fake), "--openings", str(look1_tsv),
                       "--nodes", "10000", "--games", "200", "--global-round-start", "1",
                       "--global-round-count", "2", "--max-ply", "4096", "--engine-timeout", "30",
                       "--workers", "4", "--strategy-a", "search", "--strategy-b", "search",
                       "--engine-a-options", json.dumps(protocol.runner_options(flags), separators=(",", ":")),
                       "--engine-b-options", json.dumps(protocol.runner_options(protocol.BASELINE_FLAGS), separators=(",", ":")),
                       "--m5-profile", "nullmove", "--m5-candidate-lock", str(fixture.lock_path),
                       "--m5-selection-binding", str(binding), "--future-selection-manifest", str(manifest),
                       "--look", "1", "--seed", "1", "--output", str(run_dir)]
            stdout = io.StringIO()
            with patch.dict(future_openings.SOURCE_SHA256S, fixture.fixture_pins, clear=True), \
                 patch.object(sys, "argv", command[1:]), contextlib.redirect_stdout(stdout):
                run_status = match.main()
            self.assertEqual(run_status, 0, stdout.getvalue()[-1500:])
            replay_exe = ROOT / "target/debug/match-replay"
            receipt1_path = run_dir / "m5-audit-receipt.json"
            fake_replay = fixture.root / "dishonest-replay"
            fake_replay.write_text("""#!/usr/bin/env python3
import sys
for line in sys.stdin:
 game_id, moves = line.rstrip('\\n').split('\\t', 1)
 print(f'{game_id}\\tdraw\\t{len(moves.split())}')
""", encoding="utf-8")
            fake_replay.chmod(0o755)
            fake_args = ["m5.py", "audit", "--run", str(run_dir), "--candidate-lock", str(fixture.lock_path),
                         "--binding", str(binding), "--selection-manifest", str(manifest),
                         "--openings", str(look1_tsv), "--replay", str(fake_replay), "--look", "1",
                         "--receipt", str(receipt1_path)]
            with patch.object(sys, "argv", fake_args), contextlib.redirect_stderr(io.StringIO()), \
                 self.assertRaises(SystemExit):
                m5.main()
            self.assertFalse(receipt1_path.exists())
            with patch.dict(future_openings.SOURCE_SHA256S, fixture.fixture_pins, clear=True):
                audit_argv = ["m5.py", "audit", "--run", str(run_dir), "--candidate-lock", str(fixture.lock_path),
                              "--binding", str(binding), "--selection-manifest", str(manifest),
                              "--openings", str(look1_tsv), "--look", "1",
                              "--receipt", str(receipt1_path)]
                with patch.object(sys, "argv", audit_argv), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(m5.main(), 0)
                receipt1 = audit.verify_receipt(receipt1_path)
                second_dir = fixture.root.parent / "synthetic-m5-look2"
                command2 = list(command)
                command2[command2.index("--global-round-start") + 1] = "3"
                command2[command2.index("--look") + 1] = "2"
                command2[command2.index(str(look1_tsv))] = str(sample / "look2.tsv")
                command2[command2.index("--output") + 1] = str(second_dir)
                command2.extend(["--m5-prior-look-receipt", str(receipt1_path)])
                with patch.object(sys, "argv", command2[1:]), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(match.main(), 0)
                receipt2_path = second_dir / "m5-audit-receipt.json"
                audit_argv2 = ["m5.py", "audit", "--run", str(second_dir), "--candidate-lock", str(fixture.lock_path),
                               "--binding", str(binding), "--selection-manifest", str(manifest),
                               "--openings", str(sample / "look2.tsv"), "--look", "2",
                               "--prior-look-receipt", str(receipt1_path), "--receipt", str(receipt2_path)]
                with patch.object(sys, "argv", audit_argv2), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(m5.main(), 0)
                receipt2 = audit.verify_receipt(receipt2_path)
                combine_argv = ["m5.py", "combine", "--look1-receipt", str(receipt1_path),
                                "--look2-receipt", str(receipt2_path)]
                combine_out = io.StringIO()
                with patch.object(sys, "argv", combine_argv), contextlib.redirect_stdout(combine_out):
                    self.assertEqual(m5.main(), 0)
                combined = json.loads(combine_out.getvalue())
            self.assertEqual(receipt1["game_count"], 200)
            self.assertEqual(receipt1["replayed_games"], 200)
            self.assertEqual(sum(receipt1["raw_decisions"].values()), 1000)
            self.assertEqual(combined["effective_cluster_count"], 100)
            self.assertEqual(combined["verdict"], "discard_inconclusive")
            keep_dir = os.environ.get("M5_TEST_KEEP_DIR")
            if keep_dir:
                retained = Path(keep_dir)
                if retained.exists() and any(retained.iterdir()):
                    raise AssertionError("M5_TEST_KEEP_DIR must be empty; refusing to overwrite artifacts")
                retained.mkdir(parents=True, exist_ok=True)
                shutil.copytree(sample, retained / "synthetic-sample")
                shutil.copytree(run_dir, retained / "look1-run")
                shutil.copytree(second_dir, retained / "look2-run")
                shutil.copy2(receipt1_path, retained / "look1-receipt.json")
                shutil.copy2(receipt2_path, retained / "look2-receipt.json")
                (retained / "combined.json").write_text(json.dumps(combined, sort_keys=True, indent=2) + "\n")
                evidence = {}
                for file in sorted(path for path in retained.rglob("*") if path.is_file()):
                    evidence[file.relative_to(retained).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
                (retained / "sha256-manifest.json").write_text(json.dumps(evidence, sort_keys=True, indent=2) + "\n")
            raw_ref = next(ref for name, ref in receipt1["artifacts"].items() if name.startswith("raw:"))
            with open(raw_ref["path"], "a", encoding="utf-8") as stream:
                stream.write("tampered\n")
            with patch.dict(future_openings.SOURCE_SHA256S, fixture.fixture_pins, clear=True), \
                 self.assertRaises(protocol.ProtocolError):
                audit.verify_receipt(receipt1_path)
        finally:
            fixture.doCleanups()

    def test_trusted_game_replay_rejects_review_illegal_b0b9_and_accepts_real_cycle(self):
        with audit.trusted_replay() as replay:
            illegal = subprocess.run([str(replay)], input="review-illegal\tb0b9\n", text=True,
                                     capture_output=True)
            self.assertNotEqual(illegal.returncode, 0)
            self.assertIn("illegal b0b9", illegal.stderr)
            legal = subprocess.run([str(replay)], input="review-legal\tb0c2 b9c7 c2b0 c7b9 b0c2 b9c7 c2b0 c7b9\n",
                                   text=True, capture_output=True)
            self.assertEqual(legal.returncode, 0, legal.stderr)
            self.assertEqual(legal.stdout.strip(), "review-legal\tdraw\t8")


if __name__ == "__main__":
    unittest.main()

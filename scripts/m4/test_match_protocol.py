import sys
import tempfile
import unittest
import hashlib
import json
import shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from match import verify_selection_protocol


ROOT = Path(__file__).parents[2]
PROTOCOL = ROOT / "docs/research/m4-openings/opening-selection-protocol.json"
SELECTED_TSV = ROOT / "docs/research/m4-openings/selected-50.tsv"


class SelectionProtocolTests(unittest.TestCase):
    def test_verified_manifest_accepts_full_frozen_selection(self):
        verified = verify_selection_protocol(PROTOCOL, SELECTED_TSV)
        self.assertEqual(verified["population_size"], 203)
        self.assertEqual(verified["selected_count"], 50)
        self.assertTrue(verified["full_selected_sample"])

    def test_verified_manifest_allows_only_a_subset_for_pilot(self):
        with tempfile.TemporaryDirectory() as directory:
            subset = Path(directory) / "pilot.tsv"
            rows = SELECTED_TSV.read_text(encoding="utf-8").splitlines()
            subset.write_text("\n".join(rows[:3]) + "\n", encoding="utf-8")
            verified = verify_selection_protocol(PROTOCOL, subset)
        self.assertEqual(verified["population_size"], 203)
        self.assertEqual(verified["selected_count"], 50)
        self.assertFalse(verified["full_selected_sample"])

    def test_modified_or_unselected_runner_rows_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            altered = Path(directory) / "altered.tsv"
            rows = SELECTED_TSV.read_text(encoding="utf-8").splitlines()
            altered.write_text(rows[0] + "\n" + rows[1].replace("c3c4", "c3c5") + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                verify_selection_protocol(PROTOCOL, altered)

    def test_self_consistent_forged_selection_is_not_the_frozen_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("eligible-population.jsonl", "selected-50.jsonl", "selected-50.tsv"):
                shutil.copy(PROTOCOL.parent / name, root / name)
            eligible_path = root / "eligible-population.jsonl"
            eligible = [json.loads(line) for line in eligible_path.read_text().splitlines()]
            eligible[0]["source_pgn_url"] = "https://example.invalid/changed-source.pgn"
            eligible_path.write_text("".join(json.dumps(row) + "\n" for row in eligible))

            protocol = json.loads(PROTOCOL.read_text())
            protocol["eligible_population_sha256"] = hashlib.sha256(eligible_path.read_bytes()).hexdigest()
            protocol_path = root / "protocol.json"
            protocol_path.write_text(json.dumps(protocol))
            runner_tsv = root / "selected-50.tsv"
            with self.assertRaisesRegex(ValueError, "frozen M4 value"):
                verify_selection_protocol(protocol_path, runner_tsv)


if __name__ == "__main__":
    unittest.main()

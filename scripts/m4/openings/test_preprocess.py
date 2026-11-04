import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("preprocess_ccpd.py")
REVISION = "368a47a947773dd8692c026e286dd19b6277b993"


class PreprocessCcpdTests(unittest.TestCase):
    def test_big5_files_keep_order_provenance_and_decode_failures(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "Dataset" / "開局"
            source.mkdir(parents=True)
            valid_text = '[Game "Chinese Chess"]\n[Event "測試"]\n[ECCO "C44"]\n'
            first = source / "00000001.pgn"
            second = source / "00000002.pgn"
            invalid = source / "00000003.pgn"
            first_bytes = valid_text.encode("big5")
            second_bytes = valid_text.replace("C44", "B20").encode("big5")
            first.write_bytes(first_bytes)
            second.write_bytes(second_bytes)
            invalid.write_bytes(b"\x81 ")
            output = root / "input.jsonl"

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input-dir", str(source), "--output", str(output), "--revision", REVISION],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row["source_name"] for row in rows], [
                "CCPD-opening-00000001", "CCPD-opening-00000002", "CCPD-opening-00000003"
            ])
            self.assertEqual(rows[0]["pgn"], valid_text)
            self.assertEqual(rows[0]["source_pgn_sha256"], hashlib.sha256(first_bytes).hexdigest())
            self.assertEqual(rows[0]["source_revision"], REVISION)
            self.assertEqual(rows[0]["source_license"], "CC-BY-4.0")
            self.assertIn("/blob/" + REVISION + "/Dataset/%E9%96%8B%E5%B1%80/00000001.pgn", rows[0]["source_pgn_url"])
            self.assertIn("big5_decode_error", rows[2]["preprocess_error"])
            self.assertEqual(rows[2]["source_pgn_sha256"], hashlib.sha256(b"\x81 ").hexdigest())


if __name__ == "__main__":
    unittest.main()

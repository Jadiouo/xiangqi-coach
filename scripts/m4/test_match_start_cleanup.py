import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import match


class UciStartCleanupTests(unittest.TestCase):
    def test_log_open_failure_reaps_only_the_newly_spawned_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pid_file = root / "engine.pid"
            engine_script = root / "fake_uci.py"
            engine_script.write_text(
                "import os, sys, time\n"
                f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
                "for line in sys.stdin:\n"
                " if line.strip() == 'quit': break\n"
                " time.sleep(0.01)\n",
                encoding="utf-8",
            )
            log_path = root / "is-a-directory"
            log_path.mkdir()
            original_popen = subprocess.Popen
            spawned = []

            def observed_popen(*args, **kwargs):
                process = original_popen(*args, **kwargs)
                spawned.append(process)
                deadline = time.monotonic() + 3
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                if not pid_file.exists():
                    process.terminate()
                    process.wait(timeout=2)
                    self.fail("fake engine did not start before the log failure")
                return process

            try:
                with patch.object(match.subprocess, "Popen", observed_popen):
                    with self.assertRaises(IsADirectoryError):
                        match.UciEngine.start(f"{sys.executable} {engine_script}", log_path=log_path)
                self.assertEqual(len(spawned), 1)
                self.assertIsNotNone(spawned[0].poll(), "UCI start leaked its newly spawned child")
            finally:
                for process in spawned:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()

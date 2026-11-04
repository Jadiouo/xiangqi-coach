import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

BRIDGE = Path(__file__).with_name('uci_rank_bridge.py')

class RankBridgeTests(unittest.TestCase):
    def test_inbound_and_outbound_protocol_translation(self):
        sys.path.insert(0, str(BRIDGE.parent))
        import importlib.util
        spec = importlib.util.spec_from_file_location('rank_bridge', BRIDGE)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        self.assertEqual(bridge.inbound('position startpos moves b10b9 a1a2'),
                         'position startpos moves b9b8 a0a1')
        self.assertEqual(bridge.inbound('position fen 9/9/9/9/9/9/9/9/9/9 w - - 0 1 moves i10i9'),
                         'position fen 9/9/9/9/9/9/9/9/9/9 w - - 0 1 moves i9i8')
        self.assertEqual(bridge.inbound('go nodes 99 searchmoves i10i9 a1a2'),
                         'go nodes 99 searchmoves i9i8 a0a1')
        self.assertEqual(bridge.outbound('bestmove b0b1 ponder i9i8'),
                         'bestmove b1b2 ponder i10i9')
        self.assertEqual(bridge.outbound('bestmove 0000'), 'bestmove 0000')
        self.assertEqual(bridge.outbound('bestmove (none)'), 'bestmove (none)')
        self.assertEqual(bridge.outbound('info depth 4 score cp 23 nodes 99 currmove b0b1 pv i9i8 b0b1 refutation a0a1 currline 0 b9b8'),
                         'info depth 4 score cp 23 nodes 99 currmove b1b2 pv i10i9 b1b2 refutation a1a2 currline 0 b10b9')
        self.assertEqual(bridge.outbound('info string literal b0b1 is not a move field'),
                         'info string literal b0b1 is not a move field')

    def test_dummy_engine_round_trip_variant_and_raw_rewrite_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = root / 'dummy.py'
            engine.write_text(textwrap.dedent('''\
                #!/usr/bin/env python3
                import sys
                for raw in sys.stdin:
                    line = raw.strip()
                    if line == 'uci':
                        print('id name dummy', flush=True)
                        print('uciok', flush=True)
                    elif line == 'isready': print('readyok', flush=True)
                    elif line.startswith('position'):
                        print('info depth 2 score cp 15 nodes 10 currmove b9b8 pv b9b8 i0i1 refutation a0a1 currline 0 i9i8', flush=True)
                    elif line.startswith('go'):
                        print('bestmove b0b1 ponder i9i8', flush=True)
                    elif line == 'quit': break
            '''), encoding='utf-8')
            engine.chmod(0o755)
            log = root / 'bridge.jsonl'
            cmd = [sys.executable, str(BRIDGE), '--engine', str(engine), '--log', str(log), '--inject-variant']
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            p.stdin.write('uci\n'); p.stdin.flush()
            output = []
            while not any(line == 'uciok' for line in output):
                line = p.stdout.readline().strip()
                if not line:
                    self.fail(f'bridge exited during uci handshake: poll={p.poll()} log={log.read_text() if log.exists() else "missing"}')
                output.append(line)
            self.assertIn('option name UCI_Variant type combo default xiangqi var xiangqi', output)
            p.stdin.write('setoption name UCI_Variant value xiangqi\n')
            p.stdin.write('position startpos moves b10b9\n')
            p.stdin.write('go nodes 99 searchmoves i10i9\n'); p.stdin.flush()
            output += [p.stdout.readline().strip(), p.stdout.readline().strip()]
            p.stdin.write('stop\nquit\n'); p.stdin.flush()
            p.stdin.close()
            self.assertEqual(p.wait(timeout=5), 0, p.stderr.read())
            log_rows = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()]
            forwarded = [r['line'] for r in log_rows if r['direction'] == 'bridge_to_engine']
            self.assertIn('position startpos moves b9b8', forwarded)
            self.assertIn('go nodes 99 searchmoves i9i8', forwarded)
            self.assertNotIn('setoption name UCI_Variant value xiangqi', forwarded)
            self.assertIn('stop', forwarded)
            self.assertIn('quit', forwarded)
            rewritten = [r for r in log_rows if r.get('rewritten')]
            self.assertTrue(any(r['line'].startswith('bestmove b0b1') and r['rewritten'] == 'bestmove b1b2 ponder i10i9' for r in rewritten))
            self.assertTrue(any('currmove b9b8' in r['line'] and 'currmove b10b9' in r['rewritten'] for r in rewritten))
            self.assertIn('option name UCI_Variant type combo default xiangqi var xiangqi', output)
            self.assertIn('bestmove b1b2 ponder i10i9', output)
            p.stdout.close(); p.stderr.close()

if __name__ == '__main__': unittest.main()

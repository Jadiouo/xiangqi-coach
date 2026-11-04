#!/usr/bin/env python3
"""Adapt 0-based ICCS rank digits to Cute Chess's 1-based Xiangqi coordinates."""
import argparse
import json
import re
import subprocess
import sys
import threading
from pathlib import Path

MOVE_FROM_ENGINE = re.compile(r"^([a-i])([0-9])([a-i])([0-9])$")
MOVE_FROM_GUI = re.compile(r"^([a-i])(10|[1-9])([a-i])(10|[1-9])$")
INFO_FIELDS = {
    "depth", "seldepth", "time", "nodes", "pv", "multipv", "score", "currmove",
    "currmovenumber", "hashfull", "nps", "tbhits", "sbhits", "cpuload", "refutation",
    "currline", "string", "wdl", "ebf",
}


def to_engine_move(token):
    match = MOVE_FROM_GUI.fullmatch(token)
    if not match:
        return token
    file_from, rank_from, file_to, rank_to = match.groups()
    return f"{file_from}{int(rank_from) - 1}{file_to}{int(rank_to) - 1}"


def to_gui_move(token):
    match = MOVE_FROM_ENGINE.fullmatch(token)
    if not match:
        return token
    file_from, rank_from, file_to, rank_to = match.groups()
    return f"{file_from}{int(rank_from) + 1}{file_to}{int(rank_to) + 1}"


def inbound(line):
    words = line.split()
    if words[:2] == ["position", "startpos"] or words[:2] == ["position", "fen"]:
        if "moves" in words:
            index = words.index("moves") + 1
            words[index:] = [to_engine_move(word) for word in words[index:]]
    elif words and words[0] == "go" and "searchmoves" in words:
        index = words.index("searchmoves") + 1
        words[index:] = [to_engine_move(word) for word in words[index:]]
    return " ".join(words)


def outbound(line):
    words = line.split()
    if not words:
        return line
    if words[0] == "bestmove":
        for index in range(1, len(words)):
            if words[index] == "ponder":
                continue
            if words[index - 1] == "ponder" or index == 1:
                words[index] = to_gui_move(words[index])
        return " ".join(words)
    if words[0] == "info":
        for index in range(1, len(words)):
            if words[index] == "string":
                break
            if MOVE_FROM_ENGINE.fullmatch(words[index]):
                words[index] = to_gui_move(words[index])
    return " ".join(words)


class Bridge:
    def __init__(self, engine, log_path, inject_variant):
        self.engine_path = Path(engine).resolve()
        self.log_path = Path(log_path)
        self.inject_variant = inject_variant
        self.lock = threading.Lock()
        self.native_variant = False
        self.process = subprocess.Popen(
            [str(self.engine_path)], cwd=self.engine_path.parent, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )

    def record(self, direction, line, rewritten=None):
        row = {"direction": direction, "line": line.rstrip("\r\n")}
        if rewritten is not None and rewritten != line.rstrip("\r\n"):
            row["rewritten"] = rewritten
        with self.lock, self.log_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(row, ensure_ascii=False) + "\n")

    def read_stdout(self):
        assert self.process.stdout is not None
        for raw in self.process.stdout:
            line = raw.rstrip("\r\n")
            self.record("engine_to_bridge", line)
            if line.startswith("option name UCI_Variant "):
                self.native_variant = True
            if line == "uciok":
                # Preserve a native declaration; inject only for fixed-variant engines.
                if self.inject_variant and not self.native_variant:
                    option = "option name UCI_Variant type combo default xiangqi var xiangqi"
                    print(option, flush=True)
                    self.record("bridge_to_gui", option, "injected fixed Xiangqi variant capability")
            translated = outbound(line)
            if translated != line:
                self.record("bridge_to_gui", line, translated)
            print(translated, flush=True)

    def read_stderr(self):
        assert self.process.stderr is not None
        for raw in self.process.stderr:
            self.record("engine_stderr", raw)

    def run(self):
        threading.Thread(target=self.read_stdout, daemon=True).start()
        threading.Thread(target=self.read_stderr, daemon=True).start()
        try:
            for raw in sys.stdin:
                line = raw.rstrip("\r\n")
                self.record("gui_to_bridge", line)
                words = line.split()
                if words[:2] == ["setoption", "name"] and len(words) >= 3 and words[2] == "UCI_Variant":
                    value = words[words.index("value") + 1] if "value" in words and words.index("value") + 1 < len(words) else "<missing>"
                    if value != "xiangqi":
                        diagnostic = f"info string unsupported variant {value}"
                        print(diagnostic, flush=True)
                        self.record("bridge_to_gui", diagnostic)
                    elif self.inject_variant and not self.native_variant:
                        self.record("bridge", line, "consumed fixed variant option for fixed-variant engine")
                    else:
                        self.forward(line)
                    continue
                self.forward(inbound(line))
                if line == "quit":
                    break
        finally:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        return self.process.returncode or 0

    def forward(self, translated):
        assert self.process.stdin is not None
        self.record("bridge_to_engine", translated)
        self.process.stdin.write(translated + "\n")
        self.process.stdin.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--inject-variant", action="store_true")
    args = parser.parse_args()
    return Bridge(args.engine, args.log, args.inject_variant).run()


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Collect reproducible CPU-only UCI evidence from an external Xiangqi engine."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


class UciTimeout(RuntimeError):
    pass


class UciProtocolError(RuntimeError):
    pass


class UciClient:
    def __init__(self, executable: Path, working_directory: Path, timeout: float):
        self.executable = executable
        self.working_directory = working_directory
        self.timeout = timeout
        self.process = subprocess.Popen(
            [str(executable)], cwd=working_directory, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.events: queue.Queue[tuple[str, str | None]] = queue.Queue()
        self.stdin: list[str] = []
        self.stdout: list[str] = []
        self.stderr: list[str] = []
        threading.Thread(target=self._read_stream, args=("stdout", self.process.stdout, self.stdout), daemon=True).start()
        threading.Thread(target=self._read_stream, args=("stderr", self.process.stderr, self.stderr), daemon=True).start()
        try:
            self.send("uci")
            handshake = self.until(lambda line: line == "uciok")
            self.handshake_lines = handshake
            self.options = [line for line in handshake if line.startswith("option ")]
            thread_option = next((line for line in self.options if re.search(r"\bname Threads\b", line)), None)
            if thread_option is None or not re.search(r"\btype spin\b", thread_option):
                raise UciProtocolError("engine does not advertise a spin Threads option")
            minimum = re.search(r"\bmin (\d+)\b", thread_option)
            maximum = re.search(r"\bmax (\d+)\b", thread_option)
            if (minimum and int(minimum.group(1)) > 1) or (maximum and int(maximum.group(1)) < 1):
                raise UciProtocolError("engine Threads option does not allow one thread")
            self.send("setoption name Threads value 1")
            self.send("isready")
            self.until(lambda line: line == "readyok")
            self.name = self._id_value("name")
            self.author = self._id_value("author")
        except (UciProtocolError, UciTimeout, OSError):
            self.close()
            raise

    def _read_stream(self, name: str, stream, destination: list[str]) -> None:
        try:
            for raw in stream:
                line = raw.rstrip("\r\n")
                destination.append(line)
                self.events.put((name, line))
        finally:
            self.events.put((name, None))

    def _id_value(self, key: str) -> str | None:
        prefix = f"id {key} "
        return next((line[len(prefix):] for line in self.handshake_lines if line.startswith(prefix)), None)

    def send(self, command: str) -> None:
        if self.process.poll() is not None or self.process.stdin is None:
            raise UciProtocolError("engine process is not running")
        self.stdin.append(command)
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()

    def until(self, predicate, timeout: float | None = None) -> list[str]:
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        lines = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise UciTimeout("timed out waiting for UCI response")
            try:
                stream, line = self.events.get(timeout=remaining)
            except queue.Empty as error:
                raise UciTimeout("timed out waiting for UCI response") from error
            if line is None:
                if stream == "stdout":
                    raise UciProtocolError("engine closed stdout before terminator")
                continue
            if stream == "stdout":
                lines.append(line)
                if predicate(line):
                    return lines

    def command_until(self, command: str, predicate, timeout: float | None = None) -> list[str]:
        self.send(command)
        return self.until(predicate, timeout)

    def raw_io(self) -> dict:
        return {"stdin": list(self.stdin), "stdout": list(self.stdout), "stderr": list(self.stderr)}

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.send("quit")
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def network_files(options: list[str], workdir: Path) -> list[dict]:
    """Hash configured external network files when their paths are locally resolvable."""
    files = []
    for option in options:
        match = re.match(r"option name (?:EvalFile|EvalFileSmall) type string default (.+)$", option)
        if not match:
            continue
        configured = match.group(1)
        path = Path(configured)
        resolved = path if path.is_absolute() else workdir / path
        item = {"configured_path": configured, "resolved_path": str(resolved.resolve())}
        if resolved.is_file():
            item["sha256"] = sha256(resolved)
            item["exists"] = True
        else:
            item["sha256"] = None
            item["exists"] = False
        files.append(item)
    return files


def parse_search(lines: list[str]) -> dict:
    info = []
    for line in lines:
        if not line.startswith("info "):
            continue
        words = line.split()
        item = {"raw": line}
        for key in ("depth", "seldepth", "multipv", "nodes"):
            if key in words:
                try:
                    item[key] = int(words[words.index(key) + 1])
                except (ValueError, IndexError):
                    pass
        if "score" in words:
            index = words.index("score")
            if index + 2 < len(words):
                item["score"] = {"kind": words[index + 1], "value": words[index + 2]}
        if "pv" in words:
            item["pv"] = words[words.index("pv") + 1:]
        info.append(item)
    best = next((line.split()[1] for line in reversed(lines) if line.startswith("bestmove ")), None)
    return {"info": info, "bestmove": best, "raw": lines}


def parse_perft(lines: list[str], include_root_moves: bool) -> dict:
    total = next((int(match.group(1)) for line in reversed(lines)
                  if (match := re.fullmatch(r"Nodes searched: (\d+)", line))), None)
    roots = sorted(match.group(1) for line in lines
                   if (match := re.fullmatch(r"([a-i][0-9][a-i][0-9]): \d+", line)))
    if total is None:
        raise UciProtocolError("go perft output omitted Nodes searched")
    return {"nodes": total, "root_moves": roots if include_root_moves else None, "raw": lines}


def search_position(client: UciClient, fen: str, command: str) -> dict:
    client.send(f"position fen {fen}")
    client.send("ucinewgame")
    client.send("isready")
    client.until(lambda line: line == "readyok")
    lines = client.command_until(command, lambda line: line.startswith("bestmove "))
    return parse_search(lines)


def evaluate_candidate(client: UciClient, candidate: dict, nodes: int, depth: int, timeout: float,
                       root_move_cap: int | None, perft_only: bool = False) -> dict:
    fen = candidate["fen"]
    perft = {}
    for ply in (1, 2, 3):
        client.send(f"position fen {fen}")
        lines = client.command_until(f"go perft {ply}", lambda line: line.startswith("Nodes searched:"), timeout)
        perft[str(ply)] = parse_perft(lines, include_root_moves=(ply == 1))
    root_moves = perft["1"]["root_moves"]
    if root_moves is None:
        raise UciProtocolError("depth-one perft output did not provide the root legal move set")
    if perft_only:
        return {
            "id": candidate["id"],
            "source_url": candidate.get("source_url"),
            "source_page_sha256": candidate.get("source_page_sha256"),
            "fen": fen,
            "mate_in_attacker_moves": candidate["mate_in_attacker_moves"],
            "claimed_first_move": candidate["claimed_first_move"],
            "claimed_first_move_legal": candidate["claimed_first_move"] in root_moves,
            "perft_only": True,
            "search_results_are_not_proofs": True,
            "perft": perft,
            "searched_root_moves": [],
            "all_root_moves_searched": False,
            "depth_search": None,
            "nodes_search": None,
            "root_searches": {},
        }
    multipv_option = next((line for line in client.options if re.search(r"\bname MultiPV\b", line)), None)
    max_multipv = int(re.search(r"\bmax (\d+)\b", multipv_option).group(1)) if multipv_option and re.search(r"\bmax (\d+)\b", multipv_option) else 1
    multipv = min(5, max(1, max_multipv))
    client.send(f"setoption name MultiPV value {multipv}")
    depth_search = search_position(client, fen, f"go depth {depth}")
    nodes_search = search_position(client, fen, f"go nodes {nodes}")
    searches = root_moves if root_move_cap is None else root_moves[:root_move_cap]
    root_searches = {}
    for movement in searches:
        root_searches[movement] = search_position(
            client, fen, f"go nodes {nodes} searchmoves {movement}"
        )
    return {
        "id": candidate["id"],
        "source_url": candidate.get("source_url"),
        "source_page_sha256": candidate.get("source_page_sha256"),
        "fen": fen,
        "mate_in_attacker_moves": candidate["mate_in_attacker_moves"],
        "claimed_first_move": candidate["claimed_first_move"],
        "claimed_first_move_legal": candidate["claimed_first_move"] in root_moves,
        "search_results_are_not_proofs": True,
        "perft": perft,
        "searched_root_moves": searches,
        "all_root_moves_searched": len(searches) == len(root_moves),
        "depth_search": depth_search,
        "nodes_search": nodes_search,
        "root_searches": root_searches,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True, help="external UCI executable path; no arguments are accepted")
    parser.add_argument("--working-directory", type=Path, help="engine working directory, defaults to executable parent")
    parser.add_argument("--manifest", type=Path, required=True, help="candidate puzzle JSON manifest")
    parser.add_argument("--output", type=Path, required=True, help="directory for metadata, per-puzzle raw I/O, and summary")
    parser.add_argument("--nodes", type=int, default=50_000)
    parser.add_argument("--depth", type=int, default=6)
    parser.add_argument("--timeout-seconds", type=float, default=30)
    parser.add_argument("--root-move-cap", type=int, help="optional cap for exploratory runs; default checks every legal root move")
    parser.add_argument("--perft-only", action="store_true",
                        help="screen engine compatibility with perft 1-3 without running search")
    args = parser.parse_args()
    engine = args.engine.resolve()
    workdir = (args.working_directory or engine.parent).resolve()
    if not engine.is_file() or not os.access(engine, os.X_OK):
        parser.error("engine must be an executable file")
    if not workdir.is_dir() or args.nodes < 1 or args.depth < 1 or args.timeout_seconds <= 0:
        parser.error("working directory, nodes, depth, and timeout must be valid and positive")
    if args.root_move_cap is not None and args.root_move_cap < 1:
        parser.error("root-move-cap must be positive")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    candidates = manifest.get("selected")
    if not isinstance(candidates, list) or not candidates:
        parser.error("manifest must contain a non-empty selected array")
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "raw").mkdir(exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    base_meta = {
        "started_at_utc": started,
        "engine_path": str(engine),
        "engine_sha256": sha256(engine),
        "working_directory": str(workdir),
        "manifest_sha256": sha256(args.manifest),
        "settings": {"threads": 1, "nodes_per_search": args.nodes, "depth_limit_plies": args.depth,
                     "timeout_seconds": args.timeout_seconds, "root_move_cap": args.root_move_cap},
    }
    client = None
    records = []
    setup_error = None
    try:
        client = UciClient(engine, workdir, args.timeout_seconds)
        base_meta.update({"engine_name": client.name, "engine_author": client.author,
                          "uci_options": client.options, "handshake": client.handshake_lines,
                          "network_files": network_files(client.options, workdir)})
        (args.output / "engine.json").write_text(json.dumps(base_meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        for candidate in candidates:
            if client is None:
                try:
                    client = UciClient(engine, workdir, args.timeout_seconds)
                    base_meta.update({"engine_name": client.name, "engine_author": client.author,
                                      "uci_options": client.options, "handshake": client.handshake_lines,
                                      "network_files": network_files(client.options, workdir)})
                except (OSError, UciTimeout, UciProtocolError) as error:
                    record = {"id": candidate.get("id"), "run_status": "protocol_error",
                              "error": f"engine restart failed: {error}", "raw_io": {}}
                    records.append(record)
                    (args.output / "raw" / f"{candidate.get('id', 'unknown')}.json").write_text(
                        json.dumps(record["raw_io"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                    if not args.perft_only:
                        break
                    continue
            before = {key: len(getattr(client, key)) for key in ("stdin", "stdout", "stderr")}
            record = {"run_status": "complete"}
            try:
                record.update(evaluate_candidate(client, candidate, args.nodes, args.depth,
                                                 args.timeout_seconds, args.root_move_cap, args.perft_only))
            except UciTimeout as error:
                record = {"id": candidate.get("id"), "run_status": "timeout", "error": str(error)}
            except (OSError, KeyError, TypeError, UciProtocolError) as error:
                record = {"id": candidate.get("id"), "run_status": "protocol_error", "error": str(error)}
            if client is not None:
                for stream in ("stdin", "stdout", "stderr"):
                    record.setdefault("raw_io", {})[stream] = getattr(client, stream)[before[stream]:]
                record.update({"engine_name": client.name, "engine_author": client.author,
                               "search_results_are_not_proofs": True})
            records.append(record)
            raw_path = args.output / "raw" / f"{candidate.get('id', 'unknown')}.json"
            raw = record.get("raw_io", {})
            raw_path.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            if record["run_status"] != "complete":
                if client is not None:
                    client.close()
                    client = None
                if not args.perft_only:
                    break
    except (OSError, UciTimeout, UciProtocolError) as error:
        setup_error = str(error)
        if client is not None:
            records.append({"run_status": "setup_error", "error": setup_error, "raw_io": client.raw_io()})
    finally:
        if client is not None:
            client.close()
            base_meta.update({"engine_name": client.name, "engine_author": client.author,
                              "uci_options": client.options, "raw_io": client.raw_io()})
        (args.output / "engine.json").write_text(json.dumps(base_meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    attempted = len(records)
    summary = {"attempted": attempted, "requested": len(candidates),
               "statuses": dict(Counter(record["run_status"] for record in records)),
               "setup_error": setup_error, "engine_sha256": base_meta["engine_sha256"],
               "manifest_sha256": base_meta["manifest_sha256"], "settings": base_meta["settings"]}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (args.output / "results.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in records), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0 if all(row["run_status"] == "complete" for row in records) and len(records) == len(candidates) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)

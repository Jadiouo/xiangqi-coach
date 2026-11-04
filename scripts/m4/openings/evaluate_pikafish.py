#!/usr/bin/env python3
"""Score unique opening positions with a fixed, provenance-checked Pikafish UCI run."""

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
from pathlib import Path


EXPECTED_ENGINE = "Pikafish 2026-09-06"
EXPECTED_BINARY_SHA256 = "727828293830de8082a80b224bf47b32700c2d1a441908ea11b3c9197178c20c"
EXPECTED_NNUE_SHA256 = "7d13d73569a9b571ba0eb20cf1596247bc2a42738967e61afef6482b231e900e"
REQUESTED_NODES = 100_000
CP_THRESHOLD = 100
MOVE_RE = re.compile(r"^[a-i][0-9][a-i][0-9]$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class UciProcess:
    def __init__(self, engine: Path, timeout: float, expected_name: str, session_log: Path):
        self.engine = engine
        self.timeout = timeout
        self.expected_name = expected_name
        self.session_log = session_log
        self.process = subprocess.Popen(
            [str(engine)],
            cwd=engine.parent,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.lines = queue.Queue()
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader.start()
        self._send("uci")
        handshake = self._until("uciok", self.timeout)
        engine_names = [line[8:] for line in handshake if line.startswith("id name ")]
        if not engine_names or engine_names[0] != expected_name:
            self.close(force=True)
            raise RuntimeError(f"unexpected UCI engine name: {engine_names!r}")
        self.engine_name = engine_names[0]
        self._send("setoption name Threads value 1")
        self._send("setoption name Hash value 64")
        self._send("setoption name MultiPV value 1")
        self._ready(self.timeout)
        with session_log.open("a", encoding="utf-8") as log:
            log.write("\n".join(["<< " + line for line in handshake]) + "\n")
            log.write("<< id name " + self.engine_name + "\n")
            log.write(">> setoption name Threads value 1\n>> setoption name Hash value 64\n>> setoption name MultiPV value 1\n")

    def _read_stdout(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip("\n"))
        self.lines.put(None)

    def _send(self, command: str):
        if self.process.poll() is not None:
            raise RuntimeError("UCI process exited")
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()

    def _until(self, sentinel: str, timeout: float) -> list[str]:
        deadline = time.monotonic() + timeout
        received = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for {sentinel}")
            try:
                line = self.lines.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError(f"timed out waiting for {sentinel}") from error
            if line is None:
                raise RuntimeError("UCI process closed stdout")
            received.append(line)
            if sentinel in line:
                return received

    def _ready(self, timeout: float):
        self._send("isready")
        self._until("readyok", timeout)

    def search(self, fen: str, timeout: float) -> tuple[list[str], str | None]:
        lines = []
        try:
            for command in (
                "ucinewgame",
                "setoption name Clear Hash",
            ):
                self._send(command)
                lines.append(">> " + command)
            self._send("isready")
            lines.append(">> isready")
            lines.extend("<< " + line for line in self._until("readyok", timeout))
            self._send("position fen " + fen)
            lines.append(">> position fen " + fen)
            self._send(f"go nodes {REQUESTED_NODES}")
            lines.append(f">> go nodes {REQUESTED_NODES}")
            lines.extend("<< " + line for line in self._until("bestmove", timeout))
            return lines, None
        except TimeoutError as error:
            lines.append(f"!! {error}")
            self.close(force=True)
            return lines, "timeout"

    def close(self, force: bool = False):
        if self.process.poll() is None:
            if not force:
                try:
                    self._send("quit")
                    self.process.wait(timeout=2)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    self.process.kill()
                    self.process.wait(timeout=2)
            else:
                self.process.kill()
                self.process.wait(timeout=2)


def info_fields(line: str) -> dict | None:
    if line.startswith("<< "):
        line = line[3:]
    parts = line.split()
    if len(parts) < 5 or parts[0] != "info" or "depth" not in parts or "score" not in parts:
        return None
    try:
        depth = int(parts[parts.index("depth") + 1])
        score_index = parts.index("score")
        score_type = parts[score_index + 1]
        score = int(parts[score_index + 2])
    except (ValueError, IndexError):
        return None
    multipv = 1
    if "multipv" in parts:
        try:
            multipv = int(parts[parts.index("multipv") + 1])
        except (ValueError, IndexError):
            return None
    if "nodes" in parts:
        try:
            nodes = int(parts[parts.index("nodes") + 1])
        except (ValueError, IndexError):
            nodes = 0
    else:
        nodes = 0
    bound = next((flag for flag in ("lowerbound", "upperbound") if flag in parts), None)
    pv = []
    if "pv" in parts:
        pv = parts[parts.index("pv") + 1 :]
    return {
        "depth": depth,
        "score_type": score_type,
        "score": score,
        "nodes": nodes,
        "bound": bound,
        "multipv": multipv,
        "pv": pv,
    }


def score_lines(lines: list[str], red_to_move: bool, root_legal_moves: list[str] | None = None) -> dict:
    all_infos = [parsed for line in lines if (parsed := info_fields(line)) and parsed["multipv"] == 1]
    bestmove = None
    for line in lines:
        if line.startswith("<< bestmove "):
            parts = line.split()
            if len(parts) >= 3:
                bestmove = parts[2]
    latest = all_infos[-1] if all_infos else None
    exact_infos = [
        info for info in all_infos if info["score_type"] == "cp" and info["bound"] is None and info["pv"]
    ]
    earlier_exact = next(
        (info for info in reversed(all_infos[:-1]) if info["score_type"] == "cp" and info["bound"] is None and info["pv"]),
        None,
    )
    complete_score = bool(
        latest
        and latest["score_type"] == "cp"
        and latest["bound"] is None
        and latest["pv"]
    )
    if latest is None:
        reason = "unknown_no_score_info"
    elif latest["bound"] is not None:
        reason = "unknown_final_bound" if earlier_exact else "unknown_no_exact_score"
    elif latest["score_type"] == "mate":
        reason = "unknown_final_mate_score"
    elif not complete_score:
        reason = "unknown_incomplete_final_score"
    elif not bestmove or not MOVE_RE.fullmatch(bestmove):
        reason = (
            "engine_rejected_position"
            if root_legal_moves
            else "unknown_missing_or_invalid_bestmove"
        )
    elif not MOVE_RE.fullmatch(latest["pv"][0]):
        reason = "unknown_invalid_completed_iteration_pv"
    elif bestmove != latest["pv"][0]:
        reason = "unknown_bestmove_pv_mismatch"
    elif root_legal_moves is not None and bestmove not in root_legal_moves:
        reason = "engine_rejected_position"
    else:
        reason = "within_external_balance_threshold" if abs(latest["score"]) <= CP_THRESHOLD else "outside_external_balance_threshold"

    consistent = reason in (
        "within_external_balance_threshold",
        "outside_external_balance_threshold",
    )
    score_cp_stm = latest["score"] if consistent else None
    score_cp_red = (score_cp_stm if red_to_move else -score_cp_stm) if consistent else None
    depth = latest["depth"] if consistent else None
    score_nodes = latest["nodes"] if consistent else None
    bound = latest["bound"] if latest else None
    completed_iteration_bestmove = latest["pv"][0] if complete_score else None
    return {
        "score_cp_stm": score_cp_stm,
        "score_cp_red": score_cp_red,
        "depth": depth,
        "nodes": score_nodes,
        "bound": bound or "none",
        "bestmove": bestmove,
        "completed_iteration_bestmove": completed_iteration_bestmove,
        "completed_iteration_matches_bestmove": bool(bestmove and bestmove == completed_iteration_bestmove),
        "acceptance_reason": reason,
        "final_info": latest,
        "last_exact_score": exact_infos[-1] if exact_infos else None,
    }


def next_raw_log(log_dir: Path, key: str) -> Path:
    stem = hashlib.sha256(key.encode("utf-8")).hexdigest()
    path = log_dir / f"{stem}.log"
    attempt = 1
    while path.exists():
        attempt += 1
        path = log_dir / f"{stem}.attempt{attempt}.log"
    return path


def run(args) -> int:
    engine = args.engine.resolve()
    nnue = args.nnue.resolve()
    actual_binary_hash = sha256_file(engine)
    actual_nnue_hash = sha256_file(nnue)
    if actual_binary_hash != args.expected_binary_sha256:
        raise ValueError(f"Pikafish binary SHA-256 mismatch: {actual_binary_hash}")
    if actual_nnue_hash != args.expected_nnue_sha256:
        raise ValueError(f"Pikafish NNUE SHA-256 mismatch: {actual_nnue_hash}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.log_dir.mkdir(parents=True, exist_ok=True)
    session_log = args.log_dir / "engine-session.log"
    completed_keys = set()
    if args.output.exists():
        for line in args.output.read_text(encoding="utf-8").splitlines():
            if line.strip():
                completed_keys.add(json.loads(line)["position_key"])

    unique = {}
    for line in args.input.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("validation", {}).get("duplicate"):
            continue
        unique.setdefault(row["position_key"], row)

    engine_process = None
    done = 0
    rejected_position = False
    with args.output.open("a", encoding="utf-8", newline="\n") as output:
        for key, row in unique.items():
            if key in completed_keys:
                continue
            raw_path = next_raw_log(args.log_dir, key)
            transcript = [
                f"# opening_id={row['opening_id']}",
                f"# position_key={key}",
                f"# binary_sha256={actual_binary_hash}",
                f"# nnue_sha256={actual_nnue_hash}",
                f"# options=Threads:1,Hash:64,MultiPV:1,nodes:{REQUESTED_NODES},clear_hash_per_position:true",
                f"# fen={row['fen']}",
            ]
            engine_name = args.expected_engine_name
            timeout_reason = None
            if engine_process is None or engine_process.process.poll() is not None:
                engine_process = UciProcess(engine, args.timeout, args.expected_engine_name, session_log)
                engine_name = engine_process.engine_name
            lines, timeout_reason = engine_process.search(row["fen"], args.timeout)
            transcript.extend(lines)
            if timeout_reason:
                engine_process = None
            result = score_lines(lines, row["red_to_move_after_cutoff"], row.get("root_legal_moves"))
            if timeout_reason:
                result["acceptance_reason"] = "unknown_engine_timeout"
            raw_path.write_text("\n".join(transcript) + "\n", encoding="utf-8")
            raw_hash = sha256_file(raw_path)
            raw_ref = os.path.relpath(raw_path, Path.cwd())
            row["reference_balance"] = {
                "engine": engine_name,
                "binary_sha256": actual_binary_hash,
                "nnue_sha256": actual_nnue_hash,
                "options": {
                    "Threads": 1,
                    "Hash": 64,
                    "MultiPV": 1,
                    "go_nodes": REQUESTED_NODES,
                    "clear_hash_per_position": True,
                },
                "depth": result["depth"],
                "nodes": result["nodes"],
                "requested_nodes": REQUESTED_NODES,
                "score_cp_stm": result["score_cp_stm"],
                "score_cp_red": result["score_cp_red"],
                "bound": result["bound"],
                "bestmove": result["bestmove"],
                "completed_iteration_bestmove": result["completed_iteration_bestmove"],
                "completed_iteration_matches_bestmove": result["completed_iteration_matches_bestmove"],
                "final_info": result["final_info"],
                "last_exact_score": result["last_exact_score"],
                "raw_log_path": raw_ref,
                "raw_log_sha256": raw_hash,
            }
            row["validation"]["balanced"] = (
                None
                if result["acceptance_reason"].startswith("unknown_")
                or result["acceptance_reason"] == "engine_rejected_position"
                else result["acceptance_reason"] == "within_external_balance_threshold"
            )
            row["validation"]["acceptance_reason"] = result["acceptance_reason"]
            row["validation"]["balance_threshold_cp"] = CP_THRESHOLD
            json.dump(row, output, ensure_ascii=False, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            completed_keys.add(key)
            done += 1
            print(f"scored {done}; current={row['opening_id']} reason={result['acceptance_reason']}", file=sys.stderr, flush=True)
            if result["acceptance_reason"] == "engine_rejected_position":
                rejected_position = True
                break
    if engine_process is not None:
        engine_process.close()
    print(f"unique positions scored in this run: {done}; total checkpoint positions: {len(completed_keys)}", file=sys.stderr)
    return 2 if rejected_position else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--log-dir", required=True, type=Path)
    parser.add_argument("--engine", required=True, type=Path)
    parser.add_argument("--nnue", required=True, type=Path)
    parser.add_argument("--expected-binary-sha256", required=True)
    parser.add_argument("--expected-nnue-sha256", required=True)
    parser.add_argument("--expected-engine-name", default=EXPECTED_ENGINE)
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()
    try:
        return run(args)
    except (OSError, ValueError, RuntimeError, TimeoutError, json.JSONDecodeError) as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

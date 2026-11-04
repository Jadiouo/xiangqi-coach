#!/usr/bin/env python3
"""Paired, fixed-node UCI engine matches over a frozen ICCS opening set."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import platform
import queue
import random
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO


FROZEN_SELECTION = {
    "eligible_population_sha256": "5e5d3595f9f08ad9fc10fe791de31454e73c726501cdc0c33d2a7c31a777e86e",
    "selected_population_sha256": "09225f85a6b906aa66baa0aa095c4b4b88f7aa420e63cded286ab92988ddbcee",
    "runner_tsv_sha256": "2052a3f47ad38b5b2d7dc72004ea21faccc62df8a3dfccb0ce0f86a2fdf4cf88",
    "sampling_seed_u64": 1328726801112436425,
}


class MatchProtocolError(RuntimeError):
    def __init__(self, message: str, raw_lines: list[str]):
        super().__init__(message)
        self.raw_lines = raw_lines


@dataclass
class UciEngine:
    command: list[str]
    process: subprocess.Popen[str]
    output: queue.Queue[str | None]
    timeout_seconds: float
    stderr_tail: deque[str]
    log_handle: TextIO | None
    log_lock: threading.Lock
    readers: list[threading.Thread]
    advertised_options: set[str]
    last_response_lines: list[str]

    @classmethod
    def start(
        cls, command: str, *, timeout_seconds: float = 30.0, log_path: Path | None = None
    ) -> "UciEngine":
        if timeout_seconds <= 0:
            raise ValueError("engine timeout must be positive")
        process = subprocess.Popen(shlex.split(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, bufsize=1)
        log_handle = None
        try:
            if log_path is not None:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_handle = log_path.open("a", encoding="utf-8")
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
            raise
        engine = cls(shlex.split(command), process, queue.Queue(), timeout_seconds,
                     deque(maxlen=30), log_handle, threading.Lock(), [], set(), [])

        def read_stream(stream: TextIO, channel: str, output: bool) -> None:
            for raw in stream:
                line = raw.rstrip("\r\n")
                with engine.log_lock:
                    if channel == "stderr":
                        engine.stderr_tail.append(line)
                    if engine.log_handle is not None:
                        engine.log_handle.write(f"{channel}: {line}\n")
                        engine.log_handle.flush()
                if output:
                    engine.output.put(line)
            if output:
                engine.output.put(None)

        for stream, channel, is_output in (
            (process.stdout, "stdout", True), (process.stderr, "stderr", False)
        ):
            assert stream is not None
            reader = threading.Thread(target=read_stream, args=(stream, channel, is_output), daemon=True)
            reader.start()
            engine.readers.append(reader)
        try:
            engine.send("uci")
            while True:
                line = engine.until(lambda item: item == "uciok" or item.startswith("option name "))
                if line == "uciok":
                    break
                match = re.match(r"option name (.+?) type ", line)
                if match:
                    engine.advertised_options.add(match.group(1))
            engine.send("isready")
            engine.until(lambda line: line == "readyok")
            return engine
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            engine._finish_log()
            raise

    def send(self, line: str) -> None:
        assert self.process.stdin is not None
        with self.log_lock:
            if self.log_handle is not None:
                self.log_handle.write(f"stdin: {line}\n")
                self.log_handle.flush()
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def configure(self, options: dict[str, str]) -> None:
        unsupported = sorted(set(options) - self.advertised_options)
        if unsupported:
            raise ValueError(f"UCI option(s) not advertised by engine: {', '.join(unsupported)}")
        for name, value in sorted(options.items()):
            if not name or any(character in name for character in "\r\n") or any(character in value for character in "\r\n"):
                raise ValueError("UCI option names and values must be single lines")
            self.send(f"setoption name {name} value {value}")
        if options:
            self.send("isready")
            self.until(lambda line: line == "readyok")

    def log_context(self, game_id: str, actor: str, decision_index: int) -> None:
        """Mark the next raw UCI exchange without sending non-UCI text to the engine."""
        with self.log_lock:
            if self.log_handle is not None:
                self.log_handle.write(
                    f"context: game_id={game_id} actor={actor} decision_index={decision_index}\n"
                )
                self.log_handle.flush()

    def until(self, predicate, timeout_seconds: float | None = None):
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                detail = " | ".join(self.stderr_tail)
                raise TimeoutError(f"engine response timed out after {timeout}s: {self.command}; stderr: {detail}")
            try:
                line = self.output.get(timeout=remaining)
            except queue.Empty:
                detail = " | ".join(self.stderr_tail)
                raise TimeoutError(f"engine response timed out after {timeout}s: {self.command}; stderr: {detail}")
            if line is None:
                raise RuntimeError(f"engine exited while waiting: {self.command}; stderr: {' | '.join(self.stderr_tail)}")
            if predicate(line):
                return line

    def bestmove(self, moves: list[str], nodes: int, strategy: str, seed: int) -> tuple[str, str | None]:
        self.send(f"setoption name Strategy value {strategy}")
        self.send(f"setoption name RandomSeed value {seed}")
        self.send("position startpos moves " + " ".join(moves))
        self.send(f"go nodes {nodes}")
        outcome = None
        unknown_outcome = None
        raw_lines = []
        self.last_response_lines = raw_lines
        while True:
            line = self.until(lambda item: item.startswith("bestmove ") or item.startswith("info string outcome ") or item.startswith("info string position error:"))
            raw_lines.append(line)
            if line.startswith("info string position error:"):
                raise MatchProtocolError(f"engine rejected move sequence: {line}", raw_lines)
            if line.startswith("info string outcome "):
                outcome = line.removeprefix("info string outcome ")
                if outcome not in {"red", "black", "draw"}:
                    unknown_outcome = outcome
                continue
            move = line.split()[1]
            if unknown_outcome is not None:
                raise MatchProtocolError(f"unknown engine outcome: {unknown_outcome}", raw_lines)
            if outcome is not None and move != "0000":
                raise MatchProtocolError("terminal outcome with non-null bestmove", raw_lines)
            if move == "0000" and outcome is None:
                raise MatchProtocolError("bestmove 0000 without a known terminal outcome", raw_lines)
            return move, outcome

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.send("quit")
                self.process.wait(timeout=2)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        self._finish_log()

    def _finish_log(self) -> None:
        for reader in self.readers:
            reader.join(timeout=0.2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None and not stream.closed:
                stream.close()
        if self.log_handle is not None and not self.log_handle.closed:
            self.log_handle.close()


def elo(score: float) -> float:
    if score <= 0:
        return "-infinity"
    if score >= 1:
        return "+infinity"
    return 400 * math.log10(score / (1 - score))


def opening_score(wdl: dict[str, int]) -> float:
    total = sum(wdl.values())
    return (wdl["win"] + 0.5 * wdl["draw"]) / total if total else 0.5


def terminal_result_for_a(outcome: str, a_is_red: bool) -> str:
    if outcome == "draw":
        return "draw"
    if outcome not in {"red", "black"}:
        raise ValueError(f"unknown terminal outcome: {outcome}")
    return "win" if (outcome == "red") == a_is_red else "loss"


def stable_game_id(global_round: int, opening_id: str, a_is_red: bool) -> str:
    color = "red" if a_is_red else "black"
    return f"round-{global_round:02d}/{opening_id}/A-{color}"


def stable_seed(master_seed: int, game_id: str, decision_index: int = 0) -> int:
    material = f"xiangqi-m4-match-v1\0{master_seed}\0{game_id}\0{decision_index}".encode()
    return int.from_bytes(hashlib.sha256(material).digest()[:8], "big")


def verify_batch_games(
    games: list[dict], opening_ids: list[str], global_rounds, nodes_per_move: int,
    master_seed: int = 123, opening_data: dict[str, dict] | None = None,
    max_ply: int | None = None,
) -> dict:
    global_rounds = list(global_rounds)
    expected = {
        stable_game_id(round_number, opening_id, a_is_red): (round_number, opening_id, a_is_red)
        for round_number in global_rounds
        for opening_id in opening_ids
        for a_is_red in (True, False)
    }
    seen = set()
    errors = []
    for index, game in enumerate(games):
        game_id = game.get("game_id")
        if game_id not in expected:
            errors.append(f"unexpected_game_id:{index}:{game_id}")
            continue
        if game_id in seen:
            errors.append(f"duplicate_game_id:{game_id}")
            continue
        seen.add(game_id)
        round_number, opening_id, a_is_red = expected[game_id]
        if (game.get("global_round"), game.get("opening_id"), game.get("a_is_red")) != (round_number, opening_id, a_is_red):
            errors.append(f"identity_mismatch:{game_id}")
        if game.get("nodes") != nodes_per_move:
            errors.append(f"nodes_mismatch:{game_id}")
        if game.get("seed") != stable_seed(master_seed, game_id):
            errors.append(f"seed_mismatch:{game_id}")
        if game.get("result_for_a") not in {"win", "draw", "loss"}:
            errors.append(f"unfinished_game:{game_id}")
        if game.get("protocol_error"):
            errors.append(f"protocol_error:{game_id}")
        if game.get("unfinished_reason") not in (None, ""):
            errors.append(f"unfinished_reason:{game_id}")
        opening = (opening_data or {}).get(opening_id)
        if opening is not None:
            prefix = opening["prefix"]
            if game.get("source") != opening["source"] or game.get("prefix") != prefix:
                errors.append(f"opening_provenance_mismatch:{game_id}")
            moves = game.get("moves")
            if not isinstance(moves, list) or moves[:len(prefix)] != prefix:
                errors.append(f"move_prefix_mismatch:{game_id}")
            else:
                played_plies = len(moves) - len(prefix)
                if max_ply is not None and played_plies > max_ply:
                    errors.append(f"max_ply_exceeded:{game_id}")
                seeds = game.get("decision_seeds")
                expected_seed_count = played_plies + 1
                if not isinstance(seeds, list) or len(seeds) != expected_seed_count:
                    errors.append(f"decision_seed_count_mismatch:{game_id}")
                elif any(seed != stable_seed(master_seed, game_id, index) for index, seed in enumerate(seeds)):
                    errors.append(f"decision_seed_mismatch:{game_id}")
            terminal_outcome = game.get("terminal_outcome")
            try:
                expected_result = terminal_result_for_a(terminal_outcome, a_is_red)
            except (ValueError, TypeError):
                errors.append(f"terminal_outcome_missing:{game_id}")
            else:
                if game.get("result_for_a") != expected_result:
                    errors.append(f"terminal_result_mismatch:{game_id}")
                expected_winner = None if expected_result == "draw" else ("A" if expected_result == "win" else "B")
                if game.get("winner") != expected_winner:
                    errors.append(f"winner_mismatch:{game_id}")
                raw_terminal = game.get("terminal_raw")
                if (not isinstance(raw_terminal, list)
                    or f"info string outcome {terminal_outcome}" not in raw_terminal
                    or "bestmove 0000" not in raw_terminal):
                    errors.append(f"terminal_evidence_missing:{game_id}")
    missing = sorted(set(expected) - seen)
    if missing:
        errors.append(f"missing_games:{len(missing)}")
    return {"complete": not errors, "expected_games": len(expected), "observed_games": len(games),
            "opening_count": len(opening_ids), "round_count": len(list(global_rounds)),
            "errors": errors, "unique_game_ids": len(seen)}


def play_game(
    *, game_id: str, global_round: int, opening: dict, a_is_red: bool,
    engine_a: UciEngine, engine_b: UciEngine, args,
) -> dict:
    sequence = list(opening["moves"])
    decision_seeds = []
    game_result = "unfinished"
    winner = None
    terminal_outcome = None
    terminal_raw = []
    protocol_error = None
    raw_response = []
    while len(sequence) - len(opening["moves"]) < args.max_ply:
        red_to_move = len(sequence) % 2 == 0
        mover_is_a = red_to_move == a_is_red
        engine = engine_a if mover_is_a else engine_b
        actor = "A" if mover_is_a else "B"
        strategy = args.strategy_a if mover_is_a else args.strategy_b
        decision_index = len(decision_seeds)
        decision_seed = stable_seed(args.seed, game_id, decision_index)
        decision_seeds.append(decision_seed)
        engine.log_context(game_id, actor, decision_index)
        try:
            move, outcome = engine.bestmove(sequence, args.nodes, strategy, decision_seed)
        except (MatchProtocolError, TimeoutError, RuntimeError) as error:
            protocol_error = str(error)
            raw_response = getattr(error, "raw_lines", [])
            break
        if move == "0000":
            terminal_outcome = outcome
            terminal_raw = list(engine.last_response_lines)
            game_result = terminal_result_for_a(outcome, a_is_red)
            if game_result != "draw":
                winner = "A" if game_result == "win" else "B"
            break
        sequence.append(move)
    return {
        "game_id": game_id, "global_round": global_round, "round": global_round,
        "opening_id": opening["id"], "source": opening["source"],
        "a_is_red": a_is_red, "nodes": args.nodes, "max_ply": args.max_ply,
        "master_seed": args.seed, "seed": stable_seed(args.seed, game_id),
        "decision_seeds": decision_seeds, "prefix": opening["moves"], "moves": sequence,
        "result_for_a": game_result, "winner": winner,
        "terminal_outcome": terminal_outcome, "terminal_raw": terminal_raw,
        "unfinished_reason": protocol_error or ("max_ply" if game_result == "unfinished" else None),
        "protocol_error": protocol_error, "raw_response": raw_response,
    }


def run_worker(
    worker_id: int, jobs: list[tuple[int, dict, bool]], *, args, engine_a_options: dict,
    engine_b_options: dict, events: queue.Queue,
) -> None:
    engine_a = engine_b = None
    failure = None
    if args.workers == 1:
        log_a = args.output / "engine-a.log"
        log_b = args.output / "engine-b.log"
    else:
        worker_dir = args.output / "workers" / f"worker-{worker_id:02d}"
        log_a = worker_dir / "engine-a.log"
        log_b = worker_dir / "engine-b.log"
    try:
        engine_a = UciEngine.start(args.engine_a, timeout_seconds=args.engine_timeout, log_path=log_a)
        engine_b = UciEngine.start(args.engine_b, timeout_seconds=args.engine_timeout, log_path=log_b)
        engine_a.configure(engine_a_options)
        engine_b.configure(engine_b_options)
        for global_round, opening, a_is_red in jobs:
            game_id = stable_game_id(global_round, opening["id"], a_is_red)
            events.put(("game", worker_id, play_game(
                game_id=game_id, global_round=global_round, opening=opening,
                a_is_red=a_is_red, engine_a=engine_a, engine_b=engine_b, args=args,
            )))
    except Exception as error:
        failure = f"worker {worker_id} failed: {type(error).__name__}: {error}"
    finally:
        for engine in (engine_b, engine_a):
            if engine is not None:
                try:
                    engine.close()
                except Exception as error:
                    failure = failure or f"worker {worker_id} cleanup failed: {type(error).__name__}: {error}"
        events.put(("worker_done", worker_id, failure))


def run_games_in_workers(
    *, openings: list[dict], global_rounds, args, engine_a_options: dict, engine_b_options: dict,
    games_path: Path,
) -> tuple[int, dict[str, int], dict[tuple[int, str], dict[str, str]]]:
    jobs = [
        (global_round, opening, a_is_red)
        for global_round in global_rounds
        for opening in openings
        for a_is_red in (True, False)
    ]
    partitions = [jobs[index::args.workers] for index in range(args.workers)]
    events: queue.Queue = queue.Queue()
    games_written = 0
    totals = {"win": 0, "draw": 0, "loss": 0, "unfinished": 0}
    pair_results: dict[tuple[int, str], dict[str, str]] = {}
    failures = []
    finished_workers = 0
    with games_path.open("a", encoding="utf-8") as games_handle:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = [executor.submit(
                run_worker, worker_id, partition, args=args,
                engine_a_options=engine_a_options, engine_b_options=engine_b_options,
                events=events,
            ) for worker_id, partition in enumerate(partitions, start=1)]
            while finished_workers < args.workers:
                kind, worker_id, payload = events.get()
                if kind == "game":
                    games_written += 1
                    result = payload["result_for_a"]
                    if result in {"win", "draw", "loss"}:
                        totals[result] += 1
                        pair_results.setdefault((payload["global_round"], payload["opening_id"]), {})[
                            "red" if payload["a_is_red"] else "black"
                        ] = result
                    else:
                        totals["unfinished"] += 1
                    games_handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
                    games_handle.flush()
                    os.fsync(games_handle.fileno())
                else:
                    finished_workers += 1
                    if payload:
                        failures.append(payload)
            for future in futures:
                future.result()
    if failures:
        raise RuntimeError("; ".join(failures))
    return games_written, totals, pair_results


def bounded_mean_interval(
    scores: list[float], alpha: float, population_size: int | None = None
) -> tuple[float, float] | None:
    """Two-sided Hoeffding or Hoeffding–Serfling interval for values in [0, 1]."""
    if not scores:
        return None
    if not 0 < alpha < 1 or any(not 0 <= score <= 1 for score in scores):
        raise ValueError("alpha and bounded score values are invalid")
    n = len(scores)
    mean = sum(scores) / n
    rho = 1.0
    if population_size is not None and population_size >= n and population_size > 1:
        if n <= population_size / 2:
            rho = 1 - (n - 1) / population_size
        else:
            rho = (1 - n / population_size) * (1 + 1 / n)
    margin = math.sqrt(rho * math.log(2 / alpha) / (2 * n))
    return max(0.0, mean - margin), min(1.0, mean + margin)


def baseline_gate(
    strategy_a: str,
    strategy_b: str,
    totals: dict[str, int],
    requested_games: int,
    cluster_data_complete: bool = True,
    *,
    nodes_per_move: int | None = None,
    selection_verified: bool = False,
    selected_opening_count: int | None = None,
    paired_games_complete: bool = False,
) -> dict | None:
    """Apply the fixed search-vs-random/greedy baseline thresholds."""
    if strategy_a != "search" or strategy_b not in ("random", "greedy"):
        return None
    required_wins = requested_games if strategy_b == "random" else math.ceil(0.98 * requested_games)
    correctly_sized = requested_games == 1000
    protocol_complete = (
        selection_verified
        and selected_opening_count == 50
        and paired_games_complete
        and nodes_per_move == 10000
    )
    complete = (
        totals["unfinished"] == 0
        and sum(totals[key] for key in ("win", "draw", "loss")) == requested_games
        and cluster_data_complete
    )
    passed = None
    if correctly_sized and protocol_complete:
        passed = complete and paired_games_complete and totals["win"] >= required_wins
    return {
        "opponent": strategy_b,
        "required_games": 1000,
        "required_wins": required_wins,
        "requested_games": requested_games,
        "eligible_for_formal_gate": correctly_sized and protocol_complete,
        "protocol_complete": protocol_complete,
        "passed": passed,
        "reason": (
            "passed" if passed else
            "incomplete_games" if correctly_sized and not complete else
            "incomplete_pairs" if correctly_sized and protocol_complete and not paired_games_complete else
            "formal_protocol_not_verified" if correctly_sized and not protocol_complete else
            "win_threshold_not_met" if correctly_sized else
            "pilot_not_baseline_validation"
        ),
    }


def correctness_repair_gate(
    totals: dict[str, int], *, requested_games: int, protocol_verified: bool
) -> dict:
    """Apply the non-regression floor only to a complete, locked repair batch."""
    finished = sum(totals[key] for key in ("win", "draw", "loss"))
    complete = (
        protocol_verified
        and requested_games == 200
        and finished == 200
        and totals["unfinished"] == 0
    )
    score = (totals["win"] + 0.5 * totals["draw"]) / finished if complete else None
    return {
        "complete": complete,
        "score_mean": score,
        "minimum_score_mean": 0.45,
        "passed": complete and score is not None and score >= 0.45,
        "score_definition": "(wins + 0.5 * draws) / complete games",
    }


def summarize_results(
    *,
    requested_games: int,
    totals: dict[str, int],
    opening_scores: dict[str, list[float]],
    strategy_a: str,
    strategy_b: str,
    population_size: int | None = None,
    finite_population_verified: bool = False,
    selected_opening_count: int | None = None,
    look: int = 1,
    nodes_per_move: int | None = None,
    selection_verified: bool = False,
    paired_games_complete: bool = False,
    decision_protocol_verified: bool = False,
) -> dict:
    finished_games = sum(totals[key] for key in ("win", "draw", "loss"))
    unfinished_games = totals["unfinished"]
    clusters = {key: sum(values) / len(values) for key, values in opening_scores.items() if values}
    cluster_count = len(clusters)
    rounds = None
    if selected_opening_count and requested_games % (2 * selected_opening_count) == 0:
        rounds = requested_games // (2 * selected_opening_count)
    cluster_data_complete = bool(
        rounds is not None
        and len(opening_scores) == selected_opening_count
        and all(len(values) == rounds for values in opening_scores.values())
    )
    complete = (
        finished_games == requested_games
        and unfinished_games == 0
        and cluster_data_complete
    )
    mean = sum(clusters.values()) / cluster_count if cluster_count else None
    report_interval = bounded_mean_interval(list(clusters.values()), alpha=0.05)
    if mean is not None and report_interval is not None:
        report_elo = [elo(report_interval[0]), elo(report_interval[1])]
        elo_difference = elo(mean)
    else:
        report_elo = None
        elo_difference = None

    applicable_population = (
        population_size
        if finite_population_verified and population_size and population_size >= cluster_count
        else None
    )
    decision_interval = bounded_mean_interval(
        list(clusters.values()), alpha=0.025, population_size=applicable_population
    )
    decision_elo = (
        [elo(decision_interval[0]), elo(decision_interval[1])]
        if decision_interval is not None else None
    )
    formal_ready = bool(
        complete
        and requested_games == 200
        and selected_opening_count == 50
        and cluster_count == 50
        and applicable_population is not None
        and strategy_a == "search"
        and strategy_b == "search"
        and look in (1, 2)
        and nodes_per_move == 10000
        and decision_protocol_verified
    )
    return {
        "requested_games": requested_games,
        "finished_games": finished_games,
        "unfinished_games": unfinished_games,
        "completion_ratio": finished_games / requested_games if requested_games else 0,
        "complete": complete,
        "status": "complete" if complete else "incomplete",
        "wdl_for_a": totals,
        "effective_cluster_count": cluster_count,
        "completed_opening_clusters": cluster_count,
        "cluster_scores": opening_scores,
        "cluster_score_means": clusters,
        "score_mean": mean,
        "elo_difference": elo_difference,
        "report_95_hoeffding_score_interval": list(report_interval) if report_interval else None,
        "report_95_hoeffding_elo_interval": report_elo,
        "elo_95_hoeffding": report_elo,
        "decision_97_5_score_interval": list(decision_interval) if decision_interval else None,
        "decision_97_5_elo_interval": decision_elo,
        "decision_interval_method": (
            "Hoeffding-Serfling Corollary 2.5"
            if applicable_population is not None else "Hoeffding fallback; finite population not verified"
        ),
        "finite_population_size": applicable_population,
        "look": look,
        "look_policy": "at most 2 looks; each look is 200 games; use 97.5% per-look decision bound; after look 2 crossing zero, revert",
        "formal_decision_ready": formal_ready,
        "decision_protocol_verified": decision_protocol_verified,
        "decision_status": (
            "inconclusive" if not formal_ready or decision_interval is None else
            "ready" if decision_interval[0] > 0.5 else
            "revert_negative_effect" if decision_interval[1] < 0.5 else
            "revert_after_second_look" if look == 2 else
            "continue_to_second_look_if_interval_crosses_zero"
        ),
        "data_complete": cluster_data_complete,
        "baseline_gate": baseline_gate(
            strategy_a, strategy_b, totals, requested_games, cluster_data_complete,
            nodes_per_move=nodes_per_move, selection_verified=selection_verified,
            selected_opening_count=selected_opening_count,
            paired_games_complete=paired_games_complete,
        ),
        "method": "opening-cluster 95% Hoeffding diagnostic; ln(40); unfinished games remain in requested denominator",
    }


def verify_selection_protocol(protocol_path: Path, runner_tsv_path: Path) -> dict:
    """Verify the frozen 203→50 sample and that runner rows come from that sample."""
    protocol_path = protocol_path.resolve()
    protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
    if protocol.get("schema_version") != "m4-opening-selection-v1":
        raise ValueError("unsupported opening selection protocol")
    if protocol.get("python_version") != platform.python_version():
        raise ValueError("selection Python version does not match the frozen protocol")

    def referenced_file(key: str, hash_key: str) -> Path:
        path = (protocol_path.parent / protocol[key]).resolve()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != protocol.get(hash_key):
            raise ValueError(f"selection protocol hash mismatch: {key}")
        return path

    eligible_path = referenced_file("eligible_population_path", "eligible_population_sha256")
    selected_path = referenced_file("selected_population_path", "selected_population_sha256")
    frozen_tsv_path = referenced_file("runner_tsv_path", "runner_tsv_sha256")
    for key, expected in FROZEN_SELECTION.items():
        if protocol.get(key) != expected:
            raise ValueError(f"selection protocol does not match frozen M4 value: {key}")
    eligible = [json.loads(line) for line in eligible_path.read_text(encoding="utf-8").splitlines() if line]
    selected = [json.loads(line) for line in selected_path.read_text(encoding="utf-8").splitlines() if line]
    population_count = protocol.get("eligible_population_count")
    selected_count = protocol.get("selected_count")
    if len(eligible) != population_count or len(eligible) != 203:
        raise ValueError("eligible opening population count mismatch")
    if len(selected) != selected_count or len(selected) != 50:
        raise ValueError("selected opening sample count mismatch")
    if len({row["opening_id"] for row in eligible}) != len(eligible):
        raise ValueError("duplicate eligible opening ID")
    ordered = sorted(eligible, key=lambda row: row["position_key"])
    sample = random.Random(protocol["sampling_seed_u64"]).sample(ordered, selected_count)
    identity = lambda row: (row["opening_id"], row["position_key"], row["source_pgn_url"], row["iccs_prefix"])
    if [identity(row) for row in sample] != [identity(row) for row in selected]:
        raise ValueError("selected sample does not reproduce from the frozen seed")

    frozen_rows = [
        (row["opening_id"], row["source_pgn_url"], row["iccs_prefix"])
        for row in selected
    ]
    expected_tsv = "opening_id\tsource_ref\ticcs_prefix\n" + "".join(
        "\t".join(row) + "\n" for row in frozen_rows
    )
    if frozen_tsv_path.read_text(encoding="utf-8") != expected_tsv:
        raise ValueError("frozen runner TSV does not match selected metadata")

    selected_by_id = {row["opening_id"]: row for row in selected}
    input_lines = runner_tsv_path.read_text(encoding="utf-8").splitlines()
    if not input_lines or input_lines[0].split("\t") != ["opening_id", "source_ref", "iccs_prefix"]:
        raise ValueError("runner TSV header is invalid")
    input_rows = []
    for line in input_lines[1:]:
        fields = line.split("\t")
        if len(fields) != 3:
            raise ValueError("runner TSV row must have three columns")
        opening_id, source, prefix = fields
        row = selected_by_id.get(opening_id)
        if row is None or (source, prefix) != (row["source_pgn_url"], row["iccs_prefix"]):
            raise ValueError(f"runner opening is not in the frozen sample: {opening_id}")
        input_rows.append(opening_id)
    if not input_rows or len(input_rows) != len(set(input_rows)):
        raise ValueError("runner TSV must contain unique selected opening rows")
    return {
        "population_size": len(eligible),
        "selected_count": len(selected),
        "input_count": len(input_rows),
        "full_selected_sample": input_rows == [row["opening_id"] for row in selected],
        "eligible_population_sha256": protocol["eligible_population_sha256"],
        "selected_population_sha256": protocol["selected_population_sha256"],
        "runner_tsv_sha256": protocol["runner_tsv_sha256"],
        "sampling_seed_u64": protocol["sampling_seed_u64"],
        "frozen_protocol_verified": True,
    }


def executable_metadata(command: str) -> dict:
    """Hash the executable named by a shell-like command for run provenance."""
    argv = shlex.split(command)
    if not argv:
        raise ValueError("empty engine command")
    executable = shutil.which(argv[0])
    if executable is None:
        raise ValueError(f"engine executable not found: {argv[0]}")
    path = Path(executable).resolve()
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def baseline_profile_options(profile: str) -> dict[str, str]:
    profiles = {
        "final-ra-ce": {"CheckExtensions": "true", "RootAlpha": "true"},
        "final-ra-ce-kh": {
            "CheckExtensions": "true", "KillerHistoryOrdering": "true", "RootAlpha": "true",
        },
    }
    try:
        return profiles[profile]
    except KeyError as error:
        raise ValueError(f"unsupported baseline profile: {profile}") from error


def validate_integration_nonregression_profile(
    *, strategy_a, strategy_b, games, nodes, global_round_start, global_round_count,
    seed, max_ply, workers, engine_timeout, options_a, options_b, actual_a, actual_b,
    expected_a, expected_b, selection,
):
    if strategy_a != "search" or strategy_b != "search":
        raise ValueError("integration-nonregression requires search-v-search")
    if games != 200:
        raise ValueError("integration-nonregression requires games=200")
    if nodes != 10000 or seed != 1 or max_ply != 4096:
        raise ValueError("integration-nonregression requires nodes=10000, seed=1, max-ply=4096")
    if global_round_count != 2 or global_round_start != 1:
        raise ValueError("integration-nonregression requires rounds 1–2")
    if workers != 4 or engine_timeout != 30.0:
        raise ValueError("integration-nonregression requires workers=4 and engine-timeout=30")
    if not selection or not selection.get("full_selected_sample") or not selection.get("frozen_protocol_verified"):
        raise ValueError("integration-nonregression requires full frozen 50-opening selection")
    expected_options_a = {"CheckExtensions": "true", "KillerHistoryOrdering": "true", "RootAlpha": "true"}
    expected_options_b = {"CheckExtensions": "true", "RootAlpha": "true"}
    if options_a != expected_options_a or options_b != expected_options_b:
        raise ValueError("integration-nonregression requires exact A/B options")
    if not expected_a or not expected_b or actual_a != expected_a or actual_b != expected_b:
        raise ValueError("integration-nonregression executable SHA pin mismatch")
    if actual_a == actual_b:
        raise ValueError("integration-nonregression requires distinct A/B executable SHA")


def validate_product_provenance(
    *, repo_root: Path, source_head: str, expected_core_sha256: str,
    build_proof: Path, expected_build_proof_sha256: str,
) -> dict:
    if not re.fullmatch(r"[0-9a-fA-F]{40}", source_head or ""):
        raise ValueError("product source HEAD must be a full 40-character commit SHA")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_core_sha256 or ""):
        raise ValueError("product core SHA-256 pin must be a full 64-character hash")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_build_proof_sha256 or ""):
        raise ValueError("build proof SHA-256 pin must be a full 64-character hash")
    try:
        subprocess.run(
            ["git", "cat-file", "-e", f"{source_head}^{{commit}}"], cwd=repo_root,
            check=True, capture_output=True,
        )
        source_bytes = subprocess.run(
            ["git", "show", f"{source_head}:crates/xq-engine/src/lib.rs"], cwd=repo_root,
            check=True, capture_output=True,
        ).stdout
    except subprocess.CalledProcessError as error:
        raise ValueError("product source HEAD/core file is absent from this repository's git objects") from error
    actual_core_sha256 = hashlib.sha256(source_bytes).hexdigest()
    if actual_core_sha256 != expected_core_sha256.lower():
        raise ValueError("product core SHA-256 mismatch")
    proof_path = Path(build_proof)
    if not proof_path.is_file():
        raise ValueError("product build proof file does not exist")
    proof_path = proof_path.resolve()
    actual_proof_sha256 = hashlib.sha256(proof_path.read_bytes()).hexdigest()
    if actual_proof_sha256 != expected_build_proof_sha256.lower():
        raise ValueError("product build proof SHA-256 mismatch")
    return {
        "source_head": source_head.lower(),
        "core_path": "crates/xq-engine/src/lib.rs",
        "core_sha256": actual_core_sha256,
        "build_proof_path": str(proof_path),
        "build_proof_sha256": actual_proof_sha256,
        "validation_status": "external_preflight_required",
    }


def integration_nonregression_gate(totals: dict, *, requested_games: int, protocol_verified: bool) -> dict:
    finished = sum(totals.get(key, 0) for key in ("win", "draw", "loss"))
    unfinished = totals.get("unfinished", 0)
    complete = requested_games == 200 and finished == 200 and unfinished == 0
    score = (totals.get("win", 0) + 0.5 * totals.get("draw", 0)) / 200
    threshold_met = score >= 0.45
    return {
        "complete": complete, "finished_games": finished, "unfinished_games": unfinished,
        "score_mean": score, "minimum_score_mean": 0.45,
        "score_threshold_met": threshold_met,
        "provisional_pass": bool(protocol_verified and complete and threshold_met),
        "formal_decision_ready": False,
        "formal_status": "await_raw_game_audit",
    }


def search_ab_options(experiment: str) -> tuple[dict[str, str], dict[str, str]]:
    """Return the only approved A/B option maps for a named M4 search experiment."""
    if experiment == "check-extensions":
        return ({"CheckExtensions": "true"}, {"CheckExtensions": "false"})
    if experiment == "move-hints":
        return (
            {"CheckExtensions": "false", "MoveHints": "true"},
            {"CheckExtensions": "false", "MoveHints": "false"},
        )
    if experiment == "root-alpha":
        return (
            {"CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "true"},
            {"CheckExtensions": "false", "MoveHints": "false", "RootAlpha": "false"},
        )
    if experiment == "q-capture-order":
        return ({"QCaptureOrder": "true"}, {"QCaptureOrder": "false"})
    if experiment == "correctness-repair":
        return ({}, {})
    if experiment == "integration-nonregression":
        return ({"RootAlpha": "true", "CheckExtensions": "true", "KillerHistoryOrdering": "true"},
                {"RootAlpha": "true", "CheckExtensions": "true"})
    if experiment == "composite-root-alpha-check-extensions":
        return (
            {"RootAlpha": "true", "CheckExtensions": "true"},
            {"RootAlpha": "false", "CheckExtensions": "false"},
        )
    raise ValueError(f"unsupported search A/B experiment: {experiment}")


COMPOSITE_CANDIDATE_HEAD = "4a8a21aa111516124eada56eb37a5224a1e8fe87"
COMPOSITE_BINARY_SHA256 = "2ee963e53eae374c93725021873949f338df6cc2d229325e3846c62ccf08b426"


def validate_composite_profile(
    *, look: int, global_round_start: int, global_round_count: int,
    games: int, nodes: int, max_ply: int, seed: int, workers: int,
    engine_timeout: float, engine_a_options: dict, engine_b_options: dict,
    engine_a_sha256: str, engine_b_sha256: str, selection: dict | None,
) -> None:
    """Fail closed unless a run is one locked 50-opening composite look."""
    expected_round_start = 1 if look == 1 else 3 if look == 2 else None
    if expected_round_start is None:
        raise ValueError("composite profile look must be 1 or 2")
    checks = (
        (games == 200, "games=200"),
        (nodes == 10000, "nodes=10000"),
        (seed == 1, "seed=1"),
        (max_ply == 4096, "max-ply=4096"),
        (global_round_count == 2 and global_round_start == expected_round_start,
         f"look {look} rounds {expected_round_start}–{expected_round_start + 1}"),
        (workers == 4, "workers=4"),
        (engine_timeout == 30.0, "engine-timeout=30"),
        (engine_a_options == {"RootAlpha": "true", "CheckExtensions": "true"},
         "candidate options RootAlpha=true and CheckExtensions=true"),
        (engine_b_options == {"RootAlpha": "false", "CheckExtensions": "false"},
         "baseline options RootAlpha=false and CheckExtensions=false"),
        (engine_a_sha256 == COMPOSITE_BINARY_SHA256 and engine_b_sha256 == COMPOSITE_BINARY_SHA256,
         "the frozen composite candidate binary on both sides"),
        (selection is not None and selection.get("future_openings_verified") is True,
         "the reviewed future-opening selection manifest"),
        (selection is not None and selection.get("population_size") == 153,
         "finite population size 153"),
        (selection is not None and selection.get("selected_count") == 50
         and selection.get("ordered_sample_count") == 100,
         "look sample of 50 from the ordered-100 sample"),
        (selection is not None and selection.get("look") == look,
         f"look {look} TSV"),
    )
    for valid, description in checks:
        if not valid:
            raise ValueError(f"formal composite profile requires {description}")


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_composite_look1_audit_receipt(
    summary_path: Path, current_selection: dict, receipt_path: Path,
) -> dict:
    """Verify the already-audited look 1 artifacts and their exact sample/profile."""
    summary_path = Path(summary_path).resolve()
    receipt_path = Path(receipt_path).resolve()
    try:
        receipt_bytes = receipt_path.read_bytes()
        receipt = json.loads(receipt_bytes)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"look 1 audit receipt is missing or invalid: {error}") from error
    if not isinstance(receipt, dict) or receipt.get("schema") != "m4-composite-look1-audit-receipt-v1":
        raise ValueError("look 1 audit receipt has an unsupported schema")
    if receipt.get("status") != "independently-audited-complete" or receipt.get("look") != 1:
        raise ValueError("look 1 audit receipt does not attest a complete audited look 1")

    selection = receipt.get("selection") or {}
    manifest_path_value = current_selection.get("manifest_path")
    if not isinstance(manifest_path_value, str):
        raise ValueError("current sample selection lacks its verified manifest path")
    selection_manifest_path = Path(manifest_path_value).resolve()
    if (selection.get("manifest_path") != str(selection_manifest_path)
            or selection.get("manifest_sha256") != current_selection.get("manifest_sha256")
            or selection.get("selection_manifest_sha256") != current_selection.get("selection_manifest_sha256")):
        raise ValueError("look 1 audit receipt refers to a different ordered sample")
    try:
        sample_manifest = json.loads(selection_manifest_path.read_text(encoding="utf-8"))
        output_paths = sample_manifest["output_paths"]
        look1_tsv = (selection_manifest_path.parent / output_paths["look1"]).resolve()
    except (OSError, UnicodeError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"look 1 sample manifest is missing or invalid: {error}") from error
    if selection.get("look_tsv_path") != str(look1_tsv) or not look1_tsv.is_file():
        raise ValueError("look 1 audit receipt does not point at the sample manifest's look 1 TSV")
    if _sha256_path(selection_manifest_path) != current_selection.get("manifest_sha256"):
        raise ValueError("current ordered sample manifest SHA-256 mismatch")
    sample_candidate = sample_manifest.get("candidate") or {}
    if (sample_candidate.get("git_head") != COMPOSITE_CANDIDATE_HEAD
            or sample_candidate.get("binary_sha256") != COMPOSITE_BINARY_SHA256):
        raise ValueError("current ordered sample manifest candidate identity mismatch")
    if _sha256_path(look1_tsv) != selection.get("look_tsv_sha256"):
        raise ValueError("look 1 sample TSV SHA-256 mismatch")
    tsv_lines = look1_tsv.read_text(encoding="utf-8").splitlines()
    if not tsv_lines or tsv_lines[0] != "opening_id\tsource_ref\ticcs_prefix" or len(tsv_lines) != 51:
        raise ValueError("look 1 sample TSV must contain exactly 50 openings")
    opening_data = {}
    for line in tsv_lines[1:]:
        fields = line.split("\t")
        if len(fields) != 3 or any(not field for field in fields) or fields[0] in opening_data:
            raise ValueError("look 1 sample TSV has an invalid or duplicate row")
        opening_data[fields[0]] = (fields[1], fields[2].split())
    look1_ids = list(opening_data)
    if (selection.get("opening_ids") != look1_ids or len(look1_ids) != 50
            or len(set(look1_ids)) != 50):
        raise ValueError("look 1 receipt opening IDs differ from its verified TSV")
    summary_selection = (json.loads(summary_path.read_text(encoding="utf-8")).get("selection_protocol") or {})
    if (summary_selection.get("future_openings_verified") is not True
            or summary_selection.get("population_size") != 153
            or summary_selection.get("selected_count") != 50
            or summary_selection.get("ordered_sample_count") != 100
            or summary_selection.get("look") != 1
            or summary_selection.get("selection_manifest_sha256") != current_selection.get("selection_manifest_sha256")
            or summary_selection.get("manifest_sha256") != current_selection.get("manifest_sha256")
            or summary_selection.get("opening_ids") != look1_ids):
        raise ValueError("look 1 summary sample provenance differs from its audited TSV")
    look2_ids = current_selection.get("opening_ids")
    if not isinstance(look2_ids, list) or len(look2_ids) != 50 or set(look1_ids) & set(look2_ids):
        raise ValueError("look 1 and look 2 must be disjoint 50-opening samples")

    summary_sha = _sha256_path(summary_path)
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"look 1 summary is invalid: {error}") from error
    artifact_map = receipt.get("artifacts")
    if not isinstance(artifact_map, dict):
        raise ValueError("look 1 audit receipt lacks its artifact map")
    run_manifest_path_value = summary.get("run_manifest_path")
    if not isinstance(run_manifest_path_value, str):
        raise ValueError("look 1 summary lacks its run-manifest path")
    run_manifest_path = Path(run_manifest_path_value).resolve()
    expected_artifact_paths = {
        "summary": summary_path,
        "run_manifest": run_manifest_path,
        "games": run_manifest_path.parent / "games.jsonl",
    }
    actual_artifacts = {}
    for name, expected_path in expected_artifact_paths.items():
        ref = artifact_map.get(name)
        if (not isinstance(ref, dict) or ref.get("path") != str(expected_path)
                or not expected_path.is_file() or ref.get("sha256") != _sha256_path(expected_path)):
            raise ValueError(f"look 1 audit receipt artifact mismatch: {name}")
        actual_artifacts[name] = ref
    if summary.get("run_manifest_sha256") != actual_artifacts["run_manifest"]["sha256"]:
        raise ValueError("look 1 summary and run-manifest receipt disagree")
    try:
        run_manifest = json.loads(run_manifest_path.read_text(encoding="utf-8"))
        games = [json.loads(line) for line in expected_artifact_paths["games"].read_text(encoding="utf-8").splitlines() if line]
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"look 1 audited artifacts are invalid: {error}") from error

    actual_head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[2],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    actual_runner_sha = _sha256_path(Path(__file__).resolve())
    profile = receipt.get("profile") or {}
    profile_expected = {
        "experiment": "composite-root-alpha-check-extensions",
        "look": 1, "global_rounds": [1, 2], "requested_games": 200,
        "nodes_per_move": 10000, "master_seed": 1, "max_ply": 4096,
        "workers": 4, "engine_timeout_seconds": 30.0,
        "strategy_a": "search", "strategy_b": "search",
        "candidate_side": "A", "baseline_side": "B",
        "engine_a_options": {"RootAlpha": "true", "CheckExtensions": "true"},
        "engine_b_options": {"RootAlpha": "false", "CheckExtensions": "false"},
        "binary_sha256": COMPOSITE_BINARY_SHA256,
        "sample_manifest_sha256": current_selection.get("manifest_sha256"),
        "runner_git_head": actual_head, "runner_source_sha256": actual_runner_sha,
    }
    for field, expected in profile_expected.items():
        if profile.get(field) != expected:
            raise ValueError(f"look 1 audit receipt profile/source mismatch: {field}")
    run_manifest_expected = {key: value for key, value in profile_expected.items()
                             if key not in ("binary_sha256", "sample_manifest_sha256")}
    run_manifest_expected["future_selection_manifest_sha256"] = current_selection.get("manifest_sha256")
    for field, expected in run_manifest_expected.items():
        if run_manifest.get(field) != expected:
            raise ValueError(f"look 1 run manifest profile/source mismatch: {field}")
    for side in ("a", "b"):
        metadata = run_manifest.get(f"engine_{side}_executable") or {}
        if metadata.get("sha256") != COMPOSITE_BINARY_SHA256:
            raise ValueError(f"look 1 run manifest binary SHA mismatch: engine {side.upper()}")
        executable_path = Path(run_manifest.get(f"engine_{side}_command", "")).resolve()
        if not executable_path.is_file() or _sha256_path(executable_path) != COMPOSITE_BINARY_SHA256:
            raise ValueError(f"look 1 actual engine {side.upper()} executable mismatch")
    config = {key: value for key, value in run_manifest.items() if key != "config_sha256"}
    computed_config_sha = hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if run_manifest.get("config_sha256") != computed_config_sha:
        raise ValueError("look 1 run manifest configuration digest mismatch")
    if profile.get("config_sha256") != computed_config_sha:
        raise ValueError("look 1 audit receipt configuration digest mismatch")
    if (receipt.get("candidate") != {
            "git_head": COMPOSITE_CANDIDATE_HEAD,
            "binary_sha256": COMPOSITE_BINARY_SHA256,
            "config_path": sample_candidate.get("config_path"),
            "config_sha256": sample_candidate.get("config_sha256"),
            "engine_a_options": profile_expected["engine_a_options"],
            "engine_b_options": profile_expected["engine_b_options"],
        }):
        raise ValueError("look 1 audit receipt candidate provenance mismatch")
    if (summary.get("experiment") != profile_expected["experiment"]
            or summary.get("look") != 1 or summary.get("global_rounds") != [1, 2]
            or summary.get("requested_games") != 200 or summary.get("games_written") != 200
            or summary.get("finished_games") != 200
            or summary.get("unfinished_games") != 0 or summary.get("complete") is not True
            or summary.get("formal_decision_ready") is not True):
        raise ValueError("look 1 summary is incomplete or inconsistent with its audit receipt")
    if summary_sha != artifact_map["summary"]["sha256"]:
        raise ValueError("look 1 summary SHA-256 mismatch")

    expected_ids = {
        stable_game_id(round_number, opening_id, a_is_red)
        for round_number in (1, 2) for opening_id in look1_ids for a_is_red in (True, False)
    }
    if len(games) != 200 or {game.get("game_id") for game in games} != expected_ids:
        raise ValueError("look 1 games do not contain the complete 50 x 2-color x 2-round ID set")
    wdl = {"win": 0, "draw": 0, "loss": 0}
    for game in games:
        game_id = game["game_id"]
        opening_id = game["opening_id"]
        round_number = game["global_round"]
        a_is_red = game["a_is_red"]
        if (game.get("source"), game.get("prefix")) != opening_data[opening_id]:
            raise ValueError(f"look 1 game opening source/prefix mismatch: {game_id}")
        if (game.get("nodes"), game.get("max_ply"), game.get("master_seed")) != (10000, 4096, 1):
            raise ValueError(f"look 1 game configuration mismatch: {game_id}")
        if (not isinstance(a_is_red, bool) or game.get("global_round") not in (1, 2)
                or game_id != stable_game_id(round_number, opening_id, a_is_red)
                or game.get("protocol_error") is not None
                or game.get("unfinished_reason") is not None):
            raise ValueError(f"look 1 game identity or completion mismatch: {game_id}")
        outcome = game.get("terminal_outcome")
        if outcome not in ("red", "black", "draw") or not isinstance(game.get("moves"), list):
            raise ValueError(f"look 1 game lacks terminal outcome or move sequence: {game_id}")
        prefix = opening_data[opening_id][1]
        if game["moves"][:len(prefix)] != prefix:
            raise ValueError(f"look 1 game prefix mismatch: {game_id}")
        if len(game.get("decision_seeds", [])) != len(game["moves"]) - len(prefix) + 1:
            raise ValueError(f"look 1 game decision-seed sequence mismatch: {game_id}")
        expected_result = terminal_result_for_a(outcome, a_is_red)
        expected_winner = None if expected_result == "draw" else "A" if expected_result == "win" else "B"
        if game.get("result_for_a") != expected_result or game.get("winner") != expected_winner:
            raise ValueError(f"look 1 game result mismatch: {game_id}")
        terminal_raw = game.get("terminal_raw")
        if (not isinstance(terminal_raw, list)
                or f"info string outcome {outcome}" not in terminal_raw
                or "bestmove 0000" not in terminal_raw):
            raise ValueError(f"look 1 terminal evidence mismatch: {game_id}")
        wdl[expected_result] += 1
    summary_wdl = summary.get("wdl_for_a") or {}
    if any(summary_wdl.get(key) != value for key, value in wdl.items()):
        raise ValueError("look 1 summary W/D/L differs from complete games")
    verification = receipt.get("verification") or {}
    raw_decisions = receipt.get("raw_decisions")
    if (not isinstance(raw_decisions, dict) or set(raw_decisions) != {"A", "B"}
            or any(not isinstance(raw_decisions[side], int) or isinstance(raw_decisions[side], bool)
                   or raw_decisions[side] < 100 for side in ("A", "B"))):
        raise ValueError("look 1 audit receipt lacks complete raw decision counts for both engines")
    if verification != {
            "game_count": 200, "replayed_games": 200, "error_count": 0,
            "raw_decisions": raw_decisions,
    }:
        raise ValueError("look 1 audit receipt lacks a successful full-game/raw audit result")

    raw_refs = artifact_map.get("raw_files")
    expected_raw_labels = {
        f"workers/worker-{worker:02d}/engine-{side}.log"
        for worker in range(1, 5) for side in ("a", "b")
    }
    if (not isinstance(raw_refs, list) or len(raw_refs) != 8
            or {item.get("label") for item in raw_refs if isinstance(item, dict)} != expected_raw_labels):
        raise ValueError("look 1 audit receipt must list all eight worker raw logs")
    for ref in raw_refs:
        path = Path(ref["path"]).resolve()
        expected_path = (run_manifest_path.parent / ref["label"]).resolve()
        if path != expected_path or not path.is_file() or _sha256_path(path) != ref.get("sha256"):
            raise ValueError(f"look 1 audit receipt raw file mismatch: {ref.get('label')}")
        actual_artifacts[ref["label"]] = ref
    replay = receipt.get("replay_executable") or {}
    replay_path = Path(replay.get("path", ""))
    if (not replay_path.is_file() or _sha256_path(replay_path) != replay.get("sha256")
            or _sha256_path(replay_path) != receipt.get("profile", {}).get("replay_sha256")):
        raise ValueError("look 1 audit receipt Game replay executable source mismatch")
    audit_source = receipt.get("audit_source") or {}
    audit_path = Path(audit_source.get("path", ""))
    if (not audit_path.is_file() or _sha256_path(audit_path) != audit_source.get("sha256")
            or audit_path.resolve() != (Path(__file__).resolve().parent / "audit_composite.py").resolve()):
        raise ValueError("look 1 audit receipt auditor source mismatch")
    return {
        "path": str(summary_path), "summary_sha256": summary_sha,
        "run_manifest_path": str(run_manifest_path),
        "run_manifest_sha256": _sha256_path(run_manifest_path),
        "audit_receipt_path": str(receipt_path),
        "audit_receipt_sha256": _sha256_path(receipt_path),
        "decision_interval": summary["decision_97_5_score_interval"],
        "look1_opening_count": 50,
        "look2_opening_count": 50,
    }


def validate_composite_prior_look(
    summary_path: Path, current_selection: dict, audit_receipt_path: Path | None = None,
) -> dict:
    """Require a full audit receipt, not only a self-declared look 1 summary."""
    summary_path = Path(summary_path).resolve()
    if audit_receipt_path is None:
        raise ValueError("look 2 requires a look 1 audit receipt")
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid look 1 summary: {error}") from error
    required = {
        "experiment": "composite-root-alpha-check-extensions",
        "look": 1,
        "global_rounds": [1, 2],
        "requested_games": 200,
        "finished_games": 200,
        "unfinished_games": 0,
        "complete": True,
        "formal_decision_ready": True,
    }
    for field, expected in required.items():
        if summary.get(field) != expected:
            raise ValueError(f"prior look summary does not satisfy {field}={expected!r}")
    interval = summary.get("decision_97_5_score_interval")
    from composite_statistics import should_run_second_look
    if not should_run_second_look(interval):
        raise ValueError("look 1 decision interval does not cross 0.5; look 2 is not authorized")
    selection = summary.get("selection_protocol")
    if (not isinstance(selection, dict)
            or selection.get("future_openings_verified") is not True
            or selection.get("population_size") != 153
            or selection.get("selected_count") != 50
            or selection.get("ordered_sample_count") != 100
            or selection.get("look") != 1
            or selection.get("selection_manifest_sha256") != current_selection.get("selection_manifest_sha256")):
        raise ValueError("look 1 sample provenance differs from the current future-opening manifest")
    first_ids = selection.get("opening_ids")
    second_ids = current_selection.get("opening_ids")
    if (not isinstance(first_ids, list) or len(first_ids) != 50 or len(set(first_ids)) != 50
            or not isinstance(second_ids, list) or len(second_ids) != 50 or len(set(second_ids)) != 50):
        raise ValueError("look 1 and look 2 must each have 50 unique opening IDs")
    if set(first_ids) & set(second_ids) or len(set(first_ids) | set(second_ids)) != 100:
        raise ValueError("look 1 and look 2 opening sets must be disjoint")
    manifest_path_value = summary.get("run_manifest_path")
    if not isinstance(manifest_path_value, str):
        raise ValueError("look 1 summary lacks run_manifest_path")
    manifest_path = Path(manifest_path_value).resolve()
    try:
        manifest_bytes = manifest_path.read_bytes()
        run_manifest = json.loads(manifest_bytes)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"look 1 run manifest is missing or invalid: {error}") from error
    digest = hashlib.sha256(manifest_bytes).hexdigest()
    if summary.get("run_manifest_sha256") != digest:
        raise ValueError("look 1 run manifest SHA-256 differs from its summary")
    exact_fields = {
        "experiment": "composite-root-alpha-check-extensions",
        "global_rounds": [1, 2], "requested_games": 200,
        "nodes_per_move": 10000, "max_ply": 4096, "master_seed": 1,
        "workers": 4, "engine_timeout_seconds": 30.0,
        "strategy_a": "search", "strategy_b": "search",
        "candidate_side": "A", "baseline_side": "B",
        "engine_a_options": {"RootAlpha": "true", "CheckExtensions": "true"},
        "engine_b_options": {"RootAlpha": "false", "CheckExtensions": "false"},
        "future_selection_manifest_sha256": selection.get("manifest_sha256"),
    }
    for field, expected in exact_fields.items():
        if run_manifest.get(field) != expected:
            raise ValueError(f"look 1 run manifest does not match composite protocol: {field}")
    for side in ("a", "b"):
        metadata = run_manifest.get(f"engine_{side}_executable") or {}
        if metadata.get("sha256") != COMPOSITE_BINARY_SHA256:
            raise ValueError(f"look 1 used an unexpected engine {side.upper()} binary")
    receipt = validate_composite_look1_audit_receipt(
        summary_path, current_selection, audit_receipt_path,
    )
    if receipt["run_manifest_path"] != str(manifest_path) or receipt["run_manifest_sha256"] != digest:
        raise ValueError("look 1 audit receipt references a different run manifest")
    if receipt["decision_interval"] != interval:
        raise ValueError("look 1 audit receipt decision interval differs from its summary")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-a", required=True, help="shell-like command for UCI engine A")
    parser.add_argument("--engine-b", required=True, help="shell-like command for UCI engine B")
    parser.add_argument("--openings", required=True, type=Path, help="UTF-8 TSV: opening ID, source, ICCS prefix moves")
    parser.add_argument("--nodes", required=True, type=int)
    parser.add_argument("--games", required=True, type=int, help="must equal 2 * openings * complete rounds")
    parser.add_argument("--global-round-start", type=int, default=1,
                        help="first stable global round number represented in this run")
    parser.add_argument("--global-round-count", type=int,
                        help="number of global rounds; defaults from --games and opening count")
    parser.add_argument("--max-ply", type=int, default=4096, help="safety cap; unfinished games count separately")
    parser.add_argument("--engine-timeout", type=float, default=30.0, help="maximum seconds waiting for each UCI response")
    parser.add_argument("--workers", type=int, default=1,
                        help="number of independent UCI engine pairs; each worker runs complete games")
    parser.add_argument("--strategy-a", choices=("search", "random", "greedy"), default="search")
    parser.add_argument("--strategy-b", choices=("search", "random", "greedy"), default="search")
    parser.add_argument("--baseline-profile", choices=("final-ra-ce", "final-ra-ce-kh"),
                        help="named final default RA+CE baseline validation profile")
    parser.add_argument("--engine-a-options", default="{}", help="JSON object of fixed UCI option values")
    parser.add_argument("--engine-b-options", default="{}", help="JSON object of fixed UCI option values")
    parser.add_argument("--experiment", choices=("check-extensions", "move-hints", "root-alpha", "q-capture-order", "correctness-repair", "composite-root-alpha-check-extensions", "integration-nonregression"),
                        help="named, predeclared search-v-search candidate experiment")
    parser.add_argument("--seed", type=int, default=1, help="reproducible caller seed for strategy randomness")
    parser.add_argument("--look", type=int, choices=(1, 2), default=1, help="predeclared A/B decision look")
    parser.add_argument("--selection-protocol", type=Path, help="frozen opening selection manifest to verify")
    parser.add_argument("--future-selection-manifest", type=Path,
                        help="reviewed remaining-153 ordered-100 selection manifest for the composite profile")
    parser.add_argument("--prior-look-summary", type=Path,
                        help="completed composite look 1 summary required before look 2")
    parser.add_argument("--prior-look-audit-receipt", type=Path,
                        help="full raw/Game audit receipt required before composite look 2")
    parser.add_argument("--expected-engine-a-sha256")
    parser.add_argument("--expected-engine-b-sha256")
    parser.add_argument("--product-source-head")
    parser.add_argument("--product-core-sha256")
    parser.add_argument("--product-build-proof", type=Path)
    parser.add_argument("--expected-product-build-proof-sha256")
    parser.add_argument("--m5-profile", choices=("kh", "nullmove", "lmr"),
                        help="strict M5 one-flag candidate profile")
    parser.add_argument("--m5-candidate-lock", type=Path, help="frozen M5 candidate lock")
    parser.add_argument("--m5-selection-binding", type=Path, help="M5 sidecar binding ordered sample to candidate")
    parser.add_argument("--m5-prior-look-receipt", type=Path, help="audited M5 look 1 receipt required for look 2")
    parser.add_argument("--output", required=True, type=Path, help="directory for raw games and summary")
    args = parser.parse_args()
    try:
        engine_a_options = json.loads(args.engine_a_options)
        engine_b_options = json.loads(args.engine_b_options)
        if not all(isinstance(options, dict) and all(isinstance(key, str) and isinstance(value, str)
                                                       for key, value in options.items())
                   for options in (engine_a_options, engine_b_options)):
            raise ValueError("option maps must contain string names and values")
    except (json.JSONDecodeError, ValueError) as error:
        parser.error(f"invalid engine option JSON: {error}")
    if (args.nodes < 1 or args.games < 2 or args.max_ply < 1 or args.engine_timeout <= 0
        or args.global_round_start < 1):
        parser.error("nodes, games, max-ply, and engine-timeout must be positive")
    if args.workers < 1 or args.workers > args.games:
        parser.error("workers must be positive and no greater than requested games")
    if not 0 <= args.seed <= 0xFFFFFFFFFFFFFFFF:
        parser.error("seed must fit in 64 bits")
    openings = []
    for line_number, row in enumerate(args.openings.read_text(encoding="utf-8").splitlines(), start=1):
        if not row.strip() or row.startswith("#"):
            continue
        fields = row.split("\t")
        if line_number == 1 and fields == ["opening_id", "source_ref", "iccs_prefix"]:
            continue
        if len(fields) != 3:
            parser.error(f"opening row must have three TSV fields: {row}")
        opening_id, source, moves = fields
        prefix = moves.split()
        if not 4 <= len(prefix) <= 8:
            parser.error(f"opening {opening_id} must contain 4–8 ICCS plies")
        openings.append({"id": opening_id, "source": source, "moves": prefix})
    if not openings or args.games % (2 * len(openings)):
        parser.error("games must contain complete color-swapped pairs and complete opening rounds")
    derived_round_count = args.games // (2 * len(openings))
    global_round_count = args.global_round_count or derived_round_count
    if global_round_count != derived_round_count:
        parser.error("games must equal 2 * opening count * global-round-count")
    if len({opening["id"] for opening in openings}) != len(openings):
        parser.error("opening IDs must be unique; duplicate rows cannot create extra clusters")
    if args.selection_protocol is not None and args.future_selection_manifest is not None:
        parser.error("choose only one opening selection protocol")
    selection = None
    if args.selection_protocol is not None:
        try:
            selection = verify_selection_protocol(args.selection_protocol, args.openings)
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            parser.error(f"invalid selection protocol: {error}")
    if args.future_selection_manifest is not None:
        try:
            if args.m5_profile is not None:
                if not args.m5_candidate_lock or not args.m5_selection_binding:
                    raise ValueError("M5 requires candidate lock and selection binding")
                from pathlib import Path as _Path
                import sys as _sys
                _m5_dir = str(_Path(__file__).resolve().parents[1] / "m5")
                if _m5_dir not in _sys.path:
                    _sys.path.insert(0, _m5_dir)
                import protocol as m5_protocol
                selection = m5_protocol.verify_runner_selection(
                    args.m5_candidate_lock, args.m5_selection_binding,
                    args.future_selection_manifest, args.openings, args.look, args.m5_profile,
                )
            else:
                if args.experiment != "composite-root-alpha-check-extensions":
                    parser.error("--future-selection-manifest is reserved for the composite profile")
                from future_opening_adapter import verify_future_opening_look
                selection = verify_future_opening_look(
                    args.future_selection_manifest, args.openings, args.look,
                )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            parser.error(f"invalid future opening selection: {error}")
    if args.m5_profile is not None and args.selection_protocol is not None:
        parser.error("M5 requires its own remaining-153 M5 candidate sample")
    if args.experiment == "composite-root-alpha-check-extensions" and args.selection_protocol is not None:
        parser.error("composite profile requires --future-selection-manifest, not the frozen 203-to-50 protocol")
    if args.future_selection_manifest is not None and args.m5_profile is None and args.experiment != "composite-root-alpha-check-extensions":
        parser.error("--future-selection-manifest is reserved for the composite profile")
    if (args.prior_look_summary is not None or args.prior_look_audit_receipt is not None) and args.experiment != "composite-root-alpha-check-extensions":
        parser.error("look 1 evidence arguments are reserved for the composite profile")
    if args.m5_profile is not None:
        if args.experiment is not None or args.baseline_profile is not None:
            parser.error("M5 cannot be combined with M4 experiment or baseline profiles")
        if args.future_selection_manifest is None or args.m5_candidate_lock is None or args.m5_selection_binding is None:
            parser.error("M5 requires future sample manifest, candidate lock, and selection binding")
        if args.prior_look_summary is not None or args.prior_look_audit_receipt is not None:
            parser.error("M5 uses --m5-prior-look-receipt only")
        experiment = f"m5-{args.m5_profile}"
    else:
        experiment = args.experiment
    search_ab = args.strategy_a == "search" and args.strategy_b == "search"
    if args.m5_profile is not None:
        if not search_ab:
            parser.error("M5 requires search-v-search")
        try:
            import protocol as m5_protocol
            m5_protocol.validate_runner_profile(args.m5_profile, {
                "look": args.look, "global_round_start": args.global_round_start,
                "global_round_count": global_round_count, "games": args.games, "nodes": args.nodes,
                "seed": args.seed, "max_ply": args.max_ply, "workers": args.workers,
                "engine_timeout": args.engine_timeout,
            }, engine_a_options, engine_b_options)
        except ValueError as error:
            parser.error(str(error))
    elif experiment is not None:
        if not search_ab:
            parser.error("--experiment applies only to search-v-search")
        expected_a, expected_b = search_ab_options(experiment)
        if engine_a_options != expected_a or engine_b_options != expected_b:
            parser.error(f"{experiment} experiment requires A options {expected_a} and B options {expected_b}")
    elif search_ab and engine_a_options == {"CheckExtensions": "true"} and engine_b_options == {"CheckExtensions": "false"}:
        # Keep legacy CheckExtensions commands reproducible while naming their manifest identity.
        experiment = "check-extensions"
    elif search_ab and args.games == 200 and selection is not None:
        parser.error("formal search A/B requires an explicit --experiment and its locked A/B options")
    try:
        engine_a_metadata = executable_metadata(args.engine_a)
        engine_b_metadata = executable_metadata(args.engine_b)
    except (OSError, ValueError) as error:
        parser.error(f"invalid engine executable: {error}")

    if args.m5_profile is not None:
        try:
            candidate_lock = m5_protocol.verify_lock(args.m5_candidate_lock)
        except ValueError as error:
            parser.error(f"invalid M5 candidate lock: {error}")
        if (engine_a_metadata["sha256"] != candidate_lock["binary_sha256"]
                or engine_b_metadata["sha256"] != candidate_lock["binary_sha256"]):
            parser.error("M5 A/B must use the exact immutable binary from candidate lock")
        import shlex
        expected_binary = Path(json.loads(Path(args.m5_candidate_lock).read_text())["binary_path"]).resolve()
        if any(Path(shlex.split(command)[0]).resolve() != expected_binary for command in (args.engine_a, args.engine_b)):
            parser.error("M5 engine command path differs from candidate lock binary")
        if args.look == 1:
            if args.m5_prior_look_receipt is not None:
                parser.error("M5 look 1 cannot include a prior receipt")
        else:
            if args.m5_prior_look_receipt is None:
                parser.error("M5 look 2 requires --m5-prior-look-receipt")
            try:
                m5_protocol.validate_prior_receipt(args.m5_prior_look_receipt, candidate_lock, selection["sample_sha256"])
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                parser.error(f"invalid M5 look 1 receipt: {error}")
    product_provenance = None
    if experiment == "integration-nonregression":
        for name, value in (("--expected-engine-a-sha256", args.expected_engine_a_sha256),
                            ("--expected-engine-b-sha256", args.expected_engine_b_sha256),
                            ("--product-source-head", args.product_source_head),
                            ("--product-core-sha256", args.product_core_sha256),
                            ("--product-build-proof", args.product_build_proof),
                            ("--expected-product-build-proof-sha256", args.expected_product_build_proof_sha256)):
            if not value:
                parser.error(f"integration-nonregression requires {name}")
        try:
            validate_integration_nonregression_profile(
                strategy_a=args.strategy_a, strategy_b=args.strategy_b, games=args.games,
                nodes=args.nodes, global_round_start=args.global_round_start,
                global_round_count=global_round_count, seed=args.seed, max_ply=args.max_ply,
                workers=args.workers, engine_timeout=args.engine_timeout,
                options_a=engine_a_options, options_b=engine_b_options,
                actual_a=engine_a_metadata["sha256"], actual_b=engine_b_metadata["sha256"],
                expected_a=args.expected_engine_a_sha256, expected_b=args.expected_engine_b_sha256,
                selection=selection,
            )
        except ValueError as error:
            parser.error(str(error))
        try:
            product_provenance = validate_product_provenance(
                repo_root=Path(__file__).resolve().parents[2], source_head=args.product_source_head,
                expected_core_sha256=args.product_core_sha256, build_proof=args.product_build_proof,
                expected_build_proof_sha256=args.expected_product_build_proof_sha256,
            )
        except (OSError, ValueError) as error:
            parser.error(str(error))
        decision_protocol_verified = True

    formal_candidate = bool(
        search_ab and args.games == 200 and selection is not None
        and selection.get("full_selected_sample")
        and selection.get("frozen_protocol_verified")
    )
    decision_protocol_verified = args.m5_profile is not None or experiment == "integration-nonregression"
    if args.m5_profile is not None:
        if not formal_candidate:
            parser.error("M5 requires its verified complete ordered-100 sample")
    elif experiment == "correctness-repair":
        if args.games != 200:
            parser.error("formal correctness-repair protocol requires games=200")
        if selection is None or not selection.get("full_selected_sample") or not selection.get("frozen_protocol_verified"):
            parser.error("formal correctness-repair protocol requires the full frozen 50-opening selection")
        if args.nodes != 10000:
            parser.error("formal correctness-repair protocol requires nodes=10000")
        if args.seed != 1:
            parser.error("formal correctness-repair protocol requires seed=1")
        if args.max_ply != 4096:
            parser.error("formal correctness-repair protocol requires max-ply=4096")
        if global_round_count != 2 or args.global_round_start != 1:
            parser.error("formal correctness-repair protocol requires rounds 1–2")
        if args.look != 1:
            parser.error("formal correctness-repair protocol requires look=1")
        if args.workers != 4:
            parser.error("formal correctness-repair protocol requires workers=4")
        if args.engine_timeout != 30.0:
            parser.error("formal correctness-repair protocol requires engine-timeout=30")
        if engine_a_options != {} or engine_b_options != {}:
            parser.error("formal correctness-repair protocol requires A and B options to be {}")
        if engine_a_metadata["sha256"] == engine_b_metadata["sha256"]:
            parser.error("formal correctness-repair protocol requires distinct executable SHA-256")
        decision_protocol_verified = True
    elif formal_candidate and experiment != "integration-nonregression":
        required_start = 1 if args.look == 1 else 3
        if args.games != 200:
            parser.error(f"formal {experiment or 'search A/B'} protocol requires games=200")
        if experiment is None:
            parser.error("formal search A/B requires an explicit --experiment and its locked A/B options")
        if args.nodes != 10000:
            parser.error(f"formal {experiment} protocol requires nodes=10000")
        if args.seed != 1:
            parser.error(f"formal {experiment} protocol requires seed=1")
        if args.max_ply != 4096:
            parser.error(f"formal {experiment} protocol requires max-ply=4096")
        if global_round_count != 2 or args.global_round_start != required_start:
            parser.error(
                f"formal {experiment} protocol look {args.look} requires rounds {required_start}–{required_start + 1}"
            )
        if engine_a_metadata["sha256"] != engine_b_metadata["sha256"]:
            parser.error("formal search A/B must use identical executable SHA-256")
        decision_protocol_verified = True

    if experiment == "composite-root-alpha-check-extensions":
        try:
            validate_composite_profile(
                look=args.look, global_round_start=args.global_round_start,
                global_round_count=global_round_count, games=args.games,
                nodes=args.nodes, max_ply=args.max_ply, seed=args.seed,
                workers=args.workers, engine_timeout=args.engine_timeout,
                engine_a_options=engine_a_options, engine_b_options=engine_b_options,
                engine_a_sha256=engine_a_metadata["sha256"],
                engine_b_sha256=engine_b_metadata["sha256"], selection=selection,
            )
        except ValueError as error:
            parser.error(str(error))
        decision_protocol_verified = True
        if args.look == 1:
            if args.prior_look_summary is not None or args.prior_look_audit_receipt is not None:
                parser.error("look 1 cannot reference prior-look evidence")
            prior_look = None
        else:
            if args.prior_look_summary is None:
                parser.error("composite look 2 requires --prior-look-summary")
            if args.prior_look_audit_receipt is None:
                parser.error("composite look 2 requires --prior-look-audit-receipt")
            try:
                prior_look = validate_composite_prior_look(
                    args.prior_look_summary, selection, args.prior_look_audit_receipt,
                )
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                parser.error(f"invalid composite look 1 summary: {error}")
    else:
        prior_look = None

    if args.baseline_profile in ("final-ra-ce", "final-ra-ce-kh"):
        if args.strategy_a != "search" or args.strategy_b not in ("random", "greedy"):
            parser.error(f"{args.baseline_profile} profile requires search vs random or greedy")
        if args.games != 200 or args.nodes != 10000 or args.seed != 1:
            parser.error(f"{args.baseline_profile} profile requires games=200, nodes=10000, seed=1")
        if args.max_ply != 4096 or args.engine_timeout != 30.0 or args.workers != 4:
            parser.error(f"{args.baseline_profile} profile requires max-ply=4096, engine-timeout=30, workers=4")
        if global_round_count != 2 or args.global_round_start not in (1, 3, 5, 7, 9):
            parser.error(f"{args.baseline_profile} profile requires one of the five fixed two-round batches")
        if args.look != 1 or args.experiment is not None:
            parser.error(f"{args.baseline_profile} profile does not use search A/B experiment/look fields")
        if (selection is None or not selection.get("full_selected_sample")
                or not selection.get("frozen_protocol_verified") or len(openings) != 50):
            parser.error(f"{args.baseline_profile} profile requires the verified full frozen 50-opening sample")
        final_options = baseline_profile_options(args.baseline_profile)
        if engine_a_options != final_options or engine_b_options != final_options:
            parser.error(f"{args.baseline_profile} profile requires its exact explicit options on both sides")
        if engine_a_metadata["sha256"] != engine_b_metadata["sha256"]:
            parser.error(f"{args.baseline_profile} profile requires the same immutable binary on both sides")

    if args.output.exists() and any(args.output.iterdir()):
        parser.error("output directory is not empty; choose a new path to preserve prior run evidence")
    args.output.mkdir(parents=True, exist_ok=True)
    games_path = args.output / "games.jsonl"
    run_manifest_path = args.output / "run-manifest.json"
    scores: dict[str, list[float]] = {opening["id"]: [] for opening in openings}
    totals = {"win": 0, "draw": 0, "loss": 0, "unfinished": 0}
    games_path.write_text("", encoding="utf-8")
    global_rounds = range(args.global_round_start, args.global_round_start + global_round_count)
    run_manifest = {
        "schema_version": "m4-match-batch-v1",
        "experiment": experiment,
        "baseline_profile": args.baseline_profile,
        "global_round_start": args.global_round_start,
        "global_round_count": global_round_count,
        "global_rounds": list(global_rounds),
        "look": args.look,
        "requested_games": args.games,
        "workers": args.workers,
        "raw_trace_layout": (
            "engine-a.log and engine-b.log with game context markers" if args.workers == 1
            else "workers/worker-NN/engine-a.log and engine-b.log with game context markers"
        ),
        "master_seed": args.seed,
        "nodes_per_move": args.nodes,
        "max_ply": args.max_ply,
        "strategy_a": args.strategy_a,
        "strategy_b": args.strategy_b,
        "candidate_side": "A",
        "baseline_side": "B",
        "engine_a_options": engine_a_options,
        "engine_b_options": engine_b_options,
        "openings_sha256": hashlib.sha256(args.openings.read_bytes()).hexdigest(),
        "selection_protocol_sha256": (
            hashlib.sha256(args.selection_protocol.read_bytes()).hexdigest()
            if args.selection_protocol is not None else None
        ),
        "future_selection_manifest_sha256": (
            hashlib.sha256(args.future_selection_manifest.read_bytes()).hexdigest()
            if args.future_selection_manifest is not None else None
        ),
        "engine_timeout_seconds": args.engine_timeout,
        "prior_look": prior_look,
        "selection": selection,
        "m5_profile": args.m5_profile,
        "product_provenance": product_provenance,
        "expected_engine_a_sha256": args.expected_engine_a_sha256 if experiment == "integration-nonregression" else None,
        "expected_engine_b_sha256": args.expected_engine_b_sha256 if experiment == "integration-nonregression" else None,
        "m5_candidate_id": selection.get("candidate_id") if args.m5_profile else None,
        "m5_candidate_lock_sha256": selection.get("candidate_lock_sha256") if args.m5_profile else None,
        "m5_sample_sha256": selection.get("sample_sha256") if args.m5_profile else None,
        "m5_prior_receipt_sha256": (hashlib.sha256(args.m5_prior_look_receipt.read_bytes()).hexdigest()
                                     if args.m5_profile and args.m5_prior_look_receipt else None),
        "engine_a_command": args.engine_a,
        "engine_b_command": args.engine_b,
        "engine_a_executable": engine_a_metadata,
        "engine_b_executable": engine_b_metadata,
        "runner_source_sha256": hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest(),
        "runner_git_head": subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip(),
    }
    run_manifest["caller_head"] = run_manifest["runner_git_head"]
    run_manifest["config_sha256"] = hashlib.sha256(
        json.dumps(run_manifest, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    run_manifest_path.write_text(json.dumps(run_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    games_written, totals, pair_results = run_games_in_workers(
        openings=openings, global_rounds=global_rounds, args=args,
        engine_a_options=engine_a_options, engine_b_options=engine_b_options,
        games_path=games_path,
    )
    for (_, opening_id), pair in pair_results.items():
        if "red" in pair and "black" in pair:
            scores_for_pair = sum({"win": 1.0, "draw": 0.5, "loss": 0.0}[pair[color]] for color in ("red", "black")) / 2
            scores[opening_id].append(scores_for_pair)
    summary = summarize_results(
        requested_games=args.games,
        totals=totals,
        opening_scores=scores,
        strategy_a=args.strategy_a,
        strategy_b=args.strategy_b,
        population_size=selection["population_size"] if selection else None,
        finite_population_verified=bool(selection and selection["full_selected_sample"]),
        selected_opening_count=len(openings),
        look=args.look,
        nodes_per_move=args.nodes,
        selection_verified=bool(selection and selection.get("frozen_protocol_verified") and selection["full_selected_sample"]),
        paired_games_complete=(args.games == 1000 and len(openings) == 50 and totals["unfinished"] == 0),
        decision_protocol_verified=decision_protocol_verified,
    )
    summary.update({
        "engine_a": args.engine_a,
        "engine_b": args.engine_b,
        "engine_a_executable": engine_a_metadata,
        "engine_b_executable": engine_b_metadata,
        "engine_a_options": engine_a_options,
        "engine_b_options": engine_b_options,
        "candidate_side": "A",
        "baseline_side": "B",
        "nodes": args.nodes,
        "max_ply": args.max_ply,
        "global_rounds": list(range(args.global_round_start, args.global_round_start + global_round_count)),
        "opening_count": len(openings),
        "seed": args.seed,
        "workers": args.workers,
        "engine_timeout_seconds": args.engine_timeout,
        "games_written": games_written,
        "selection_protocol": selection,
        "experiment": experiment,
        "m5_profile": args.m5_profile,
        "m5_candidate_id": selection.get("candidate_id") if args.m5_profile else None,
        "m5_candidate_lock_sha256": selection.get("candidate_lock_sha256") if args.m5_profile else None,
        "m5_sample_sha256": selection.get("sample_sha256") if args.m5_profile else None,
        "baseline_profile": args.baseline_profile,
        "run_manifest_sha256": hashlib.sha256(run_manifest_path.read_bytes()).hexdigest(),
        "run_manifest_path": str(run_manifest_path.resolve()),
        "note": "Repeat rounds on an opening updates its cluster score but does not increase the effective cluster count.",
    })
    if args.m5_profile is not None:
        summary["formal_decision_ready"] = False
        summary["decision_status"] = "await_m5_raw_game_audit"
    if experiment == "composite-root-alpha-check-extensions" and args.look == 2:
        summary["formal_decision_ready"] = False
        summary["decision_status"] = "await_combined_audit"
        summary["single_look_diagnostic_only"] = True
    if experiment == "integration-nonregression":
        summary["integration_nonregression_gate"] = integration_nonregression_gate(
            totals, requested_games=args.games, protocol_verified=decision_protocol_verified,
        )
        summary["formal_decision_ready"] = False
        summary["decision_status"] = "await_raw_game_audit"
    if experiment == "correctness-repair":
        gate = correctness_repair_gate(
            totals, requested_games=args.games, protocol_verified=decision_protocol_verified,
        )
        summary["correctness_repair_gate"] = gate
        summary["decision_status"] = (
            "inconclusive" if not gate["complete"] else
            "non_regression_pass" if gate["passed"] else
            "non_regression_floor_not_met"
        )
    args.output.joinpath("summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, allow_nan=True))
    if not summary["complete"]:
        return 2
    if experiment == "correctness-repair" and not summary["correctness_repair_gate"]["passed"]:
        return 1
    if experiment == "integration-nonregression" and not summary["integration_nonregression_gate"]["provisional_pass"]:
        return 1
    if summary["baseline_gate"] and summary["baseline_gate"]["eligible_for_formal_gate"] and not summary["baseline_gate"]["passed"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

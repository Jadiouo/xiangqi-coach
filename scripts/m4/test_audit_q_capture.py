import hashlib
import json
import math
import subprocess
import tempfile
import unittest
from pathlib import Path

from audit_q_capture import calculate_cluster_statistics, read_run_evidence, validate_preregistration


ROOT = Path(__file__).parents[2]
OPENINGS = ROOT / "docs/research/m4-openings/selected-50.tsv"
SELECTION = ROOT / "docs/research/m4-openings/opening-selection-protocol.json"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def seal(config: dict) -> None:
    config.pop("preregistration_sha256", None)
    config["preregistration_sha256"] = hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def write_ref(path: Path) -> dict:
    return {"path": str(path.resolve()), "sha256": sha(path)}


def make_checkout(root: Path) -> tuple[Path, dict]:
    checkout = root / "source-checkout"
    checkout.mkdir()
    subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    files = {}
    for relative, content in (
        ("scripts/m4/match.py", "locked runner source\n"),
        ("crates/xq-engine/src/lib.rs", "locked q candidate source\n"),
        ("scripts/m4/audit_q_capture.py", "locked auditor source\n"),
    ):
        path = checkout / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        files[relative] = path
    subprocess.run(["git", "-C", str(checkout), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(checkout), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
         "commit", "-qm", "fixture"], check=True,
    )
    head = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"], check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    return checkout, {"head": head, "files": files}


def make_run_paths(root: Path, name: str) -> dict:
    run = root / name
    logs = {}
    for worker in range(1, 5):
        for actor in ("a", "b"):
            relative = f"workers/worker-{worker:02d}/engine-{actor}.log"
            logs[relative] = str((run / relative).resolve())
    launcher = root / f"{name}-launcher"
    return {
        "output_dir": str(run.resolve()),
        "manifest_path": str((run / "run-manifest.json").resolve()),
        "games_path": str((run / "games.jsonl").resolve()),
        "summary_path": str((run / "summary.json").resolve()),
        "raw_log_paths": logs,
        "launcher_dir": str(launcher.resolve()),
        "command_path": str((launcher / "command.json").resolve()),
        "launch_metadata_path": str((launcher / "launch.json").resolve()),
        "stdout_path": str((launcher / "stdout.log").resolve()),
        "stderr_path": str((launcher / "stderr.log").resolve()),
        "exit_status_path": str((launcher / "exit-status.json").resolve()),
        "audit_result_path": str((launcher / "audit-result.json").resolve()),
    }


def make_config(root: Path, *, look: int = 1, prior_look=None) -> tuple[dict, dict]:
    checkout, repo = make_checkout(root)
    binary = root / "immutable-xq-uci"
    binary.write_bytes(b"frozen executable bytes")
    replay = root / "immutable-replay"
    replay.write_bytes(b"frozen replay bytes")
    inputs = {
        "openings_tsv": write_ref(OPENINGS),
        "selection_protocol": write_ref(SELECTION),
    }
    protocol = json.loads(SELECTION.read_text(encoding="utf-8"))
    for name, key in (
        ("eligible_population", "eligible_population_path"),
        ("selected_population", "selected_population_path"),
    ):
        path = (SELECTION.parent / protocol[key]).resolve()
        inputs[name] = write_ref(path)
    inputs["replay_executable"] = write_ref(replay)
    rounds = [1, 2] if look == 1 else [3, 4]
    run = make_run_paths(root, f"look{look}")
    config = {
        "schema_version": "m4-q-capture-preregistration-v1",
        "preregistration_path": str((root / f"look{look}-preregistration.json").resolve()),
        "experiment": "q-capture-order",
        "look": look,
        "global_rounds": rounds,
        "requested_games": 200,
        "nodes_per_move": 10000,
        "max_ply": 4096,
        "master_seed": 1,
        "workers": 4,
        "strategy_a": "search",
        "strategy_b": "search",
        "candidate_side": "A",
        "baseline_side": "B",
        "engine_a_options": {"QCaptureOrder": "true"},
        "engine_b_options": {"QCaptureOrder": "false"},
        "runner": {
            "checkout_path": str(checkout.resolve()), "checkout_head": repo["head"],
            "source_path": str(repo["files"]["scripts/m4/match.py"].resolve()),
            "source_sha256": sha(repo["files"]["scripts/m4/match.py"]),
        },
        "engine_source": {
            "checkout_path": str(checkout.resolve()), "checkout_head": repo["head"],
            "source_path": str(repo["files"]["crates/xq-engine/src/lib.rs"].resolve()),
            "source_sha256": sha(repo["files"]["crates/xq-engine/src/lib.rs"]),
        },
        "binary": {"path": str(binary.resolve()), "sha256": sha(binary)},
        "auditor": {
            "checkout_path": str(checkout.resolve()), "checkout_head": repo["head"],
            "source_path": str(repo["files"]["scripts/m4/audit_q_capture.py"].resolve()),
            "source_sha256": sha(repo["files"]["scripts/m4/audit_q_capture.py"]),
        },
        "inputs": inputs,
        "run": run,
        "prior_look": prior_look,
        "runner_argv": [
            "python3", str(repo["files"]["scripts/m4/match.py"]), "--engine-a", str(binary), "--engine-b", str(binary),
            "--experiment", "q-capture-order", "--engine-a-options", '{"QCaptureOrder":"true"}',
            "--engine-b-options", '{"QCaptureOrder":"false"}', "--strategy-a", "search",
            "--strategy-b", "search", "--openings", inputs["openings_tsv"]["path"],
            "--selection-protocol", inputs["selection_protocol"]["path"], "--nodes", "10000",
            "--games", "200", "--global-round-start", str(rounds[0]),
            "--global-round-count", "2", "--max-ply", "4096", "--seed", "1", "--look", str(look),
            "--workers", "4", "--output", run["output_dir"],
        ],
    }
    seal(config)
    return config, repo


def write_launcher_evidence(config, command_override=None, launch_override=None):
    run = config["run"]
    prereg = Path(config["preregistration_path"])
    prereg.parent.mkdir(parents=True, exist_ok=True)
    prereg.write_text(json.dumps(config, sort_keys=True), encoding="utf-8")
    command = {
        "schema_version": "m4-q-capture-command-v1",
        "cwd": config["runner"]["checkout_path"],
        "command": list(config["runner_argv"]),
        "engine_sha256": config["binary"]["sha256"],
        "output": run["output_dir"],
    }
    launch = {
        "schema_version": "m4-q-capture-launch-v1",
        "pid": 12345,
        "pgid": 12345,
        "sid": 12345,
        "started_unix": 1791338368.0,
        "cwd": config["runner"]["checkout_path"],
        "runner_head": config["runner"]["checkout_head"],
        "runner_source_path": config["runner"]["source_path"],
        "runner_source_sha256": config["runner"]["source_sha256"],
        "command": run["command_path"],
        "preregistration": config["preregistration_path"],
        "preregistration_sha256": sha(prereg),
        "log": run["stdout_path"],
        "stderr": run["stderr_path"],
        "exit_status": run["exit_status_path"],
        "output": run["output_dir"],
        "engine_sha256": config["binary"]["sha256"],
        "runner_pid": 12346,
    }
    for path_value, value in ((run["command_path"], command_override or command),
                              (run["launch_metadata_path"], launch_override or launch)):
        path = Path(path_value)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
    return command, launch


class QCapturePreregistrationTests(unittest.TestCase):
    def _write_run_files(self, root, config):
        run=config["run"]
        for key in ("manifest_path", "games_path", "summary_path", "stdout_path", "stderr_path"):
            path=Path(run[key]);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(key,encoding="utf-8")
        for value in run["raw_log_paths"].values():
            path=Path(value);path.parent.mkdir(parents=True,exist_ok=True);path.write_text("raw\n",encoding="utf-8")
        exit_path=Path(run["exit_status_path"]);exit_path.parent.mkdir(parents=True,exist_ok=True)
        exit_path.write_text('{"exit_code":0}',encoding="utf-8")

    def test_launcher_evidence_requires_exact_json_argv_and_real_checkout_identity(self):
        cases=("arbitrary-command-text","invalid-command-json","command-wrong-cwd","command-wrong-engine-sha",
               "command-wrong-output","arbitrary-launch-text","invalid-launch-json",
               "missing-launch-field","extra-launch-field","missing-argv","extra-argv",
               "different-binary","wrong-flags","wrong-cwd","wrong-head","wrong-source-path",
               "wrong-source-hash","wrong-launch-binary","wrong-preregistration-hash")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);config,_=make_config(root);self._write_run_files(root,config)
                command,launch=write_launcher_evidence(config)
                command_path=Path(config["run"]["command_path"])
                launch_path=Path(config["run"]["launch_metadata_path"])
                if case=="arbitrary-command-text":
                    command_path.write_text("this is not evidence",encoding="utf-8")
                elif case=="invalid-command-json":
                    command_path.write_text("{",encoding="utf-8")
                elif case=="arbitrary-launch-text":
                    launch_path.write_text("this is not evidence",encoding="utf-8")
                elif case=="invalid-launch-json":
                    launch_path.write_text("{",encoding="utf-8")
                elif case in ("command-wrong-cwd","command-wrong-engine-sha","command-wrong-output"):
                    field={"command-wrong-cwd":"cwd","command-wrong-engine-sha":"engine_sha256",
                           "command-wrong-output":"output"}[case]
                    command[field]="/forged/value"
                    command_path.write_text(json.dumps(command),encoding="utf-8")
                elif case in ("missing-argv","extra-argv","different-binary","wrong-flags"):
                    if case=="missing-argv": command["command"].remove("--nodes")
                    elif case=="extra-argv": command["command"] += ["--nodes","1"]
                    elif case=="different-binary": command["command"][command["command"].index("--engine-b")+1]=str(root/"other-engine")
                    else: command["command"][command["command"].index("--engine-a-options")+1]='{"QCaptureOrder":"false"}'
                    command_path.write_text(json.dumps(command),encoding="utf-8")
                elif case in ("missing-launch-field","extra-launch-field"):
                    if case=="missing-launch-field": del launch["runner_head"]
                    else: launch["unbound"]="value"
                    launch_path.write_text(json.dumps(launch),encoding="utf-8")
                else:
                    fields={"wrong-cwd":("cwd",str(root)),"wrong-head":("runner_head","f"*40),
                            "wrong-source-path":("runner_source_path",str(root/"other.py")),
                            "wrong-source-hash":("runner_source_sha256","0"*64),
                            "wrong-launch-binary":("engine_sha256","0"*64),
                            "wrong-preregistration-hash":("preregistration_sha256","0"*64)}
                    key,value=fields[case];launch[key]=value
                    launch_path.write_text(json.dumps(launch),encoding="utf-8")
                with self.assertRaisesRegex(ValueError,"launcher command evidence|launcher launch evidence"):
                    read_run_evidence(config)

    def test_cluster_statistics_keep_effective_n_at_fifty(self):
        bykey = {}
        for index in range(50):
            opening_id = f"opening-{index:02d}"
            result = "win" if index < 25 else "loss"
            for color in (True, False):
                for round_number in (1, 2):
                    bykey[(opening_id, color, round_number)] = ((), "draw", result)
        stats = calculate_cluster_statistics(bykey, (1, 2))
        self.assertEqual(stats["cluster_count"], 50)
        self.assertEqual(stats["score_mean"], 0.5)
        margin = math.sqrt((1 - 49 / 203) * math.log(80) / 100)
        self.assertAlmostEqual(stats["decision_97_5_score_interval"][0], 0.5 - margin)
        self.assertAlmostEqual(stats["decision_97_5_score_interval"][1], 0.5 + margin)
        for opening_id in range(50):
            for color in (True, False):
                bykey[(f"opening-{opening_id:02d}", color, 3)] = bykey[(f"opening-{opening_id:02d}", color, 1)]
                bykey[(f"opening-{opening_id:02d}", color, 4)] = bykey[(f"opening-{opening_id:02d}", color, 2)]
        combined = calculate_cluster_statistics(bykey, (1, 2, 3, 4))
        self.assertEqual(combined["cluster_count"], 50)
        self.assertEqual(combined["decision_97_5_score_interval"], stats["decision_97_5_score_interval"])

    def test_locked_look1_configuration_accepts_missing_future_output_files(self):
        with tempfile.TemporaryDirectory() as directory:
            config, _ = make_config(Path(directory))
            loaded = validate_preregistration(config)
            self.assertEqual(loaded["run"]["games_path"], config["run"]["games_path"])
            self.assertIsNone(loaded["prior_look"])

    def test_non_q_profile_flags_or_formal_parameters_are_rejected(self):
        mutations = [
            ("nodes_per_move", 1),
            ("max_ply", 200),
            ("workers", 1),
            ("global_rounds", [2, 3]),
            ("engine_a_options", {"QCaptureOrder": "true", "MoveHints": "false"}),
            ("engine_b_options", {"QCaptureOrder": "true"}),
        ]
        for key, value in mutations:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                config, _ = make_config(Path(directory))
                config[key] = value
                seal(config)
                with self.assertRaisesRegex(ValueError, "fixed q-capture-order profile"):
                    validate_preregistration(config)

    def test_source_or_binary_hash_mismatch_is_rejected(self):
        for ref_name in ("runner", "engine_source", "binary", "auditor"):
            with self.subTest(ref=ref_name), tempfile.TemporaryDirectory() as directory:
                config, _ = make_config(Path(directory))
                config[ref_name]["sha256" if ref_name == "binary" else "source_sha256"] = "0" * 64
                seal(config)
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    validate_preregistration(config)

    def test_actual_runner_checkout_head_must_match_preregistration(self):
        with tempfile.TemporaryDirectory() as directory:
            config, _ = make_config(Path(directory))
            config["runner"]["checkout_head"] = "0" * 40
            seal(config)
            with self.assertRaisesRegex(ValueError, "runner: checkout HEAD mismatch"):
                validate_preregistration(config)

    def test_look2_requires_prior_look_artifact_paths_and_actual_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prior_root = root / "prior"
            prior_root.mkdir()
            first_config, _ = make_config(prior_root, look=1)
            previous = first_config["run"]
            previous_hashes = {}
            for key in ("manifest_path", "games_path", "summary_path", "command_path", "launch_metadata_path",
                        "stdout_path", "stderr_path", "exit_status_path", "audit_result_path"):
                path = Path(previous[key])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"exit_code": 0}) if key == "exit_status_path" else key)
                previous_hashes[key] = sha(path)
            first_ref = root / "look1-preregistration.json"
            first_config["preregistration_path"] = str(first_ref.resolve())
            seal(first_config)
            first_ref.write_text(json.dumps(first_config))
            prior = {
                "preregistration_path": str(first_ref.resolve()),
                "preregistration_sha256": sha(first_ref),
                "run": previous,
                "artifact_sha256": previous_hashes,
            }
            second_root = root / "second"
            second_root.mkdir()
            second, _ = make_config(second_root, look=2, prior_look=prior)
            for key in ("runner", "engine_source", "auditor", "binary", "inputs"):
                second[key] = first_config[key]
            second_argv = second["runner_argv"]
            for index, value in enumerate(second_argv):
                if value == str(second_root / "source-checkout" / "scripts/m4/match.py"):
                    second_argv[index] = first_config["runner"]["source_path"]
                if value == str(second_root / "immutable-xq-uci"):
                    second_argv[index] = first_config["binary"]["path"]
            seal(second)
            self.assertEqual(validate_preregistration(second)["look"], 2)
            second["prior_look"]["artifact_sha256"]["games_path"] = "0" * 64
            seal(second)
            with self.assertRaisesRegex(ValueError, "prior look artifact SHA-256 mismatch"):
                validate_preregistration(second)

    def test_look2_without_prior_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            config, _ = make_config(Path(directory), look=2)
            with self.assertRaisesRegex(ValueError, "look 2 requires prior_look"):
                validate_preregistration(config)

    def test_completed_run_uses_only_exact_paths_from_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, _ = make_config(root)
            run = config["run"]
            for key in ("manifest_path", "games_path", "summary_path", "command_path", "launch_metadata_path",
                        "stdout_path", "stderr_path", "audit_result_path"):
                path = Path(run[key])
                path.parent.mkdir(parents=True, exist_ok=True)
                if key not in ("command_path", "launch_metadata_path"):
                    path.write_text(key, encoding="utf-8")
            for path in run["raw_log_paths"].values():
                target = Path(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("raw\n", encoding="utf-8")
            exit_path = Path(run["exit_status_path"])
            exit_path.parent.mkdir(parents=True, exist_ok=True)
            exit_path.write_text('{"exit_code":0}', encoding="utf-8")
            command, launch = write_launcher_evidence(config)
            evidence = read_run_evidence(config)
            self.assertEqual(evidence["manifest_path"], run["manifest_path"])
            self.assertEqual(evidence["games_sha256"], sha(Path(run["games_path"])))
            self.assertEqual(evidence["exit_status"]["exit_code"], 0)
            exit_path.unlink()
            with self.assertRaisesRegex(ValueError, "configured exit_status_path path is missing"):
                read_run_evidence(config)


if __name__ == "__main__":
    unittest.main()

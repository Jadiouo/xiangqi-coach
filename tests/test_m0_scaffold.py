"""M0 integration checks for the repository scaffold's public build contract."""
from pathlib import Path
import hashlib
import json
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_CRATES = ["xq-core", "xq-engine", "xq-review", "xq-uci", "xq-wasm"]
PRESERVED_SPEC_SHA256 = {
    "BACKGROUND": "28b0e0db814afb2d1b134f1119fab0a02847c2144f668c2ee84cc679d41f987e",
    "SPEC": "32b6216ae8f1885e8973f35cc1bfb3dc7cb8f6d2cf12e2c84e41fa60b6f3274a",
    "TEST_PLAN": "f632e0a1f8f41cf17f5f9706bd04735e826eaba63a052d0ff9f762d58370b2f3",
    "TASKS": "3aaf453417ac65f755c103429270b77dfa6992a2428651e336263e6e578a9241",
}


class ScaffoldContractTests(unittest.TestCase):
    def test_documented_specs_are_available_at_the_paths_agents_are_told_to_read(self):
        sources = (ROOT / "docs" / "SOURCES.md").read_text()
        self.assertIn("docs/xiangqi-coach/docs/", sources)
        self.assertIn("原始檔保留不動", sources)
        self.assertIn("後續工作以根目錄 `docs/` 副本為準", sources)
        for name in ("BACKGROUND", "SPEC", "TEST_PLAN", "TASKS"):
            with self.subTest(document=name):
                canonical = ROOT / "docs" / f"{name}.md"
                original = ROOT / "docs" / "xiangqi-coach" / "docs" / f"{name}.md"
                self.assertTrue(canonical.is_file(), f"missing canonical {canonical}")
                self.assertTrue(original.is_file(), f"original source must be preserved: {original}")
                actual_sha256 = hashlib.sha256(original.read_bytes()).hexdigest()
                self.assertEqual(actual_sha256, PRESERVED_SPEC_SHA256[name])

    def test_cargo_workspace_contains_the_five_specified_crates(self):
        workspace = tomllib.loads((ROOT / "Cargo.toml").read_text())
        self.assertEqual(workspace["workspace"]["members"], [f"crates/{name}" for name in EXPECTED_CRATES])
        for name in EXPECTED_CRATES:
            manifest = tomllib.loads((ROOT / "crates" / name / "Cargo.toml").read_text())
            self.assertEqual(manifest["package"]["name"], name)
            source = "main.rs" if name == "xq-uci" else "lib.rs"
            self.assertTrue((ROOT / "crates" / name / "src" / source).is_file())

    def test_engine_crate_dependencies_follow_the_specified_direction(self):
        dependencies = {}
        for name in EXPECTED_CRATES:
            manifest = tomllib.loads((ROOT / "crates" / name / "Cargo.toml").read_text())
            dependencies[name] = set(manifest.get("dependencies", {})) & set(EXPECTED_CRATES)
        order = {"xq-core": 0, "xq-engine": 1, "xq-review": 2, "xq-uci": 3, "xq-wasm": 3}
        required_edges = (
            ("xq-engine", "xq-core"),
            ("xq-review", "xq-engine"),
            ("xq-uci", "xq-review"),
            ("xq-wasm", "xq-review"),
        )
        for source, target in required_edges:
            with self.subTest(edge=f"{source} -> {target}"):
                self.assertIn(target, dependencies[source])
        for source, targets in dependencies.items():
            for target in targets:
                with self.subTest(edge=f"{source} -> {target}"):
                    self.assertLess(order[target], order[source], "crate dependencies must point downward")

    def test_core_and_engine_sources_do_not_acquire_impure_resources(self):
        forbidden = ("std::fs", "std::net", "std::time", "SystemTime", "Instant", "rand::", "getrandom")
        for name in ("xq-core", "xq-engine"):
            crate_source = ROOT / "crates" / name / "src"
            sources = list(crate_source.rglob("*.rs"))
            if name == "xq-core":
                lib_source = (crate_source / "lib.rs").read_text()
                self.assertRegex(lib_source, r"(?m)^#\[cfg\(test\)\]\s+mod tests;")
                sources = [source for source in sources if source.name != "tests.rs"]
            contents = "\n".join(source.read_text() for source in sources)
            with self.subTest(crate=name):
                for token in forbidden:
                    self.assertNotIn(token, contents)

    def test_web_project_exposes_real_build_typecheck_and_test_commands(self):
        package = json.loads((ROOT / "web" / "package.json").read_text())
        for script in ("build", "typecheck", "test"):
            self.assertIn(script, package["scripts"])
            self.assertTrue(package["scripts"][script].strip())
        html = (ROOT / "web" / "index.html").read_text()
        self.assertIn('id="app"', html)
        self.assertIn('type="module"', html)

    def test_make_check_runs_each_required_validation_layer(self):
        makefile = (ROOT / "Makefile").read_text()
        self.assertIn("check:", makefile)
        self.assertIn(
            "cargo test -p xq-core --release --features perft-performance --lib "
            "tests::release_initial_perft_depth_four_finishes_under_one_second "
            "-- --exact --nocapture --test-threads=1",
            makefile,
            "the timed perft case must run alone to avoid parallel perft contention",
        )
        for required in (
            "cargo fmt --all -- --check",
            "cargo clippy --workspace --all-targets -- -D warnings",
            "cargo test --workspace",
            "cargo build -p xq-wasm --target wasm32-unknown-unknown && test -s target/wasm32-unknown-unknown/debug/xq_wasm.wasm",
            "npm run typecheck",
            "npm test",
            "npm run build",
        ):
            with self.subTest(command=required):
                self.assertIn(required, makefile)

    def test_ci_runs_normal_checks_and_scheduled_or_manual_slow_checks(self):
        workflow = ROOT / ".github" / "workflows" / "ci.yml"
        self.assertTrue(workflow.is_file())
        content = workflow.read_text()
        self.assertIn("make check", content)
        self.assertIn("make slow-check", content)
        self.assertIn("workflow_dispatch:", content)
        self.assertIn("schedule:", content)

    def test_required_project_ledgers_are_created_with_descriptions(self):
        for name in ("PROGRESS", "DECISIONS", "STRENGTH", "IDEAS"):
            with self.subTest(document=name):
                path = ROOT / "docs" / f"{name}.md"
                self.assertTrue(path.is_file())
                self.assertTrue(path.read_text().strip())

    def test_gitignore_excludes_build_outputs_and_private_codex_inputs(self):
        content = (ROOT / ".gitignore").read_text().splitlines()
        for entry in ("/target/", "/web/node_modules/", "/.codex/inputs/"):
            with self.subTest(entry=entry):
                self.assertIn(entry, content)


if __name__ == "__main__":
    unittest.main()

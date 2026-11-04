"""Modal CPU runner: TEST_PLAN 5.3.5 correctness-repair non-regression A/B for the NoAnalysisLines fix.
A = fixed xq-uci (77a3c60), B = baseline xq-uci (673754a). Settings copied from the M4 TT fail-low run
(docs/research/m4-validation/tt-fail-low-exact-v1): 50 frozen openings, 200 games, 10000 nodes, seed 1,
max-ply 4096, workers 4, engine-timeout 30, rounds 1-2, look 1. Budget cap US$1; cpu=8 container."""
import os, subprocess, time, hashlib
import modal

S = os.path.dirname(os.path.abspath(__file__))
R = os.path.abspath(os.path.join(S, "../.."))
app = modal.App("xq-m8-ab")
image = (modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
         .apt_install("python3", "git")
         .add_local_file(f"{R}/.scratch/ab/bin/xq-uci-after", "/opt/xq-uci-after", copy=True)
         .add_local_file(f"{R}/.scratch/ab/bin/xq-uci-before", "/opt/xq-uci-before", copy=True)
         .add_local_dir(f"{R}/scripts/m4", "/opt/repo/scripts/m4", copy=True, ignore=["__pycache__"])
         .add_local_dir(f"{R}/docs/research/m4-openings", "/opt/repo/docs/research/m4-openings", copy=True,
                        ignore=["batch-v2"]))

@app.function(cpu=8, memory=8192, image=image, timeout=3 * 3600)
def run():
    t0 = time.time()
    subprocess.run("chmod +x /opt/xq-uci-after /opt/xq-uci-before", shell=True, check=True)
    pv = subprocess.run(["/usr/bin/python3", "-V"], capture_output=True, text=True).stdout.strip()
    # match.py records `git rev-parse HEAD` of its own checkout; the container only has copied files,
    # so give it a throwaway repo (the runner_git_head in the summary is therefore synthetic).
    subprocess.run("git init -q . && git add -A && git -c user.name=ab -c user.email=ab@x commit -qm ab",
                   shell=True, cwd="/opt/repo", check=True)
    out = "/tmp/ab-out"
    cmd = ["/usr/bin/python3", "scripts/m4/match.py", "--engine-a", "/opt/xq-uci-after", "--engine-b", "/opt/xq-uci-before",
           "--strategy-a", "search", "--strategy-b", "search", "--experiment", "correctness-repair",
           "--engine-a-options", "{}", "--engine-b-options", "{}",
           "--openings", "docs/research/m4-openings/selected-50.tsv",
           "--selection-protocol", "docs/research/m4-openings/opening-selection-protocol.json",
           "--nodes", "10000", "--games", "200", "--global-round-start", "1", "--global-round-count", "2",
           "--seed", "1", "--max-ply", "4096", "--workers", "4", "--look", "1", "--engine-timeout", "30",
           "--output", out]
    r = subprocess.run(cmd, cwd="/opt/repo", capture_output=True, text=True)
    files = {}
    for root, _d, names in os.walk(out):
        for n in names:
            p = os.path.join(root, n)
            if os.path.getsize(p) < 30_000_000:
                files[os.path.relpath(p, out)] = open(p, "rb").read()
    sha = {k: hashlib.sha256(open(f"/opt/xq-uci-{k}", "rb").read()).hexdigest() for k in ("after", "before")}
    return {"rc": r.returncode, "stdout": r.stdout[-3000:], "stderr": r.stderr[-3000:], "argv": cmd, "python": pv,
            "wall": time.time() - t0, "sha": sha, "files": files}

@app.local_entrypoint()
def main(outdir: str):
    res = run.remote()
    os.makedirs(outdir, exist_ok=True)
    for k, v in res.pop("files").items():
        p = os.path.join(outdir, k); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(v)
    import json
    json.dump(res, open(os.path.join(outdir, "modal-result.json"), "w"), indent=1)
    print("rc", res["rc"], "wall", res["wall"], res["sha"]); print(res["stdout"][-800:]); print(res["stderr"][-800:])

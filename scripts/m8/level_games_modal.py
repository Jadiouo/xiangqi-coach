"""Modal CPU runner: generate the TEST_PLAN 6.4 level games (5 levels x 30 openings) with level-games.
Budget cap US$2. cpu=8 container, one job per (level, opening) run through xargs -P 8."""
import hashlib, os, subprocess, time
import modal

S = os.path.dirname(os.path.abspath(__file__))
app = modal.App("xq-m8-level-games")
image = (modal.Image.debian_slim(python_version="3.12")
         .add_local_file(f"{S}/level-games", "/opt/level-games", copy=True)
         .add_local_file(f"{S}/openings31.tsv", "/opt/openings31.tsv", copy=True))

@app.function(cpu=4, memory=8192, image=image, timeout=4 * 3600)
def run(play_nodes: int = 100000, review_nodes: int = 100000, only: str = ""):
    t0 = time.time()
    subprocess.run("chmod +x /opt/level-games", shell=True, check=True)
    sha = hashlib.sha256(open("/opt/level-games", "rb").read()).hexdigest()
    rows = [line.rstrip("\n").split("\t") for line in open("/opt/openings31.tsv")][1:]
    assert len(rows) == 30
    from concurrent.futures import ThreadPoolExecutor
    jobs = []
    for idx, (oid, _src, prefix) in enumerate(rows):
        for level in (2, 4, 6, 8, 10):
            user = "red" if idx % 2 == 0 else "black"
            jobs.append((level, idx, ["/opt/level-games", "--level", str(level), "--index", str(idx),
                         "--opening-id", oid, "--opening", prefix, "--user", user,
                         "--play-nodes", str(play_nodes), "--review-nodes", str(review_nodes)]))
    if only:
        jobs = [j for j in jobs if f'{j[0]}-{j[1]}' == only]
    def go(job):
        level, idx, cmd = job
        r = subprocess.run(cmd, capture_output=True, text=True)
        return f"{level}-{idx}", r.returncode, r.stdout, r.stderr[-300:]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(go, jobs))
    outs = {k: out for k, rc, out, err in results}
    bad = [(k, rc, err) for k, rc, out, err in results if rc != 0]
    r = type("R", (), {"returncode": len(bad), "stderr": repr(bad)})
    return {"rc": r.returncode, "stderr": r.stderr[-2000:], "sha256": sha, "wall": time.time() - t0, "outs": outs}

@app.local_entrypoint()
def main(only: str = ""):
    import json
    res = run.remote(only=only)
    json.dump(res, open(f"{S}/result{only}.json", "w"))
    print("rc", res["rc"], "wall", res["wall"], "sha", res["sha256"], res["stderr"][:500])

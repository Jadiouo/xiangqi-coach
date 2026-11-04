#!/bin/bash
# Usage: tools/p3/run.sh   (needs `npm run build` done in web/; takes the machine lock like any heavy job)
# Measures sample-beginner (60 plies) at 100k: first review (computes) vs second review (cache).
set -u
cd "$(dirname "$0")/../.."
mkdir -p .scratch/p3
node web/e2e/serve-subpath.mjs web/dist / 4174 & SERVER=$!
sleep 2
echo "=== $(date -Is) uptime: $(uptime)" | tee -a .scratch/p3/log.txt
node tools/p3/measure.mjs "http://127.0.0.1:4174/" docs/samples/data/sample-beginner.json 100000 .scratch/p3/result.json 4 45 | tee -a .scratch/p3/log.txt
echo "=== end $(date -Is) uptime: $(uptime)" | tee -a .scratch/p3/log.txt
kill $SERVER

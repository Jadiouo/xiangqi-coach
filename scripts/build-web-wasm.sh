#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_bindgen="0.2.126"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen CLI ${expected_bindgen} is required (cargo install wasm-bindgen-cli --version ${expected_bindgen} --locked)" >&2
  exit 1
fi
actual_bindgen="$(wasm-bindgen --version | awk '{print $2}')"
if [[ "${actual_bindgen}" != "${expected_bindgen}" ]]; then
  echo "expected wasm-bindgen ${expected_bindgen}, found ${actual_bindgen}" >&2
  exit 1
fi

cargo build --manifest-path "${repo_root}/Cargo.toml" -p xq-wasm --target wasm32-unknown-unknown --release
mkdir -p "${repo_root}/web/public/wasm"
wasm-bindgen \
  --target web \
  --out-dir "${repo_root}/web/public/wasm" \
  --out-name xq_wasm \
  "${repo_root}/target/wasm32-unknown-unknown/release/xq_wasm.wasm"

# wasm-opt (binaryen, version pinned in web/package.json) shrinks and speeds up the module without
# changing behavior. A missing tool or a failed run must fail the build, not silently ship the larger file.
wasm_opt="${repo_root}/web/node_modules/.bin/wasm-opt"
if [[ ! -x "${wasm_opt}" ]]; then
  echo "wasm-opt not found at ${wasm_opt} (run npm ci in web/)" >&2
  exit 1
fi
bg_wasm="${repo_root}/web/public/wasm/xq_wasm_bg.wasm"
raw_size="$(stat -c %s "${bg_wasm}")"
"${wasm_opt}" -O3 "${bg_wasm}" -o "${bg_wasm}.opt"
opt_size="$(stat -c %s "${bg_wasm}.opt")"
if [[ ! -s "${bg_wasm}.opt" || "${opt_size}" -ge "${raw_size}" ]]; then
  echo "wasm-opt output missing or not smaller (${raw_size} -> ${opt_size})" >&2
  rm -f "${bg_wasm}.opt"
  exit 1
fi
mv "${bg_wasm}.opt" "${bg_wasm}"
echo "wasm-opt -O3: ${raw_size} -> ${opt_size} bytes"

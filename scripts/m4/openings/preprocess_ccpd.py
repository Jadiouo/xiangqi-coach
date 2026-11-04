#!/usr/bin/env python3
"""Convert the CCPD opening PGNs into UTF-8 provenance-bearing JSONL inputs."""

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import quote


DEFAULT_REVISION = "368a47a947773dd8692c026e286dd19b6277b993"
DATASET_URL = "https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset"
LICENSE = "CC-BY-4.0"


def source_url(revision: str, filename: str) -> str:
    path = quote(f"Dataset/開局/{filename}", safe="/")
    return f"{DATASET_URL}/blob/{revision}/{path}"


def convert(input_dir: Path, output_path: Path, revision: str) -> tuple[int, int]:
    files = sorted(input_dir.glob("*.pgn"), key=lambda path: path.name)
    if not files:
        raise ValueError(f"no .pgn files found in {input_dir}")

    decoded = 0
    failed = 0
    with output_path.open("w", encoding="utf-8", newline="\n") as output:
        for path in files:
            raw = path.read_bytes()
            row = {
                "source_name": f"CCPD-opening-{path.stem}",
                "source_license": LICENSE,
                "source_pgn_url": source_url(revision, path.name),
                "source_pgn_sha256": hashlib.sha256(raw).hexdigest(),
                "source_revision": revision,
            }
            try:
                row["pgn"] = raw.decode("big5")
                decoded += 1
            except UnicodeDecodeError as error:
                row["preprocess_error"] = f"big5_decode_error: {error}"
                failed += 1
            output.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    return decoded, failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    args = parser.parse_args()
    try:
        decoded, failed = convert(args.input_dir, args.output, args.revision)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"source files: {decoded + failed}; Big5 decoded: {decoded}; decode failures: {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

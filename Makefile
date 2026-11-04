.PHONY: check slow-check

check:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	cargo test -p xq-core --release --features perft-performance --lib tests::release_initial_perft_depth_four_finishes_under_one_second -- --exact --nocapture --test-threads=1
	cargo build -p xq-wasm --target wasm32-unknown-unknown && test -s target/wasm32-unknown-unknown/debug/xq_wasm.wasm
	cd web && npm ci && npm run typecheck && npm test && npm run build
	python3 -m unittest discover -s tests -v

slow-check:
	cargo test --workspace --release --features xq-core/slow-perft

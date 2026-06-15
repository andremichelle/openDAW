# 06 — Build toolchain & integration

## Rust → wasm

- Target **`wasm32-unknown-unknown`** (browser worklet, no WASI). The engine crate and **each device
  crate** compile to their own `.wasm`.
- **No `wasm-bindgen` in the hot path** — we use a custom C-ABI + shared memory (`05`), not idiomatic
  JS bindings. A thin hand-written JS loader instantiates modules and wires `Memory` + `Table`.
  (wasm-bindgen optional for non-hot-path glue only.)
- **`no_std`-leaning core** with a custom / arena allocator — fits the allocator model in `05`, keeps
  it deterministic.
- Target features: **SIMD128 on** (DSP). Shared-memory feature only if the engine memory must be
  `SharedArrayBuffer`-backed for cross-thread (asset/comms) zero-copy — flag, decide in `05`.
- **Pin the toolchain** (`rust-toolchain.toml`) for reproducible builds (matters: we trust builds +
  tests, not code review).

## Layout & outputs

- `crates/` cargo workspace builds the engine + N device crates → one `.wasm` each (+ a manifest).
- Size: `opt-level = "z"`, `lto`, **`wasm-opt`** (binaryen), strip. Matters with many device wasms.
- Output lands in a thin **TS wrapper package**; vite serves the `.wasm`; the worklet `fetch` +
  instantiates it.

## Monorepo integration

- An npm script runs `cargo build --release` (wasm) + `wasm-opt`, emitting into the TS wrapper.
  Hooked as a `predev` / `prebuild` step.
- Dev loop: `cargo-watch` rebuilds on change → vite reload / HMR.
- **Prebuilt artifact:** commit (or CI-cache) the built `.wasm` so **TS-only contributors run the app
  without Rust installed**; the cargo build runs only when the engine changes.
- Cross-origin isolation (COOP/COEP) for `SharedArrayBuffer` is **already required** by the studio —
  no new server config.

## CI

- Install pinned Rust + `wasm32-unknown-unknown` + wasm-opt; cache `~/.cargo` + `target/`.
- `cargo test` (**native**, fast) every commit — the bulk of unit + parity.
- Build wasm + run a **wasm parity subset** (headless runner); full wasm parity nightly.

## Test build targets

- **native** (`cargo test`) — dev loop + CI speed.
- **in-wasm** — headless runner (wasm-bindgen-test / node + offline render) for fidelity (the shipping
  artifact).

## Open

- wasm test runner choice (wasm-bindgen-test vs custom node harness).
- Whether engine memory must be SAB-backed (→ shared-memory build features) — settle in `05` / spike.
- Device-package bundling (wasm + UI + manifest) for runtime-loaded plugins.

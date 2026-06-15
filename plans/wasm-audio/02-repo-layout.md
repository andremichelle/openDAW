# 02 — Source layout / repo

## Decision: in the monorepo

The Rust/WASM engine lives in this repo, not a separate one.

### Why

- The **TS↔WASM interface** (command + state protocols, `AudioData` / SharedArrayBuffer layouts)
  will churn throughout the port. Those changes must land **atomically** on both sides — separate
  repos mean drift and version juggling.
- The **parity test harness** (WASM vs the TS engine) needs both building and running in **one CI /
  one checkout**. That harness is the whole safety net, so co-location is non-negotiable.
- One clone, lockstep versioning, no publish-then-consume loop while iterating.

### Layout

Keep Rust **out of `packages/`** (that dir is an npm-workspace glob; a cargo crate there tangles the
two toolchains). Use a separate top-level cargo workspace:

- `crates/` — Rust cargo workspace.
  - `crates/audio-engine/` — the engine crate; may split into sub-crates (dsp primitives, graph,
    voices…) later.
- A thin **TS wrapper package** holds the build output (`.wasm` + bindings) and is what
  `packages/studio/core-processors` imports (a loader + typed surface).
- Build: `cargo → wasm` runs as a pre-step before vite; output lands in the TS wrapper.
- CI: add the Rust toolchain; run native `cargo test` (fast) + wasm parity tests.

### Tradeoff

Building the engine requires Rust installed. To not force that on pure-TS contributors, the app
build can consume a **prebuilt** wasm artifact (committed or cached) — exact mechanism deferred to
the build toolchain doc.

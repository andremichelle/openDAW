# Open questions

Consolidated from the plan docs, grouped by what resolves them. Source doc in brackets.

## 🔴 Resolved by the composition spike — do first

The spike (`05`/`08`: engine wasm + one device wasm sharing `Memory`+`Table`, render a block
wasm-to-wasm, measured) settles the highest-risk unknowns:

- **Memory model:** A (one shared memory + engine-assigned arenas) vs B (per-device memory +
  multi-memory shared I/O) vs C (per-device memory + host copies the block). Lean A, C as fallback. [05]
- **Is the engine memory `SharedArrayBuffer`-backed?** (→ needs shared-memory build features). [05, 06]
- **Multi-memory browser support** — decides whether B is viable. [05]
- **Device allocator strategy** — `no_std` / custom global allocator / arena API. [05]
- **Is per-device JS-copy (model C) fast enough at scale?** — measurement. [05]

## 🟡 Device ABI & plugins

- **ABI mechanism:** custom C-ABI now (kept WIT-shaped) vs WASM Component Model. [device-plugins]
- **Isolation model** for untrusted / third-party devices (Phase B). [device-plugins]
- **Device-package format** (wasm + UI bundle + manifest) and how the studio discovers/loads it.
  [device-plugins, 06]
- **Scriptable devices:** shared-memory layout for note events + params handed to scripts; telemetry
  write-back path. [scriptable-devices]

## 🟡 Boundary & sync

- **Box sync granularity:** full project reload vs incremental deltas to the Rust-side graph. [04]

## 🟡 Testing

- **Tolerance thresholds** per category — decide empirically as primitives land. [07]
- **Pin shared transcendental implementations** for tighter exactness? [07]
- **Fixture authoring:** hand-written vs captured from real projects. [07]
- **wasm test runner:** wasm-bindgen-test vs custom node harness. [06]

## ⚪ Rollout (later)

- **Capability-gating granularity** — per-device vs per-mechanic. [09]
- **Build shadow mode** (live WASM-vs-TS compare)? [09]
- **Flip-default criteria** — parity coverage %, crash rate, perf headroom. [09]

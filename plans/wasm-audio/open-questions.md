# Open questions

Consolidated from the plan docs, grouped by what resolves them. Source doc in brackets.

## 🟢 Settled by the composition spike (step 2 ✅)

Spike: `compose-engine` + `compose-device` wasm share one imported `Memory`; the engine generates a
sine into an engine-owned arena and calls the device's `process` **wasm-to-wasm** (host wires the
device export as an engine import). Verified numerically (device scales the engine buffer through
shared memory, no collision) and measured **~250 ns/block (Node) / ~500 ns/block (browser)**.

- **Memory model → A confirmed.** One shared memory + engine-assigned arena, device stateless, no JS
  in the loop. B (multi-memory) and C (host copies) are unnecessary as the primary path. [05]

Still open within memory/composition (deferred, not blocking):

- **`SharedArrayBuffer`-backed memory** — spike used a non-shared `Memory`. Revisit when threads /
  asset (`AudioData`) delivery need it (adds `shared`+`maximum` and atomics build flags). [05, 06]
- **Dynamic dispatch** — spike used a fixed function import (one device). Runtime-loadable / multiple
  devices need `Table` + `call_indirect` (or per-load re-instantiation). Validate when device count
  is dynamic. [05, device-plugins]
- **Device allocator strategy** — fine for stateless/arena devices (proven). Stateful devices
  (own statics) also proven: relocate each module with `--global-base` into a disjoint slab
  (engine 1 MiB, devices 4/8 MiB) — verified two stateful devices keep byte-identical state with no
  collision. Devices needing a dynamic heap still need a custom allocator within their slab. [05]

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

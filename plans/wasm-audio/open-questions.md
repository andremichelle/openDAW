# Open questions

Consolidated from the plan docs, grouped by what resolves them. Source doc in brackets. Status reflects
the shipping engine as of 2026-07-07; ✅ = verified done in code, not just planned.

## 🟢 Settled by the composition spike (step 2 ✅)

Spike: `compose-engine` + `compose-device` wasm share one imported `Memory`; the engine generates a
sine into an engine-owned arena and calls the device's `process` **wasm-to-wasm** (host wires the
device export as an engine import). Verified numerically (device scales the engine buffer through
shared memory, no collision) and measured **~250 ns/block (Node) / ~500 ns/block (browser)**.

- **Memory model → A confirmed.** One shared memory + engine-assigned arena, device stateless, no JS
  in the loop. B (multi-memory) and C (host copies) are unnecessary as the primary path. [05]

Since resolved in the shipping engine:

- **✅ `SharedArrayBuffer`-backed memory** — `createEngineMemory()` is
  `new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})`; the main thread writes
  `AudioData` straight into the engine's shared memory (no foreign-SAB copy). [05, 06]
- **✅ Dynamic dispatch** — `boot.ts` instantiates the engine against a shared `Table`
  (`__indirect_function_table`) and `linkDevice`s each device module into it, so runtime-loadable
  multiple devices dispatch by `call_indirect`. [05, device-plugins]
- **✅ Device allocator** — engine and all devices share one talc heap in the shared memory; stateful
  devices keep state across reconciles. No per-device `--global-base` slab or custom allocator was
  needed in the end. [05]

## 🟡 Device ABI & plugins

- **✅ Scriptable devices** — the `abi::script_*` bridge (`script_create` / `script_param` /
  `script_sample` / `script_reset`, plus `host_script_note_on` / `note_off` / `host_script_audio`)
  hands offset-sorted note events + params to the user `Processor` and streams telemetry back;
  Werkstatt / Apparat / Spielwerk ship on it. [scriptable-devices]
- **Decided — custom C-ABI (shipping).** The engine uses the custom offset-ABI, kept WIT-shaped; a
  WASM Component Model migration stays a possible later swap, not blocking. [device-plugins]
- **Open (Phase B, deferred by design):** isolation model for untrusted / third-party devices, the
  device-package format (wasm + UI bundle + manifest), and studio discovery/loading of external
  plugins. Stock devices are compiled-in today; nothing third-party loads yet. [device-plugins, 06]

## 🟡 Composite devices (Playfield)

The generic composite mechanism ships (broadcast + child-side note filter, choke/exclude, per-child
fx chains with device-declared host keys).

- **✅ Mute / solo** — each child carries a SILENT gate (`mute`, or not-soloed while a sibling is),
  monitored on the child's `mute` (40) / `solo` (41) fields and applied at its pull route; the choke
  set recomputes on any mute / solo / membership change. [playfield-composite]
- **✅ Sidechain through a composite** — flattening registers each child + per-child fx node in the one
  global graph by box UUID; exercised by `sidechain-device-tap`. [playfield-composite, device-processing]
- **Open — exclude / choke ownership.** The choke `index_key` / `exclude_key` still come from the
  JS-registered `CompositeSpec`, while the per-child fx host keys are declared by the child DEVICE.
  Move the exclude / filter-index roles onto device-declared keys too (one source of truth). A cleanup,
  not a gap. [playfield-composite]

## 🟢 Boundary & sync

- **✅ Box sync granularity — incremental.** `SyncSource` opens with a full graph dump (project load),
  then streams incremental transaction batches over a synchronous ordered channel, with a throttled
  checksum round-trip that escalates any divergence. No per-edit full reload. [04]

## 🟡 Binary size (optional)

- **✅ `wasm-opt` runs** — binaryen is installed in both deploy workflows (with the Rust ≥1.82 feature
  flags), so `wasm-opt -Oz` actually optimises the engine + plugins. [06, diary 18]
- **Open (optional levers, no forced floor):** replace the generated `studio_boxes::registry()`
  imperative builder with a static data blob and/or register only engine-read box types, and cut the
  BTreeMap/BTreeSet/sort monomorphisation. Pursue only if size becomes a real constraint. [06]

## 🟢 Testing (settled by practice)

- **✅ Pin transcendentals** — `dsp::fast_math` is a WASM-CONTRACT bit-exact mirror of `lib-dsp`
  `fast-math.ts`, with per-function accuracy + perf benchmarks. [07]
- **✅ Tolerance thresholds / fixtures / runner** — per-category tolerances chosen empirically as
  primitives landed; fixtures are both hand-written and captured from real `.od` projects; the suite
  runs on the node/vitest harness, not wasm-bindgen-test. [06, 07]

## ⚪ Rollout

- **✅ Flip-default — done.** The WASM engine is the default; TS is opt-out only (localhost + dev
  toggle), with no runtime fallback (TS is being retired). [09, diary 18]
- **✅ Capability-gating** — `testFeatures` hard-gates on SIMD (plus the existing checks) at boot; with
  no TS fallback, per-device gating is moot. [09]
- **Open (optional):** a live WASM-vs-TS shadow-compare mode; the `/performance` A/B page already
  covers offline comparison. [09]

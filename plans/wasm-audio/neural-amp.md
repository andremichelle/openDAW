# NeuralAmp in the WASM engine (Tone3000 / NAM)

The last portable stock device. Decision (2026-07-03): do NOT port NeuralAmpModelerCore to Rust. The engine
BRIDGES to the existing `@opendaw/nam-wasm` module (our own package, v1.2.0 = vendored NeuralAmpModelerCore
0.5.3, the latest A2-capable core: `wavenet/a2_fast`, FiLM, gating activations, slimmable), the exact module
the TS engine already runs. Source of truth: `~/Repositories/andre.michelle/nam-wasm`. This buys bit-exact
parity with the TS engine by construction, and future core updates are an npm bump. The architectural
precedent is the SCRIPT BRIDGE (Werkstatt / Apparat / Spielwerk): a thin Rust device crate whose DSP crosses
into JS closures in the worklet; the zero-JS-in-render relaxation stays contained to those devices plus this
one. A native Rust port remains a possible later milestone, with this bridge as its bit-exact reference.

## Why Tone3000 needs no engine work

Tone3000 (plans/tone-3000-api.md) is pure main-thread UI: the Select Flow popup, the OPFS pack cache
(`tone3000/{toneId}/`), and `NamTone3000.ts` copying the chosen `.nam` JSON into a `NeuralAmpModelBox`
string field (uuid = sha256 of the JSON, content-addressed). The device box references it via pointer field
`20`. `NeuralAmpModelBox` is already registered in the wasm box registry (`studio-boxes/registry.rs`), so
the model JSON ALREADY arrives inside the engine's box graph with every project sync. Delivery to the
bridge is therefore local: the engine reads the target box's string field and hands the device a ptr/len.
No blob handshake, no OPFS, no main-thread round trip.

## The Emscripten module cannot be a side module

`nam.wasm` is an Emscripten build with its OWN memory, malloc, and C++ runtime; it cannot join the engine's
single-shared-memory `call_indirect` world. It is instantiated as a SEPARATE wasm instance in the worklet
scope (exactly as the TS engine's `NeuralAmpDeviceProcessor` does), and the JS bridge copies 128 samples
per quantum between the two memories. That copy is negligible next to WaveNet inference.

## Model delivery: `observe_target_string`

A new GENERIC observation (no NAM-specific engine code): `host_observe_target_string(path, field_key)`
observes THIS device's POINTER field at `path` and, on catch-up and every set / repoint / clear (inside a
transaction, never during render), resolves the pointer target and delivers the TARGET box's string field
`field_key` through the device's existing `field_changed` export (`FieldValue::String`, empty = unbound).
Implementation mirrors `observe_soundfont`: `FIELD_OBS` entries grow a `target_key: u16` (0 = plain field,
schema keys start at 1), `observe_fields` dispatches on it, and `resolve_and_deliver_target_string` does
`graph.target_of(pointer) -> graph.field_value(target, [field_key]) -> call_device_field_changed(STRING)`.
The string ptr/len point straight at the box-graph string in engine memory, valid for the synchronous call.
Model boxes are content-addressed (a model change = new box + repoint), so observing the pointer suffices,
mirroring the TS adapter's `modelField.catchupAndSubscribe`.

## The `host_nam_*` bridge (JS closures, script-bridge style)

Bound into every device's `env` by the loaders (engine-processor.ts, load-full-engine.ts); native stubs
return 0 / no-op so the crate builds + unit-tests off-target.

- `host_nam_create(uuid_ptr) -> handle` — keyed BY DEVICE UUID: a rebind's `init` returns the existing
  bridge (instances + loaded model preserved, no re-prewarm). Handles start at 1.
- `host_nam_load(handle, json_ptr, json_len)` — copies the raw UTF-8 bytes out of engine memory into the
  nam heap (no JS string, no TextDecoder — the worklet scope has none) and `_nam_loadModel`s each live
  instance. Byte-identical JSON is skipped (rebind catch-up re-delivers). `len 0` unloads. The module
  itself loads LAZILY on the first `load`: the worklet asks the main thread for the `nam.wasm` bytes over
  a new `nam` RPC channel (mirroring `samples` / `soundfonts`), `createNamModule({wasmBinary})`,
  `setSampleRate(sampleRate)`. Until it is ready the bridge is not loaded and the device passes through,
  exactly like the TS processor while `fetchWasm` is in flight.
- `host_nam_set_mono(handle, mono)` — mirrors `#onMonoChanged`: destroys / creates the second instance and
  loads the cached JSON into it.
- `host_nam_process(handle, in0, in1, out0, out1, frames, channels) -> u32` — 0 unless the model is loaded
  (device passes through); otherwise runs `NamWasmModule.process` per channel over Float32Array views into
  engine memory (re-derived every call — the SAB can grow) and returns 1. One JS hop per chunk.
- `host_nam_reset(handle)` — `_nam_reset` per instance (transport stop).

Known gap (same as the script bridge): devices have no `terminate` export, so a REMOVED device's bridge
entry (two nam instances holding the model) leaks until reload. Bounded to one pair per removed device by
the uuid keying. A future device `terminate` export fixes both bridges.

## `device-neural-amp` (crate)

`AudioEffect` mirroring `NeuralAmpDeviceProcessor` to the letter:
- Params (adapter mappings): `input-gain [11]` / `output-gain [12]` `Decibel::new(-72, 0, 12)` through
  `dsp::db_to_gain`; `mix [14]` `Linear::unipolar()`. `mono [13]` is an observed bool FIELD, `model [20]`
  the observed target string (`NeuralAmpModelBox.model`, key 2).
- `process_audio` per chunk (`render_effect` splits at automation updates like the TS `AudioProcessor`):
  mono: scratch `(inL+inR) * 0.5 * inputGain` -> one instance -> `out = in*dry + wet*outputGain*wet` on
  both channels; stereo: per-channel `in * inputGain` -> two instances -> same mix. `host_nam_process`
  returning 0 = plain passthrough copy (no gains, no mix), the TS not-ready path.
- Scratch: four `[f32; 128]` buffers in state (~2 KB), no allocation.
- `reset` -> `host_nam_reset`. No peaks / spectrum (UI-only, skipped like every ported device).
- Native tests cover the pure parts (mapping + downmix + mix arithmetic, passthrough via stubs).

## Wiring

- `build-wasm.sh` `DEVICE_CRATES` += `device-neural-amp`; workspace member via `stock-devices/*` (automatic).
- `engine-modules.ts` `DEVICES` += `{url: "/device_neural_amp.wasm", boxType: "NeuralAmpDeviceBox"}`;
  same row in `load-full-engine.ts`.
- `engine-processor.ts`: `NamBridges` next to `ScriptBridges`, its imports spread into every device env;
  `host_observe_target_string` forwarded like `host_observe_field`; `nam` RPC channel (worklet asks, main
  thread fetches `new URL("@opendaw/nam-wasm/nam.wasm", import.meta.url)` — the TS engine's exact recipe).
- `packages/app/wasm/package.json` += `@opendaw/nam-wasm`.

## Tests

Real models from the nam-wasm repo (`example_models/`): `wavenet.nam` (3.9 KB), `lstm.nam` (2.3 KB),
`wavenet_a2_max.nam` (72 KB, exercises the A2 path).
- Native: param routing, downmix / mix math, stub passthrough.
- WASM wiring (node, `load-full-engine` + a node-side `NamBridges` fed by `fs`): device with a model is
  audibly non-passthrough, finite, bounded; unbound model = exact passthrough; mono vs stereo; A2 loads.
- Parity: same patch through the TS engine (render-ts helper gains a real `fetchNamWasm`) and the wasm
  engine — identical nam core, so with 0 dB / mix 1 the wet path is bit-exact; assert accordingly.

## Out of scope

- Tone3000 UI, OPFS cache, model dialogs: untouched, already engine-agnostic.
- Loudness normalization, spectrum analyser, `.namb`: not in the TS processor either (or UI-only).
- The perf A/B + offline pages keep their `fetchNamWasm` reject stub for the TS side until wired; noted,
  not part of this milestone's exit criteria.

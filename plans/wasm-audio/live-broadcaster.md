# LiveStreamBroadcaster in the WASM engine (UI telemetry)

The engine's UI telemetry channel: level meters, knob animation during automation, device telemetry
(gain reduction, spectra, play positions). Analysis date 2026-07-03; the WASM engine currently produces
NONE of it (the studio UI would show dead meters with the wasm engine swapped in).

## What the TS pair does (frozen contract)

`LiveStreamBroadcaster` (audio thread) + `LiveStreamReceiver` (main thread) in `lib/fusion/live-stream`.
Registered PACKAGES (Float / FloatArray / Integer / IntegerArray / ByteArray, each keyed by a box
`Address`) serialize once per render quantum into ONE SharedArrayBuffer guarded by a 1-byte Atomics lock
(WRITE <-> READ handshake: a slow UI drops frames, never blocks audio). Structure (version + address +
type list) travels over three Messenger messages (`sendShareLock` / `sendUpdateData` /
`sendUpdateStructure`) only when it changes; data travels lock-flip only. The SAB head carries one
subscription-flag byte per package BACK from the UI, so producers skip expensive work (spectra) when
nobody watches. Flushed at the end of every `process()`.

TS producers (~12 call sites in core-processors):
- master peaks/RMS: `PeakBroadcaster` under `EngineAddresses.PEAKS` (UUID.Lowest + 0); peak decay
  `exp(-1/(sr*0.25))`, RMS window 100 ms
- per-strip + per-bus peaks (`ChannelStripProcessor` / `AudioBusProcessor`, under the unit/bus address)
- EVERY `AutomatableParameter`'s unit value (`broadcastFloat(adapter.address, getUnitValue)`) — this is
  what animates studio knobs/faders
- device telemetry: gate / compressor / maximizer gain reduction, Revamp + NeuralAmp spectra, Tidal
  phase, Velocity histogram, Playfield play positions
- engine-level SPECTRUM / WAVEFORM analysers (UUID.Lowest + 1 / + 2)

## The architectural decision: do NOT port the protocol

The wasm engine's linear memory already IS a SharedArrayBuffer, and `broadcastFloats` captures a live
`Float32Array` view it re-reads at every flush. So the JS `LiveStreamBroadcaster` / `LiveStreamReceiver`
pair stays byte-for-byte untouched (frozen contract, the studio UI keeps working unchanged), and the
WORKLET WRAPPER registers packages whose views point directly into wasm memory. Rust only produces
values into fixed slots. Zero copies, no new lock protocol, no receiver changes. Same containment
precedent as the script/NAM bridges: the JS stays in the wrapper, the engine stays pure.

## Status

Phases 1+2 are IMPLEMENTED (plus per-device meters and note-activity counters beyond the phase-2 scope):
`crates/engine/src/broadcast.rs` (Weak-swept table + generation), `crates/engine-env/src/meter.rs`
(PeakBroadcaster port), meters in PluginInstrument / PluginAudioEffect / ChannelStrip / AudioRegionPlayer,
registrations + `sweep()` in `audio_unit.rs`, the worklet bridge in `engine-processor.ts`
(`#syncBroadcasts` + `flush`), and the `/live-meters` demo page (rows = audio units, columns = devices).
Note activity deviates from TS (a monotonic counter at `.append(1)` / the midi-fx address instead of the
128-bit `Bits` set). Tests: `broadcast.rs` unit test + `test/live-broadcast.test.ts` end to end.
Phases 3 (param unit values), 4 (device telemetry ABI), 5 (spectra) remain.

## Phases

### Phase 1 — the broadcast table

Engine-side registry of `(address bytes, package type, ptr, len)` entries, built at RECONCILE (slots
allocated there, never during render), plus exports `broadcast_generation()`, `broadcast_count()`,
`broadcast_entry(index, out_ptr)` and `broadcast_set_active(id, active)`. After every `apply_updates`
the worklet diffs the generation and (re)registers packages on its JS broadcaster with views over wasm
memory, terminating stale ones. The package `before(hasSubscribers)` callbacks forward the subscription
flags into `broadcast_set_active`, so the engine can skip cold producers.

### Phase 2 — peaks (lands with phase 1)

Port `PeakBroadcaster` (peak decay + 100 ms RMS ring) into engine-env as a `Meter` written during
`process` by ChannelStrip, AudioBus, and the master, registered under the SAME addresses TS uses.
This alone lights up every studio level meter.

### Phase 3 — parameter unit values

Every automated-parameter binding gets one f32 slot refreshed on change (the engine already tracks
`last` per `ParamHandle`), registered under the parameter's field address. Animates knobs during
automation playback.

### Phase 4 — device telemetry ABI

One new abi import pair, `host_broadcast_floats(path_ptr, path_len, ptr, len)` (+ int variant),
callable from device `init`, recorded like `host_bind_sidechain`. Port the cheap producers first:
gate / compressor / maximizer gain reduction (already computed), Tidal phase, Velocity histogram,
Playfield positions.

### Phase 5 — spectra (the only hard DSP, separable)

Revamp / NeuralAmp / engine SPECTRUM need an FFT analyser port (TS uses lib-dsp's `AudioAnalyser`),
gated on the subscription flag so idle projects pay nothing. WAVEFORM is a cheap ring copy. If
null-test-level equality is wanted the analyser needs the fast-math-style lockstep treatment;
behavioral equality is likely enough for UI.

## Tests

- native: meter math vs hand-computed decay/RMS; table registration/teardown across reconciles
  (no leaks, generation bumps)
- vitest: a REAL `LiveStreamReceiver` connected over a stub Messenger against the wasm engine
  (`LiveStream.test.ts` shows the harness), asserting peaks arrive for a playing unit and knob values
  track automation
- TS-vs-WASM peak comparison on a real bundle

## Constraints and risks

- no allocation during render: all slots + table entries come from reconcile
- structure churn during heavy edits recompiles the JS structure per change (same cost as TS, fine)
- teardown symmetry: every registered slot must leave the table when its unit/device leaves (the
  ValueCollection-terminate lesson applies)
- the subscription-flag path is an optimization, not correctness: phase 1 may ship with producers
  always-on except spectra

Order: 1+2 together (meters visible end to end), then 3, 4, 5 trailing.

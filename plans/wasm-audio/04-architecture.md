# 04 — Architecture & the TS↔WASM boundary

## Shared contract: the box graph

The serialized **box graph** is the single source of truth (the project). Two *independent* readers:

- **TS (main thread): adapters stay — for the UI only.** Editing, display, selection, undo/redo,
  knob/slider binding, writing automation into boxes.
- **Rust (worklet): owns the engine-side interpretation.** Everything the region / note / value /
  timeline / tempo / parameter adapters **and** the processors did for playback. The
  "adapters running inside the worklet" layer is dropped.

Net: one data model, two interpretations. Neither side owns the other.

**The engine reads the box graph read-only.** The main thread is the sole writer; mutations sync
**one-way** to the engine. This removes write-back, conflicts, and the need for a Rust box
*serializer* in production (reader only; serialize exists just for round-trip tests). Consequences:

- Recorded/captured data (PCM, MIDI, automation capture) and telemetry flow **out** via separate
  channels (ring buffers / event streams) → the main thread persists them as boxes.
- Runtime modulation (automation playback, MIDI/CC control) is computed on a **transient layer**,
  never written into boxes.

## Boxes in Rust: a generic codec, not a generator

- The box graph is **self-describing** (typed fields with stable numeric keys, deprecation-aware);
  the TS side already serializes generically. So Rust needs **one generic box-graph codec** that
  parses that exact wire format — *not* 96 generated structs and *not* a code generator.
- The engine touches only a few box types (regions, notes, values, device params) → give those
  **thin hand-written typed accessors** over the generic graph (no magic field numbers).
- Anti-drift guarantee = the self-describing format + **round-trip tests** (serialize in TS → parse
  in Rust → compare). Not codegen.
- Behavioral bits that are **not** in the box format still need a single shared definition mirrored in
  Rust + parity-tested (small, not per-box): **value mappings** (normalized↔real curves) and
  **telemetry** — see `device-contract.md`.

## Devices = plugins (Rust)

- Instruments / audio-effects / MIDI-effects each implement a small Rust **trait**, registered in a
  **registry**, looked up by box type. Add a device = implement + register.
- The engine-side **device adapters are dropped**; their playback logic moves into the plugin impls.

## Stays in TS

- UI box adapters, editors, selection, undo/redo, parameter write/latch (recording automation into boxes).
- Asset import / storage / peaks UI; the engine just consumes delivered `AudioData` by UUID.
- **Intentional duplication:** bar/beat/tempo/loop/interpolation math is re-implemented in Rust
  (engine) and kept in TS (UI). Parity-tested, not a smell.

## Open questions

1. **Box sync mechanism** — one-way, read-only (main → engine). Still to decide: full project
   (re)load vs incremental deltas applied to the Rust-side graph. → memory/boundary detail (05).

(Plugin extensibility = **decided: runtime-loadable device WASM from the start** — see
`device-plugins.md`.)

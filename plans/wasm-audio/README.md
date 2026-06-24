# WASM Audio Engine

Replace the real-time DSP core of the TS audio engine with a WebAssembly module running in the
AudioWorklet, for performance headroom and numerical robustness.

## Scope reference (the "template")

- `packages/lib/dsp` — DSP primitives (~74 files)
- `packages/studio/core-processors` — AudioWorklet processors (the real-time path)
- `packages/studio/core-workers` — offline render engine

The current TS implementation is the **behavioral reference**, not a line-by-line port target. The
WASM core is free to restructure; it just has to produce the same audio.

## Guiding principles

- **Compact now, deep later.** These docs stay brief and readable; detailed design happens per-step
  at implementation time.
- **Tests are the contract, not the code.** Correctness is verified by reference tests — WASM output
  compared against the TS engine sample-for-sample (bit-exact where possible, else epsilon) — plus
  property/fuzz tests and CI. We rely on this rather than reading the WASM/native source.
- **Real-time safety first.** No GC pauses, no allocation on the audio callback, deterministic.
- **All homebrew.** No third-party DSP (JUCE etc.) — licensing. Every algorithm is ported ourselves.
- **Minimal dependencies.** Keep external deps (crates, npm, tools, toolchain) minimal — prefer
  homebrew, smallest install that works. Source-file count is not a concern; structure freely.

## Plan index

- [**Feature inventory**](feature-inventory.md) — the master list of engine mechanics to port, one at a time
- [**Open questions**](open-questions.md) — consolidated, prioritized (spike-blockers first)
- [**Playfield and composite devices**](playfield-composite.md): the composite-device mechanism (flattening container, generic), with Playfield as its first user
1. [Language choice](01-language.md) — **decided: Rust**
2. [Source layout / repo](02-repo-layout.md) — **decided: monorepo, `crates/`**
3. [Threading model](03-threading.md) — **decided: single-threaded**
4. [Architecture & TS↔WASM boundary](04-architecture.md) — **drafted** (2 open questions)
   - [Device contract (UI ↔ engine)](device-contract.md)
   - [Device plugins (runtime-loadable WASM)](device-plugins.md) — **decided: from the start**
   - [Device processing pattern (AudioProcessor / NoteProcessor)](device-processing.md) — **draft, discussing**
   - [Processor infrastructure port map (TS → Rust)](processor-port-map.md) — **draft, discussing**
   - [Scriptable devices (JS DSP backend)](scriptable-devices.md)
5. [Memory & module composition](05-memory.md) — **drafted** (needs a spike)
6. [Build toolchain & integration](06-build.md) — **drafted**
7. [Testing & parity harness](07-testing.md) — **drafted**
   - [Integration — separate WASM test app](integration.md) — `packages/app/wasm/`, studio untouched
8. [Port order](08-port-order.md) — **drafted**
9. [Rollout / fallback / retirement](09-rollout.md) — **drafted**

Status: **planning — all docs drafted.**

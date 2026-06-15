# Scriptable devices (JavaScript DSP backend)

## Need

Some devices (code-editor / Werkstatt scripts) run **user JavaScript** as their DSP. The Rust engine
(in the worklet) must call that JS per block and hand it audio + data.

## Model: a JS-backed device plugin

- A scriptable device is a **device-plugin backend whose `process()` is JS**, not a wasm module.
  Same device contract (params, value mappings, telemetry — see `device-contract.md`); only the
  invocation path differs. So devices have two backends: **wasm** and **JS-script**.
- The engine calls the script via a **synchronous wasm→JS import** from the audio loop (allowed in
  the worklet). One boundary crossing per scriptable device per block — accepted cost (opt-in).

## Equipping it with audio + data (zero-copy)

- **Audio:** the script receives **`Float32Array` views over shared memory** — the same buffers the
  engine uses (wasm linear memory or a shared region). Reads inputs / writes outputs in place. No copy.
- **Data:** params (current values), transport/time, sample rate, block size, and **note events**,
  passed via shared-memory layout + scalar args.
- Views/objects are allocated at setup and **reused** across blocks, never per block.

## Compilation & realm

- The worklet is its own JS realm → the **script source is sent to the worklet and compiled there at
  setup** (not in `process()`). The engine holds the resulting function; a host import dispatches to
  it by device id. User edits recompile **off the hot path**.

## Caveat (accepted)

- User JS runs on the **audio thread**; its GC/allocations can glitch audio. Inherent to scriptable
  JS DSP and already true today. Accepted for these opt-in devices; advise "no per-block allocation",
  can't enforce.

## Alternative considered: embed a JS engine in Rust (Boa / QuickJS)

Rejected for the real-time path. Boa (pure Rust) and QuickJS (`rquickjs`) are wasm-able JS engines,
but both are **interpreters (no JIT)** → tight per-sample DSP loops run far slower than the worklet's
native **JIT'd V8**, likely too slow for real-time. They also carry **their own GC** inside the wasm
(GC-on-audio-thread risk relocated, not removed). The per-block wasm→JS crossing isn't the
bottleneck, so embedding buys little. (V8/SpiderMonkey can't be embedded in wasm at all.)

Possible **later** niche use only: sandboxed third-party scripts (Phase B) and deterministic
off-browser parity tests — trading speed for isolation/portability. Not the real-time path.

## Open

- Exact shared-memory layout for note events + params handed to scripts.
- Telemetry write-back from scripts (likely same shared buffers as wasm devices).

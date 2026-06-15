# 05 — Memory & module composition

How the engine wasm and device wasm modules share memory and call each other. **This gates the whole
plugin architecture — spike it before committing (see end).**

## How wasm modules compose (the literal answer)

- **Wasm doesn't load wasm.** The **host (JS, in the worklet)** instantiates each module
  (`WebAssembly.instantiate`) — async, at **setup, off the audio thread**.
- **Not parallel — called sequentially.** Single-threaded (decided). The engine's loop calls each
  device's `process`.
- **Shared memory:** create **one `WebAssembly.Memory`** and pass it as an **import** to the engine
  *and* every device → they all read/write the **same linear memory**. Share a **`WebAssembly.Table`**
  too; the engine calls devices via **`call_indirect` through the table → wasm-to-wasm, no JS in the
  hot path** after setup.
- **"Same layout" = the ABI.** The shared `Memory` is the raw substrate; the ABI is the agreed
  convention over it (buffer/param locations, function signatures).

## The hard part: heap / allocator ownership

Two independently-compiled Rust modules sharing **one** linear memory each assume they own the heap
→ **allocator corruption**. This is the real difficulty, not the loading. Options:

- **A. One shared memory, engine-assigned arenas.** Devices don't use a free heap in shared memory;
  the engine hands each an arena (bump allocator within it). Zero-copy, no JS in loop. **Fastest,
  most restrictive** on device code (`no_std`-ish / custom allocator).
- **B. Per-device private memory + small shared I/O memory.** Needs the **multi-memory** feature
  (recent browsers only — verify). Device keeps its own heap; audio/params pass through a shared I/O
  memory both import. Clean isolation + zero-copy I/O.
- **C. Per-device memory + host copies the block in/out.** Simplest, fully isolated. Data is tiny
  (~1 KB/block/device) so bandwidth is a non-issue; the cost is **per-device JS call overhead** in the
  loop. Probably fine — must measure.

**Lean: A** (no multi-memory dependency, best perf), ABI passes buffer offsets; keep **C** as the
guaranteed-works fallback.

## Other memory concerns

- **No growth in the hot path:** pre-size/pre-grow memory; arena allocators; refresh JS views if it
  ever grows.
- Read-only **box graph** lives in (shared) memory, read by the engine.
- Audio buffers, param blocks, telemetry, event queues = fixed layouts in shared memory (part of the
  ABI).
- Memory is `SharedArrayBuffer`-backed (needed anyway for asset `AudioData` delivery and
  main↔worklet comms).

## Spike (do this first)

Tiny PoC in an AudioWorklet: engine wasm + 1 device wasm sharing one `Memory` + `Table`, render a
block **wasm-to-wasm**, measure. Validate model **A**; confirm **C** as fallback. This de-risks the
plugin architecture before any real porting.

## Open

- Multi-memory browser support (decides whether **B** is viable).
- Device allocator strategy (`no_std` / custom global allocator / arena API).
- Is per-device JS-copy (**C**) fast enough at scale? → spike measurement.

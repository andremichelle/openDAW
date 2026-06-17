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

## Reclaiming allocator — current gap (TODO)

The `engine` crate ships a **test-grade bump allocator**: a fixed arena + a cursor, `alloc` bumps
forward, **`dealloc` is a no-op**. It never reclaims, so with churn it only grows and eventually
exhausts. Fine for the bounded `.odsl` replay/sync test, not for a continuously running engine.

The cleanup *logic* is already correct: Rust ownership runs `Drop` and calls `dealloc` for removed
boxes, rebuilt edges, and unsubscribed observers (the subscription test proves the observer's
captured state frees on unsubscribe). Only the allocator decides whether freed memory is reclaimed,
so swapping it needs **no changes to drop logic**.

**To do:** replace the bump with a **real reclaiming allocator**. Prefer a homebrew free-list (no
dependency, matches the minimal-deps rule); fallback is a small crate (`talc` / `dlmalloc`).

**This gates samples.** Sample PCM buffers are large and dynamic. When an `AudioFileBox` / sample is
removed its buffer must actually free, otherwise the engine leaks audio memory fast. So the real
allocator is a **prerequisite before the engine loads/manages samples** (see the AudioData section
below), not just boxes and device instances.

## Other memory concerns

- **No growth in the hot path:** pre-size/pre-grow memory; arena allocators; refresh JS views if it
  ever grows.
- Read-only **box graph** lives in (shared) memory, read by the engine.
- Audio buffers, param blocks, telemetry, event queues = fixed layouts in shared memory (part of the
  ABI).
- Memory is `SharedArrayBuffer`-backed (needed anyway for asset `AudioData` delivery and
  main↔worklet comms).

## AudioData (samples) delivery — SAB-backed engine memory

**Constraint:** a wasm module can address **only its own linear memory**. Unlike the TS worklet
(which can view any `SharedArrayBuffer` handed to it), the engine wasm cannot read an external SAB.
So sample PCM must live **inside** the engine's memory.

**Decision:** the engine's `WebAssembly.Memory` is created **`shared: true` + `maximum`** so its
`.buffer` *is* a `SharedArrayBuffer`. Then it mirrors the TS sample path zero-copy: PCM lives in the
shared memory; the main thread/loader writes it; the engine reads it as `&[f32]` in render — no copy,
no JS in the hot path. (Needs COOP/COEP — already in place.)

Flow (the off-thread asset path of the execution-only model):
1. Main thread / loader fetches + decodes the sample to f32 PCM **off-thread**.
2. It writes the PCM into a host/engine-designated region of the shared memory.
3. The box-graph sample reference is "ready" only after the write completes (ready flag / pointer);
   the engine reads it **only then**.
4. Render reads the sample slice directly at its offset — zero-copy, identical principle to TS.

**Growth:** samples are large/dynamic and can't be pre-sized for all cases → `memory.grow` the
**shared** memory **off-thread** as samples import. Shared-memory grow does not detach the buffer
(existing views stay valid, length extends). **Never grow during `process`.**

**Current state:** the spikes used a **non-shared** `Memory`; supporting AudioData requires switching
the engine memory to `shared: true` + `maximum`. AudioData delivery is the concrete driver to make
the memory SAB-backed (was deferred above) and raises the stakes on the shadow-stack overlap below.

## Spike (do this first)

Tiny PoC in an AudioWorklet: engine wasm + 1 device wasm sharing one `Memory` + `Table`, render a
block **wasm-to-wasm**, measure. Validate model **A**; confirm **C** as fallback. This de-risks the
plugin architecture before any real porting.

## Device state must be per-instance (no module statics) — verified

A device module is loaded **once** but instantiated **many times** (10 reverbs, 20 EQs). Holding DSP
state in Rust `static mut` gives **one global per module** at a fixed linear-memory address, so every
"instance" shares it and corrupts the others. Proven: two instances of one `osc` module with their
own state → clean independent 110 + 440 Hz (parity 6e-8); the same two pointed at one shared state →
both tones collapse to garbage.

**Rule:** instance state lives in an **engine-assigned state block** in shared memory, handed to the
device via the descriptor (`process(desc)` where the descriptor carries a `state_ptr`). Devices are
**reentrant code over external state** — never module-global mutable state. (The `chain-lp` /
`chain-delay` spike devices use `static mut` and are therefore single-instance demos only.)

**Safe devices.** Crossing the raw-offset boundary needs `unsafe`, but it is confined to one audited
shim crate (`abi`): `Ports::from_descriptor(desc_ptr)` parses the canonical descriptor into safe
slices (`output: &mut [f32]`, `inputs.get(i): &[f32]`, `params: &[f32]`) and typed state
(`state: &mut S`). Device DSP is then **100% safe Rust** — the only `unsafe` a device contains is the
single boundary call. `osc` is the reference (verified bit-identical after the conversion).

## Shadow-stack overlap — found, UNSOLVED

The comprehensive rack (`comp-engine` + filter + ring + heap-delay, all in one shared memory)
confirmed data isolation works but surfaced a separate problem: **rust-lld pins every module's
shadow stack at `[0, stack-size)`**. `--global-base` relocates a module's *static data* (verified:
engine 1 MiB, filter 4 MiB, ring 8 MiB, delay heap 13 MiB — disjoint) but **not** the stack;
`--stack-first` had no effect via `rustc-cdylib-link-arg`. So all modules' shadow stacks overlap.

Today it's harmless only because the spike's DSP functions keep locals in wasm registers and never
spill to the linear-memory stack (full-rack parity is bit-exact). But a device that spills (large
local arrays, deep calls) would clobber the caller's live frame. Options to resolve before complex
devices land:

- **Per-device memory (model B/C):** each module its own memory for stack/heap, share only an I/O
  memory. Cleanest isolation; needs multi-memory or host-copied I/O.
- **No-spill discipline:** keep device DSP register-only (no large stack locals); enforce by lint /
  review. Fragile.
- **Patch `__stack_pointer`:** post-link rewrite of each module's stack-pointer global into its slab.
  Works but hacky.

Decision pending. Does not block the single-device path; matters for the multi-device rack.

## Open

- Multi-memory browser support (decides whether **B** is viable).
- Device allocator strategy (`no_std` / custom global allocator / arena API).
- Is per-device JS-copy (**C**) fast enough at scale? → spike measurement.

# Memory System — the actual fix

Companion to `memory-ceiling.md`. Everything here is evaluated against the tools we have today
(current Chrome/Firefox/Safari, current Rust toolchain, current codebase).

> **STATUS 2026-07-28: Fix 1 SHIPPED** (`84f763642`) — non-shared memory, worklet-owned, no ladder, frozen
> audio via the `setFrozenAudio` command, grow-safety (view re-registration + call-first-then-view at every
> pointer site), test harnesses flipped, full wasm suite green. Fix 2 and Fix 3 remain open, gated on data.

## The real problem, one paragraph

The engine memory CAN grow — but only up to a `maximum` that must be reserved as address space at
creation, because the memory is `shared: true` and a shared memory may never move. That upfront
reservation is what fails on Android (Riffle crash): not RAM, address space. Dropping the sharedness
removes the rigidity: a NON-shared memory may be relocated by the runtime on grow, so no upfront
reservation, no probe ladder, no reservation crash. On desktop the runtime still reserves generously and
grows in place (identical to today); on constrained devices it falls back to moveable buffers
automatically. The browser implements our fallback ladder for us.

## Why sharedness is almost unused already (verified 2026-07-28)

The shared flag exists "so the main thread can see the WASM heap" (build-wasm.sh comment). But:

- Sample PCM is ALREADY delivered by message and written into wasm memory BY THE WORKLET itself
  (`processor.ts:222` — `fetchAudio` → structured clone to the worklet → worklet-side copy). The one-time
  copy the fix implies already happens today.
- Live meters/telemetry ALREADY copy worklet-side into the LiveStream's OWN SharedArrayBuffer
  (`LiveStreamBroadcaster` allocates its own SAB). No dependency on the wasm memory being shared.
- Sync bytes, engine state, control flags, HR clock: all separate small SABs. Unaffected.
- The ONLY remaining main-thread write into the shared wasm memory is FROZEN AUDIO
  (`WasmEngine.connectFrozenAudio` — bulk copy on the main thread).

So the shared memory carries exactly one consumer. The design note that justified it is stale.

## Fix 1 — drop `shared: true` (DONE, `84f763642`)

1. **Create the memory inside the worklet/worker.** Non-shared memories cannot be postMessaged, so
   `createEngineMemory()` moves from the main-thread factory (`WasmEngine.ts:70`) into the processor
   constructor. The offline worker already creates its memory in-worker (`offline-worker.ts:105`) — flip
   the flag there and it is done; this is the path that crashed at Riffle.
2. **Frozen audio joins the sample path.** Deliver `AudioData` to the worklet by message (transferables =
   zero-copy handoff) and copy worklet-side, chunked across quanta if large — exactly how samples already
   flow. `connectFrozenAudio`'s main-thread write is deleted.
3. **Build flags.** Drop `--shared-memory --max-memory` from build-wasm.sh (the comment already notes we
   never enabled atomic ops — the flag was only for the shared declaration). Engine + device side modules
   rebuild; no Rust code changes.
4. **Delete the probe ladder.** A non-shared memory can omit `maximum` entirely; `createEngineMemory`
   becomes `new WebAssembly.Memory({initial: 256})`. The unguarded-rung bug (memory-ceiling.md) disappears
   with the ladder.

Costs, stated honestly:

- On constrained devices, a grow may relocate = one memcpy of the current heap (e.g. ~50 ms at 500 MB).
  Rare, load-time, and pre-accepted ("even if it introduces audio glitches for a second"). Desktop: grows
  stay in place, zero cost.
- Genuine RAM exhaustion is still possible — the fallible-allocation work (memory-ceiling.md Phase 1)
  remains the safety net for that, unchanged.
- Riffle's N parallel projects still hold N resident copies of their PCM. No longer a crash, just
  commit-size pressure; see Fix 3.

## Fix 2 — working-set eviction (for weak devices; optional, later)

With Fix 1 the ceiling is real RAM instead of address space. For devices whose RAM a project genuinely
exceeds, add per-asset accounting + eviction to the sample store: samples not referenced by anything
audible are freed (slot back to `Requested`); the EXISTING loader re-fetches on demand
(`pending` → `fetchAudio`). Zero render-path changes, `SampleRef` untouched, pure Rust
(`sample.rs::allocate` + an LRU stamp in `resolve_sample`, pin while bound to an audible region).
Do it when the heap high-water meter (memory-ceiling.md Phase 3) shows real projects exceeding
weak-device RAM — not before.

## Fix 3 — PCM once per tab (multi-project SDK; only if demanded)

If the SDK's parallel-project case (Riffle) needs the duplication gone: decoded PCM lives in host-side
chunked SABs shared by all engines, and engines stream windows into small per-voice rings (bounded
memcpy in the worklet wrapper, same thread, prefetched — desktop keeps assets resident via a threshold so
its render path is unchanged). This is real work (the read contract forks) and is NOT needed for
correctness once Fix 1 lands — it is a footprint optimization. Do not start it without a measured need.

## Order

1. ~~Fix 1~~ DONE (`84f763642`, realtime + offline in one pass; the heap meter shipped before it).
2. Watch the heap high-water (footer "Memory") on heavy real projects, then decide Fix 2 by data.
3. Fix 3 only on measured SDK demand.

## Residency note (2026-07-28, corrected)

An ACTIVE sample is resident twice by DESIGN: the main-thread `GlobalSampleLoaderManager` cache (SAB-backed
`AudioData`) plus the engine's wasm copy. This is refcounted — deleting the sample releases the main-thread
side (verified live: the "Samples (GC)" footer counter falls). NOT a leak. A consume-on-deliver refactor
(loaders drop their reference after handing to the engine) was implemented and fully REVERTED (user call,
2026-07-28) — the churn across ten consumer sites outweighed the win. Revisit only as a deliberate,
user-designed change if mobile footprint demands it; the raw fact: it would roughly halve PCM residency
per open project.

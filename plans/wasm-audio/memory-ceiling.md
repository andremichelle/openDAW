# Working past the memory ceiling

## The constraint (fixed, not negotiable)

The engine's linear memory is a SHARED `WebAssembly.Memory`. Shared memory must declare a `maximum` and cannot grow past it (proven: `grow` past max → "Maximum memory size exceeded"), and the runtime reserves the whole `maximum` as virtual address space at creation (proven: 64×1 GB reserved on a machine without 64 GB RAM). So:

- The ceiling = the reservation = the growth cap. One number.
- A device can only host an engine whose ceiling it can reserve. A low-end Chromebook cannot reserve 4 GB of contiguous address space (error #1030), so on that device the ceiling is whatever it CAN reserve, not 4 GB.
- Samples, soundfont PCM, frozen audio and each device instance's data region + stack all live IN this memory (wasm can't read a foreign SAB). So total loaded media + devices is bounded by the ceiling.

Nothing makes media larger than a device's reservable address space fit in that memory. The plan is therefore two things: (1) never crash when the ceiling is hit, and (2) give the user a way to keep working and recover — plus a long-term path that removes media from the ceiling entirely.

## Invariants

1. The engine NEVER traps on out-of-memory. An allocation that can't be satisfied returns a clean failure; the audio thread and the worklet stay alive.
2. The box graph is always intact, editable and saveable, even when assets failed to load. A save reloaded on a capable device restores full fidelity.
3. Every failure is visible and actionable: the user is told what didn't fit and can free space to recover.

## Boot ceiling: take the most the device will give

Boot at the LARGEST `maximum` the device accepts (probe 4 GB → 2 → 1 → 512 MB, keep the first that constructs — already implemented in `createEngineMemory`). Capable devices are not limited; constrained devices get their best. This avoids a reboot-to-grow scheme: the ceiling is the device's ceiling, chosen once at boot. Expose the chosen ceiling to the UI (for the meter + budget below).

## Phase 1 — Never-trap foundation (correctness; do first)

Make every LARGE, host-driven allocation fallible and return a failure sentinel instead of aborting. Today `SampleResource::allocate` / `SoundfontResource::allocate` do `vec![0u8; byte_len]`, which calls `handle_alloc_error` → `unreachable` and kills the whole engine.

- `crates/engine/src/sample.rs::allocate`, `soundfont.rs::allocate`: `Vec::try_reserve_exact(byte_len)`; on `Err` return `0` (the existing bad-handle sentinel), leaving the slot in a clean `Failed` state.
- Device instantiation (the per-instance data region + stack the linker allocates from talc, `engine-processor.ts`): the linker's alloc must be fallible too. A device that can't get its data region fails to instantiate rather than trapping.
- Frozen render buffers (`frozen_allocate`), click/scratch buffers: same fallible pattern.
- Host side (`engine-processor.ts` sample + soundfont drain loops): check `pointer === 0` and route to the EXISTING missing-asset path (1-frame silence + a reported reason) instead of `loader.write(uuid, 0)`.

Buys: the engine survives any OOM. This alone converts the crash into "that one asset is silent" and keeps the session alive. Small, high-value, ship immediately.

## Phase 2 — Graceful degradation + visibility

Turn a failed allocation into a first-class, recoverable state instead of a silent stub.

- Asset state machine: a sample/soundfont handle gains an `Unloaded(OutOfMemory)` state (distinct from `Failed(fetch)` and `Missing`). It renders as silence but is flagged, not forgotten.
- Device state: a device that couldn't instantiate shows `unavailable (memory)` in its slot; its chain passes audio through (bypass). The device box stays in the graph.
- UI: a Toast ("Out of memory: '<sample>' not loaded — free space to load it") on each OOM, and a persistent indicator on the affected sampler/device. One aggregated banner when several fail in a burst (a big project load).
- Save/reload fidelity: the graph keeps every box + asset reference, so a save carries the full project; reloading on a capable device (or after freeing space) loads everything.

Buys: the user knows exactly what didn't fit and that the project is intact. "Continue working" is real here — arrange, edit, remove, save all function with placeholders in place.

## Phase 3 — Memory budget + admission control (proactive)

Stop hitting the wall blind; refuse or defer allocations that won't fit BEFORE attempting them.

- The engine tracks heap high-water vs the boot ceiling and exposes both (a broadcast slot; reuse the telemetry path). A memory meter in the UI (bytes used / ceiling).
- Admission check: before a large load, compare `byte_len` against remaining headroom (minus a safety margin). If it won't fit, skip straight to the `Unloaded(OutOfMemory)` state — no trap risk, no thrash.
- Threshold warning: at e.g. 85% a non-blocking warning ("memory almost full") so the user can act before assets start dropping.

Buys: predictable behaviour and a warning before the cliff, instead of assets silently vanishing at the wall.

## Phase 4 — Reclaim + retry (recover without reload)

talc reclaims freed memory, so removing assets frees the heap — make that the recovery loop.

- Freeing an asset (delete a sampler, remove a device, clear a slot) frees its PCM/state.
- After any free that lowers usage below the threshold, auto-retry the `Unloaded(OutOfMemory)` assets (oldest first) so they load without a manual reload.
- Optional: an explicit "Free unused media" action that unloads PCM for samples referenced by no live box (defensive; the graph teardown should already free these — verify).

Buys: the user removes something heavy and the previously-dropped assets come back automatically. The session is self-healing within the device's ceiling.

## Phase 5 — Streaming media out of the linear memory (the only unbounded fix)

Phases 1–4 keep the user working WITHIN the device's ceiling. To let a device play media LARGER than its address space, the media cannot be fully resident in the linear memory.

- Keep sample/soundfont PCM in host-side storage (the OPFS `SampleStorage` + a SAB staging buffer), NOT the engine heap.
- The engine holds only a small fixed per-voice read window; the host pages the currently-playing region of each active sample into that window each block, with prefetch to avoid underruns.
- Frozen audio streams the same way.

This decouples library size from the ceiling entirely: a 256 MB engine heap can play a 10 GB soundfont. Cost: a paging layer, per-block copies of active windows, prefetch/underrun handling, and a real measurement pass on the audio thread with many simultaneous voices before committing (the per-block copy cost is the risk). Largest effort; do last, and only if projects that exceed a capable device's ceiling are actually common — measure the heap high-water on heavy real projects (Phase 3's meter) to decide.

## What each phase does and does not do

- Phases 1–2 stop the crash and keep the project alive/editable. They do NOT make more fit.
- Phases 3–4 make behaviour predictable and self-healing within the ceiling. Still bounded by the device.
- Phase 5 removes the ceiling as a media limit. It's the only phase that lets a weak device handle arbitrarily large media, and it's the most expensive.

## Immediate next step

Phase 1 (fallible allocs + host `pointer === 0` handling) is small, purely defensive, and turns the current hard crash into graceful silence. Land it first, then instrument the heap high-water (Phase 3's meter) so the ceiling and the streaming decision are driven by real numbers, not guesses.

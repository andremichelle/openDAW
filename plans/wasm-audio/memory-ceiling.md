# Working past the memory ceiling

> Companion: `memory-systems.md` evaluates REPLACEMENT memory-management systems (media arena + eviction,
> shared media pool + streaming, consolidated multi-engine memory) with trade-offs and dry-run
> implementations. This file covers the current system's ceiling/crash behaviour.

> **STATUS 2026-07-28: the address-space ceiling is GONE.** `84f763642` dropped `shared:true` — the memory
> is non-shared, created inside the worklet/worker, `{initial: 256}` with no maximum and no probe ladder.
> The runtime relocates the buffer on grow, so the reservation-failure class (#1030, the Riffle Android
> export crash) no longer exists. The frozen-audio main-thread writer and its RPC protocol were removed
> (delivery via the `setFrozenAudio` command, worklet-side copy), and grow-safety landed with it: held
> broadcast views re-register on buffer identity change, and every `new View(memory.buffer, ptr_call())`
> site is call-first-then-view (argument evaluation fetched the buffer BEFORE the call that could grow it).
> `3f79e440d` also shipped the RMS-meter decimation from the device-state refactor below.
> The remaining ceiling is REAL RAM: physical exhaustion still traps the engine, so Phases 1-4 below stand.

## The constraint (historical — resolved by 84f763642)

The engine's linear memory WAS a SHARED `WebAssembly.Memory`: shared memory cannot relocate, so the whole
`maximum` had to be reserved as address space at creation, and a constrained device could fail that
reservation outright (#1030). With the non-shared memory this section no longer constrains anything; what
remains true: samples, soundfont PCM, frozen audio and each device instance's data region + stack all live
IN this memory, so total loaded media + devices is bounded by the device's REAL memory, and an allocation
that cannot be satisfied still traps the engine today (Phase 1 fixes that).

## Invariants

1. The engine NEVER traps on out-of-memory. An allocation that can't be satisfied returns a clean failure; the audio thread and the worklet stay alive.
2. The box graph is always intact, editable and saveable, even when assets failed to load. A save reloaded on a capable device restores full fidelity.
3. Every failure is visible and actionable: the user is told what didn't fit and can free space to recover.

## Boot ceiling (historical — the ladder is deleted)

`createEngineMemory` probed maxima 4 GB → 2 → 1 → 512 MB and the final rung was unguarded (the literal
Riffle crash). All gone: non-shared memory needs no maximum, every engine starts at 16 MB and grows on
demand. The multi-engine caveat (N engines starving each other's reservations) dissolved with it — engines
now cost what they actually use. The heap meter shipped separately (`EngineAddresses.HEAP` broadcast + the
footer "Memory" item), giving the observability Phases 3-4 need.

## Findings 2026-07-28 — Riffle production crash (RESOLVED by 84f763642)

`RangeError: WebAssembly.Memory(): could not allocate memory` at `initialize` in `wasm-offline-worker.js`
(`[components/Track.error.exporting.track]`). Riffle runs one AudioWorklet per project in parallel and
exports tracks via the offline worker. The reservation mechanics below are historical (no reservations
exist anymore); the OOM chain and the retention holes remain accurate. Verified facts:

- **Every engine boot allocates a fresh memory.** Realtime: the `EngineVariant` factory runs per
  `EngineWorklet` boot and calls `createEngineMemory()` each time (`WasmEngine.ts:70`; deliberate — a
  recycled heap would leak the previous instance's allocations). Offline: each export spawns a fresh
  `Worker` whose `initialize` calls `createEngineMemory()` again (`offline-worker.ts:105`). So N parallel
  projects = N live reservations, plus one more per concurrent export.
- **The scarce resource on Android is the reservation budget, not RAM.** Chrome's per-process wasm
  address-space budget is far smaller than desktop. Parallel worklets each holding multi-GiB maxima
  exhaust it; the export worker's probe ladder then falls all the way through.
- **BUG (fix immediately, independent of everything else): the final ladder rung is unguarded.**
  `engine-modules.ts:79` (`maximum: 4096`) sits OUTSIDE the tryCatch — when even 256 MiB cannot be
  reserved, the raw `RangeError` escapes. That is verbatim Riffle's stack. It must throw a NAMED error
  ("engine memory reservation failed") so hosts can react programmatically; consider 2048/1024-page rungs
  before failing.
- **What happens today when a RUNNING engine hits its ceiling (verified chain):** talc `memory.grow` →
  refused at max → allocation returns null → Rust alloc-error panic ("memory allocation of N bytes
  failed") → `panic_to_host` trap → the worklet catches it, invalidates (`process()` returns false) and
  escalates via `engineToClient.error` → `StudioService.restartEngine()` offers the reboot. Offline: the
  render rejects cleanly and `worker.terminate()` releases the reservation. No tab crash, no corruption.
  The dominant allocator is sample data, so OOM fires almost always during LOADING, not mid-DSP —
  which is what makes Phase 1's per-asset fallible-alloc approach viable.
- **Cleanup audit — the two main paths do NOT leak.** Offline: `worker.terminate()` runs on success,
  failure, and abort. Realtime: `EngineWorklet.terminate()` → processor invalid → collectible; the
  frozen-audio bridge closure holding the memory dies with the worklet.
- **Real retention holes (not the crash, fix cheaply):**
  1. `OfflineEngineRenderer.create()` without a later `render()`/`terminate()` retains worker+memory
     forever (SDK-misuse trap; `start()` is safe).
  2. If loading never completes (a sample fetch rejects in the worker), `render`'s
     `queryLoadingComplete` poll loop spins forever with no timeout — worker + memory retained until the
     tab dies unless an `abortSignal` was passed. Add a timeout.
  3. Crash→reboot transiently double-holds (old reservation until GC + the new boot's) — only matters on
     Android-class budgets.
- **Advice to Riffle regardless of our changes:** serialize exports (one offline worker at a time), do not
  keep one live worklet per project on mobile (suspend/terminate background projects), always pass an
  `abortSignal` to exports.

## Out-growing the maximum (historical — there is no maximum anymore)

The analysis (raw heap migration rejected; escalation-by-reboot as the alternative) became moot when the
shared flag dropped: a non-shared memory has no reservation to escalate past, the runtime relocates on
grow. What survives from that analysis: the `EngineOOM` classification idea (tag "memory allocation …
failed" panics distinctly in `describeEngineTrap`) is still useful for Phase 2's messaging, and a reboot
remains the only way to RETURN committed pages (see "Idle compaction" under remaining issues) because wasm
memory never shrinks.

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

## Device-state refactor: stop compile-time worst-case sizing

Orthogonal to the OOM phases: this one lowers baseline usage. Most device crates export `state_size()` as a plain `size_of::<State>()`, a compile-time constant. Any rate-dependent ring inside the state must then be a fixed-length array sized for a worst case chosen at compile time, even though the engine's sample rate is fixed at boot and known before any device instantiates. The pattern wastes memory in one direction and truncates DSP in the other:

- ~~`dsp::meter::StereoMeter`~~ DONE (`3f79e440d`): the RMS ring now stores one mean-square per 128-frame bucket — 2 KB per channel instead of 115 KB, correct at any rate up to ~218 kHz.
- `dsp::dattorro`: `PRE_DELAY_SIZE = 65536` (`next_pow_of_2(48000 + 1)`) — 256 KB sized for 48 kHz, and the opposite failure above that: at 96 kHz the maximum pre-delay TIME halves instead of the buffer growing.
- `dsp::freeverb`: `MAX_DELAY_SIZE = 32768` per channel plus comb/allpass arrays tuned for 44.1/48 kHz — same dual problem.
- Smaller cases (`device-maximizer` look-ahead, scratch buffers) follow the same pattern but are cheap enough to ignore.

The contract already supports the fix: `device-delay` ends its state with a flexible `[f32; 0]` tail, exports `state_size(sample_rate)` (header + rate-derived buffer bytes), and slices its four delay lines out of the engine-allocated tail in `process`. The refactor is migrating every rate-dependent fixed array onto that pattern so blocks shrink to what the boot rate actually needs and the 48 kHz-sized rings stop truncating at 96 kHz. Where per-sample exactness is irrelevant (the meter RMS), decimating the ring to per-quantum sums (~1 KB per channel) is an acceptable cheaper alternative.

## What each phase does and does not do

- Phases 1–2 stop the crash and keep the project alive/editable. They do NOT make more fit.
- Phases 3–4 make behaviour predictable and self-healing within the ceiling. Still bounded by the device.
- Phase 5 removes the ceiling as a media limit. It's the only phase that lets a weak device handle arbitrarily large media, and it's the most expensive.

## Immediate next step

Phase 1 (fallible allocs + host `pointer === 0` handling) is small, purely defensive, and turns a real-RAM
OOM from an engine death into graceful silence for the one asset. Land it next; the heap high-water meter
already exists (footer "Memory" item), so Phases 3-5 decisions can be data-driven. Of the earlier
one-liners: the ladder guard died with the ladder (`84f763642`); still open are the `EngineOOM` panic
classification in `describeEngineTrap` and a timeout on the offline `queryLoadingComplete` poll loop.

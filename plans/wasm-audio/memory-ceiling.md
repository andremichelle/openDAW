# Working past the memory ceiling

> Companion: `memory-systems.md` evaluates REPLACEMENT memory-management systems (media arena + eviction,
> shared media pool + streaming, consolidated multi-engine memory) with trade-offs and dry-run
> implementations. This file covers the current system's ceiling/crash behaviour.

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

Caveat (2026-07-28, see the Riffle findings below): "take the most the device will give" is right for ONE engine — the studio. It is wrong for multi-engine hosts: N parallel engines each grabbing the largest reservation the device accepts starve each other and the offline export worker on Android-class budgets. The ceiling probe needs a host-configurable starting rung (SDK option), so an embedder running many engines can start small deliberately.

## Findings 2026-07-28 — Riffle production crash (Android, parallel engines)

`RangeError: WebAssembly.Memory(): could not allocate memory` at `initialize` in `wasm-offline-worker.js`
(`[components/Track.error.exporting.track]`). Riffle runs one AudioWorklet per project in parallel and
exports tracks via the offline worker. Verified facts:

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

## Can a running engine out-grow its maximum? (2026-07-28 analysis)

**In place: no** — hard spec limit; a shared memory's maximum is fixed at creation (every thread's views
depend on the base staying put). "Keep going" necessarily means a NEW memory and NEW instantiations; the
only question is where the state comes from.

**Rejected: raw heap migration.** Copy the old bytes into a bigger memory at identical offsets (wasm
pointers are offsets, so the Rust object graph would stay valid) and re-instantiate engine + every device
module against the new memory. Conceivable but a minefield: the re-link must replay layout byte-identically
(device `__memory_base`s, stack bases, function-table indices), then re-copy the old heap over the
freshly-applied data segments; every JS-side view (live-meter views, sync bytes, frozen-audio writer,
in-flight sample writes) must be rebuilt against the new buffer; both threads must be provably quiescent
(wasm globals like `__stack_pointer` are per-instance and start fresh, so no wasm frame may be live). Any
drift silently corrupts the heap instead of failing loudly. Maximal fragility to save state the main thread
can rebuild anyway.

**Viable alternative: escalation by reboot** — start small, and on ceiling-hit reboot the engine with a
larger maximum, replaying state from the main thread (box graph, sample cache, frozen audio — the durable
source of truth; the crash-restart flow already rebuilds all of it). Cost: a ~1 s audio gap, accepted as
tolerable (user call, 2026-07-27). Pieces: classify the OOM trap as `EngineOOM` (the panic text is already
delivered via `describeEngineTrap`), a session memory ladder (start small on constrained devices, next rung
on OOM, remember the rung), same escalation with one retry in the offline worker, silent auto-restart on
`EngineOOM` (gated on `isRecording === false` — a reboot mid-recording loses the take).

**Reconciliation with this plan's phases:** boot-at-max + never-trap (Phases 1-4) is the better end state
for the STUDIO — no reboot, assets degrade gracefully within the device's ceiling. Escalation-by-reboot
matters for the MULTI-ENGINE case (SDK hosts like Riffle), where greedy boot-at-max is itself the problem:
embedders start engines small (host-configured rung), and the rare project that outgrows its rung reboots
one engine upward instead of every engine hoarding the maximum up front. The two compose: small default
rung for SDK + never-trap within the rung + `EngineOOM`-triggered escalation as the growth path.

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

- `dsp::meter::StereoMeter` (2026-07-28, RMS window 100 ms → 300 ms): the RMS rings are `[f32; 28800]` per channel (300 ms at 96 kHz), ~230 KB per meter. The Playfield embeds one per slot, so a large kit pays MBs for meters alone; at 48 kHz two thirds of every ring is dead capacity.
- `dsp::dattorro`: `PRE_DELAY_SIZE = 65536` (`next_pow_of_2(48000 + 1)`) — 256 KB sized for 48 kHz, and the opposite failure above that: at 96 kHz the maximum pre-delay TIME halves instead of the buffer growing.
- `dsp::freeverb`: `MAX_DELAY_SIZE = 32768` per channel plus comb/allpass arrays tuned for 44.1/48 kHz — same dual problem.
- Smaller cases (`device-maximizer` look-ahead, scratch buffers) follow the same pattern but are cheap enough to ignore.

The contract already supports the fix: `device-delay` ends its state with a flexible `[f32; 0]` tail, exports `state_size(sample_rate)` (header + rate-derived buffer bytes), and slices its four delay lines out of the engine-allocated tail in `process`. The refactor is migrating every rate-dependent fixed array onto that pattern so blocks shrink to what the boot rate actually needs and the 48 kHz-sized rings stop truncating at 96 kHz. Where per-sample exactness is irrelevant (the meter RMS), decimating the ring to per-quantum sums (~1 KB per channel) is an acceptable cheaper alternative.

## What each phase does and does not do

- Phases 1–2 stop the crash and keep the project alive/editable. They do NOT make more fit.
- Phases 3–4 make behaviour predictable and self-healing within the ceiling. Still bounded by the device.
- Phase 5 removes the ceiling as a media limit. It's the only phase that lets a weak device handle arbitrarily large media, and it's the most expensive.

## Immediate next step

Phase 1 (fallible allocs + host `pointer === 0` handling) is small, purely defensive, and turns the current hard crash into graceful silence. Land it first, then instrument the heap high-water (Phase 3's meter) so the ceiling and the streaming decision are driven by real numbers, not guesses.

Even before Phase 1, three one-liners from the 2026-07-28 findings ship independently: guard the final
`createEngineMemory` rung (named error instead of a raw RangeError — the actual Riffle crash), tag the
alloc-failure panic as `EngineOOM` in `describeEngineTrap`, and a timeout on the offline
`queryLoadingComplete` poll loop.

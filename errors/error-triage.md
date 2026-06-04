# openDAW Error Triage — unresolved (fixed=0)

Snapshot of https://logs.opendaw.studio. **56 unresolved** across **33 signatures** (scanned 914 rows, ids 1..1001).

Priority: **P1** highest-value real bugs · **P2** real bugs · **P3** lower/needs-context · **ENV** environmental/transient. **RESOLVED** = message already gone from current source (verify + mark fixed).

> Workflow per error (proven on #995–#1001): pull full logs+stack → root-cause → reproduce (unit test where feasible) → fix or soften → regression test → branch→main → mark `fixed=1` on server.

## RESOLVED in current source — verify & mark fixed

### [5×] Error: Overlapping detected after clipping
- **status:** RESOLVED · **priority:** — · **category:** Timeline: overlap-after-clipping
- **ids:** [738, 740, 745, 748, 758] · **span:** 2026-02-14→2026-02-23 · **builds:** 4 · **browsers:** ?/macOS, Chrome/CrOS, Chrome/Win, Firefox/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at Go.validateTrack (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:130980)`
  - `at Go.validateTracks (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:130668)`
  - `at T1.apply (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:138585)`
- **assessment:** Message gone from current source; validateTrack overlap branch is now non-fatal (console.error). Verify on a current build, then mark fixed.
- **action:** Mark fixed=1; spot-check no recurrence on latest build.

### [1×] Error: duration will zero or negative(N)
- **status:** RESOLVED · **priority:** — · **category:** Timeline: duration zero/negative
- **ids:** [667] · **span:** 2026-01-29→2026-01-29 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at n.clip (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:43:71792)`
  - `at main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:53:20544`
  - `at Array.forEach (<anonymous>)`
- **assessment:** 'duration will zero or negative' no longer in source.
- **action:** Mark fixed=1.

### [1×] Error: duration(N) must be positive
- **status:** RESOLVED · **priority:** — · **category:** Timeline: region duration must be positive
- **ids:** [982] · **span:** 2026-05-25→2026-05-25 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at nt (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at Ba.validateTrack (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:80:124900)`
  - `at main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:80:132838`
- **assessment:** Same root as #998; fixed by validateTrack softening (commit b7e33d8c9).
- **action:** Mark fixed=1.

## P1

### [5×] Error: Unknown key: N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N
- **status:** OPEN · **priority:** P1 · **category:** Mixer: 'Unknown key' channel-strip lookup
- **ids:** [924, 925, 926, 984, 985] · **span:** 2026-04-20→2026-05-26 · **builds:** 2 · **browsers:** Chrome/Win, Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at g (../../../lib/std/dist/lang.js:10:103 (panic))`
  - `at bA.get (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:2:33246)`
  - `at Jq.registerChannelStrip (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:90:23407)`
- **assessment:** SortedSet.get() (sorted-set.ts:128) misses inside Mixer.registerChannelStrip (Mixer.ts:64). 5x, recent.
- **action:** Find the by-uuid map queried before insert/after remove; use getOrNull + guard. Reproduce add/remove audio-unit while mixer open.

### [1×] Error: Invalid duration(N)
- **status:** OPEN · **priority:** P1 · **category:** Timeline: Invalid duration(N)
- **ids:** [933] · **span:** 2026-04-23→2026-04-23 · **builds:** 1 · **browsers:** Chrome/macOS
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at Ca.createTasksFromMasks (main.d6fa9f56-2884-462b-9f96-1a90cb1386e3.js:55:119115)`
  - `at #r (main.d6fa9f56-2884-462b-9f96-1a90cb1386e3.js:55:120247)`
  - `at Ca.fromRange (main.d6fa9f56-2884-462b-9f96-1a90cb1386e3.js:55:118406)`
- **assessment:** RegionClipResolver.ts:134 still panics in createTasksFromMasks on duration<=0. Sibling of #998; same 0-duration origin.
- **action:** Soften to non-fatal + clamp at creation source. See project-zero-duration-region-origin memory.

## P2

### [2×] TypeError: l.catch is not a function. (In 'l.catch(p=>(l=null,p))', 'l.catch' is undefine
- **status:** OPEN · **priority:** P2 · **category:** UI: Checkbox '.catch is not a function'
- **ids:** [815, 816] · **span:** 2026-03-16→2026-03-16 · **builds:** 1 · **browsers:** ?/macOS
- **source:** `src/ui/components/Checkbox.tsx:21`
- **stack:**
  - `@../../../lib/runtime/dist/promises.js:126:32 (error)`
  - `requestPermission@../../../studio/core/dist/midi/MidiDevices.js:52:86 (#memoizedRequest)`
  - `requestPermission@../../../studio/core/dist/midi/MidiDevices.js:66:4`
  - `setValue@../../../studio/core/dist/midi/MidiDevices.js:132:39`
- **assessment:** Checkbox.tsx:21 calls .catch on a non-Promise.
- **action:** Wrap value in Promise.resolve() or type-guard before .catch.

### [1×] Error: Already assigned
- **status:** OPEN · **priority:** P2 · **category:** Automation: 'Already assigned'
- **ids:** [915] · **span:** 2026-04-10→2026-04-10 · **builds:** 1 · **browsers:** Chrome/macOS
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at nt (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at visitTrackBox (main.48b9ceed-59e0-471e-a603-f6ede1a45a2f.js:4:349184)`
  - `at $t (../../../lib/std/dist/lang.js:29:52)`
- **assessment:** AutomatableParameterFieldAdapter.ts:77 assert (trackBoxAdapter must be empty) — parameter assigned to two tracks.
- **action:** Guard double-assignment in automation-track creation path.

### [1×] Error: Pointer {Wt:Ce (target) UUID/N requires an edge.
- **status:** OPEN · **priority:** P2 · **category:** Box-graph: pointer 'requires an edge'
- **ids:** [983] · **span:** 2026-05-25→2026-05-25 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at tj.tryValidateAffected (../../../lib/box/dist/graph-edges.js:101:43)`
  - `at na.endTransaction (../../../lib/box/dist/graph.js:60:24)`
  - `at ../../../lib/box/dist/editing.js:172:24`
  - `at at (VideoOverlay.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:1:1493)`
- **assessment:** graph-edges.ts mandatory-pointer panic during a graph op (commit with unwired mandatory pointer).
- **action:** Identify the op (paste/import/create); wire mandatory edge or validate before endTransaction.

### [1×] Error: RootBox UUID already staged
- **status:** OPEN · **priority:** P2 · **category:** Box-graph: 'already staged'
- **ids:** [903] · **span:** 2026-03-31→2026-03-31 · **builds:** 1 · **browsers:** Chrome/macOS
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at nt (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at uc.stageBox (main.4529bd8f-147f-4173-acde-89a69905ffba.js:4:99923)`
  - `at Sa.create (main.4529bd8f-147f-4173-acde-89a69905ffba.js:4:109994)`
- **assessment:** graph.ts:140 assert; box staged twice (load/import/collab race or duplicate UUID).
- **action:** Reproduce import/restore; dedupe staging / guard re-add.

### [1×] Error: Target Wt UUID requires an edge.
- **status:** OPEN · **priority:** P2 · **category:** Box-graph: pointer 'requires an edge'
- **ids:** [820] · **span:** 2026-03-17→2026-03-17 · **builds:** 1 · **browsers:** Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at main.879b1d06-6455-4576-a16d-09c07818d1fa.js:4:93645`
  - `at Array.forEach (<anonymous>)`
  - `at g_.forEach (main.879b1d06-6455-4576-a16d-09c07818d1fa.js:2:32983)`
- **assessment:** graph-edges.ts mandatory-pointer panic during a graph op (commit with unwired mandatory pointer).
- **action:** Identify the op (paste/import/create); wire mandatory edge or validate before endTransaction.

### [1×] Error: jp UUID already staged
- **status:** OPEN · **priority:** P2 · **category:** Box-graph: 'already staged'
- **ids:** [662] · **span:** 2026-01-27→2026-01-27 · **builds:** 1 · **browsers:** Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at st (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at bp.stageBox (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:4:92124)`
  - `at jp.create (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:4:101077)`
- **assessment:** graph.ts:140 assert; box staged twice (load/import/collab race or duplicate UUID).
- **action:** Reproduce import/restore; dedupe staging / guard re-add.

## P3

### [2×] Error: Uncaught [object Event]
- **status:** OPEN · **priority:** P3 · **category:** Monaco: '[object Event]' worker
- **ids:** [642, 703] · **span:** 2026-01-22→2026-02-08 · **builds:** 2 · **browsers:** Chrome/CrOS, Chrome/Win
- **stack:**
  - `at ../../../../node_modules/monaco-editor/esm/vs/base/common/errors.js:11:16`
- **assessment:** Worker load failure surfaced as Event. ErrorHandler filters some; these slipped.
- **action:** Extend Monaco event filtering in ErrorHandler.

### [2×] Error: unwrap failed
- **status:** OPEN · **priority:** P3 · **category:** Option.unwrap failed
- **ids:** [811, 950] · **span:** 2026-03-14→2026-05-11 · **builds:** 2 · **browsers:** ?/macOS, Firefox/Win
- **stack:**
  - `h@../../../lib/std/dist/lang.js:49:48 (issue)`
  - `audioUnit@main.2cd353a9-64aa-4ec9-a7b0-4cfed46ac4ee.js:4:355046`
  - `@main.2cd353a9-64aa-4ec9-a7b0-4cfed46ac4ee.js:869:174846`
  - `@main.2cd353a9-64aa-4ec9-a7b0-4cfed46ac4ee.js:4:95595`
- **assessment:** Generic unwrap panics; need per-stack context.
- **action:** Pull stacks; replace with guarded handling.

### [2×] RangeError: Array buffer allocation failed
- **status:** OPEN · **priority:** P3 · **category:** Mixdown/offline-render OOM
- **ids:** [291, 302] · **span:** 2025-10-29→2025-11-02 · **builds:** 2 · **browsers:** Chrome/Win
- **source:** `src/service/Mixdowns.ts:105`
- **stack:**
  - `at new ArrayBuffer (<anonymous>)`
  - `at n.encodeFloats (../../../studio/core/dist/WavFile.js:70:20)`
  - `at o (src/service/Mixdowns.ts:105:33)`
  - `at async n.exportStems (src/service/Mixdowns.ts:46:8)`
- **assessment:** Array-buffer allocation / quota during large render (Mixdowns.ts, AudioOfflineRenderer.ts).
- **action:** Catch allocation/quota, surface 'render too large' message instead of crash.

### [1×] Error: QuotaExceededError: The operation failed because it would cause the applicatio
- **status:** OPEN · **priority:** P3 · **category:** Mixdown/offline-render OOM
- **ids:** [71] · **span:** 2025-08-16→2025-08-16 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/audio/AudioOfflineRenderer.ts:57`
- **stack:**
  - `at ne (../../../lib/std/dist/lang.js:22:73)`
  - `at e (src/audio/AudioOfflineRenderer.ts:57:12 (panic))`
  - `at async r.start (src/audio/AudioOfflineRenderer.ts:40:12)`
  - `at async src/service/StudioService.ts:288:16`
- **assessment:** Array-buffer allocation / quota during large render (Mixdowns.ts, AudioOfflineRenderer.ts).
- **action:** Catch allocation/quota, surface 'render too large' message instead of crash.

### [1×] NotAllowedError: [DOMException] Failed to execute 'showOpenFilePicker' on 'Window': The request
- **status:** OPEN · **priority:** P3 · **category:** Unclassified
- **ids:** [814] · **span:** 2026-03-16→2026-03-16 · **builds:** 1 · **browsers:** Edge/Win
- **assessment:** Needs review
- **action:** Triage individually.

### [1×] RangeError: Array buffer allocation failed
- **status:** OPEN · **priority:** P3 · **category:** Mixdown/offline-render OOM
- **ids:** [70] · **span:** 2025-08-16→2025-08-16 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/audio/AudioOfflineRenderer.ts:68`
- **stack:**
  - `at new ArrayBuffer (<anonymous>)`
  - `at Ii (../../../studio/core/dist/Wav.js:23:16)`
  - `at t (src/audio/AudioOfflineRenderer.ts:68:25 (encodeWavFloat))`
  - `at r.start (src/audio/AudioOfflineRenderer.ts:42:18 (saveZipFile))`
- **assessment:** Array-buffer allocation / quota during large render (Mixdowns.ts, AudioOfflineRenderer.ts).
- **action:** Catch allocation/quota, surface 'render too large' message instead of crash.

### [1×] TypeError: can't access property "X", e is undefined
- **status:** OPEN · **priority:** P3 · **category:** Monaco: factory.ts:19 null deref
- **ids:** [975] · **span:** 2026-05-20→2026-05-20 · **builds:** 1 · **browsers:** Firefox/Win
- **source:** `src/monaco/factory.ts:19`
- **stack:**
  - `n.create@src/monaco/factory.ts:19:25 (monaco)`
  - `success@src/ui/shadertoy/ShadertoyEditor.tsx:52:69`
  - `Hr/a/<@../../../lib/jsx/dist/std/Await.js:7:59 (success)`
- **assessment:** 'can't access property X, e is undefined' in monaco/factory.ts:19.
- **action:** Null-guard the editor/model access.

## ENV — environmental / transient (low code priority)

### [4×] NotFoundError: [DOMException] A requested file or directory could not be found at the time an
- **status:** ENV · **priority:** ENV · **category:** Storage: file/dir not found
- **ids:** [631, 766, 971, 974] · **span:** 2026-01-16→2026-05-19 · **builds:** 4 · **browsers:** Chrome/Linux, Chrome/Win, Edge/Win
- **assessment:** OPFS entry removed out from under us.
- **action:** Catch NotFoundError; recover/re-init.

### [4×] QuotaExceededError: The operation failed because it would cause the application to exceed its stor
- **status:** ENV · **priority:** ENV · **category:** Storage: quota exceeded
- **ids:** [951, 952, 953, 954] · **span:** 2026-05-11→2026-05-12 · **builds:** 1 · **browsers:** Edge/Win
- **assessment:** OPFS quota / no space. User disk full.
- **action:** Catch + 'storage full' dialog; not a crash.

### [3×] TypeError: Failed to fetch
- **status:** ENV · **priority:** ENV · **category:** Network: failed to fetch
- **ids:** [604, 761, 813] · **span:** 2026-01-07→2026-03-15 · **builds:** 3 · **browsers:** Chrome/Win, Edge/Win
- **assessment:** Offline/transient network.
- **action:** Ignore-list transient fetch; offline indicator.

### [2×] NotReadableError: [DOMException] The I/O read operation failed.
- **status:** ENV · **priority:** ENV · **category:** Storage: I/O read failed
- **ids:** [697, 698] · **span:** 2026-02-07→2026-02-07 · **builds:** 1 · **browsers:** ?/macOS
- **assessment:** NotReadableError (disk/IO).
- **action:** Catch + retry/message.

### [2×] SyntaxError: expected expression, got '<'
- **status:** ENV · **priority:** ENV · **category:** Deploy: HTML served for JS ('got <')
- **ids:** [160, 237] · **span:** 2025-09-24→2025-10-16 · **builds:** 2 · **browsers:** Firefox/Win, Firefox/macOS
- **assessment:** Stale/misrouted release returning index.html.
- **action:** Reload prompt; cache-bust.

### [2×] UnknownError: unhandledrejection
- **status:** ENV · **priority:** ENV · **category:** Generic unhandledrejection
- **ids:** [807, 809] · **span:** 2026-03-12→2026-03-14 · **builds:** 2 · **browsers:** ?/macOS
- **assessment:** Opaque UnknownError.
- **action:** Pull stacks; likely env.

### [1×] Error: Failed after N retries: TypeError: Failed to fetch dynamically imported module
- **status:** ENV · **priority:** ENV · **category:** Network: dynamic import / chunk load
- **ids:** [623] · **span:** 2026-01-10→2026-01-10 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/service/Mixdowns.ts:182`
- **stack:**
  - `at l (../../../lib/runtime/dist/promises.js:70:22)`
  - `at async a (src/service/Mixdowns.ts:182:31)`
  - `at async t (src/service/Mixdowns.ts:99:23)`
  - `at async src/service/StudioService.ts:202:16`
- **assessment:** Stale release / chunk load failure.
- **action:** Reload prompt on chunk-load error.

### [1×] InvalidStateError: [DOMException] Failed to construct 'AudioWorkletNode': AudioWorkletNode cannot
- **status:** ENV · **priority:** ENV · **category:** Audio device init
- **ids:** [765] · **span:** 2026-03-07→2026-03-07 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/service/StudioService.ts:457`
- **stack:**
  - `at new mC (../../../studio/core/dist/EngineWorklet.js:54:8)`
  - `at $m.createEngine (../../../studio/core/dist/AudioWorklets.js:31:15)`
  - `at Br.startAudioWorklet (../../../studio/core/dist/project/Project.js:134:62)`
  - `at t (src/service/StudioService.ts:457:47)`
- **assessment:** AudioWorkletNode ctor / device start blocked.
- **action:** Graceful 'audio unavailable' dialog.

### [1×] InvalidStateError: [DOMException] An operation that depends on state cached in an interface objec
- **status:** ENV · **priority:** ENV · **category:** Storage: transient/cached-state
- **ids:** [981] · **span:** 2026-05-25→2026-05-25 · **builds:** 1 · **browsers:** Chrome/Win
- **assessment:** Transient OPFS / cached interface state.
- **action:** Catch; retry or message.

### [1×] InvalidStateError: [DOMException] Failed to start the audio device
- **status:** ENV · **priority:** ENV · **category:** Audio device init
- **ids:** [704] · **span:** 2026-02-08→2026-02-08 · **builds:** 1 · **browsers:** ?/macOS
- **assessment:** AudioWorkletNode ctor / device start blocked.
- **action:** Graceful 'audio unavailable' dialog.

### [1×] QuotaExceededError: Failed to execute 'truncate' on 'FileSystemSyncAccessHandle': No space availab
- **status:** ENV · **priority:** ENV · **category:** Storage: quota exceeded
- **ids:** [839] · **span:** 2026-03-18→2026-03-18 · **builds:** 1 · **browsers:** Edge/Win
- **assessment:** OPFS quota / no space. User disk full.
- **action:** Catch + 'storage full' dialog; not a crash.

### [1×] TypeError: null is not an object (evaluating 'document.getElementById('btn-comment-mode')
- **status:** ENV · **priority:** ENV · **category:** External: btn-comment-mode click
- **ids:** [957] · **span:** 2026-05-14→2026-05-14 · **builds:** 1 · **browsers:** ?/macOS
- **stack:**
  - `@https://opendaw.studio/:4:46`
  - `global code@https://opendaw.studio/:28:3`
- **assessment:** document.getElementById(...).click null — external/injected script.
- **action:** Confirm not first-party; ignore-list.

### [1×] TypeError: Failed to fetch dynamically imported module: https://opendaw.studio/main/relea
- **status:** ENV · **priority:** ENV · **category:** Network: dynamic import / chunk load
- **ids:** [810] · **span:** 2026-03-14→2026-03-14 · **builds:** 1 · **browsers:** Chrome/macOS
- **assessment:** Stale release / chunk load failure.
- **action:** Reload prompt on chunk-load error.

### [1×] TypeError: network error
- **status:** ENV · **priority:** ENV · **category:** Network: failed to fetch
- **ids:** [624] · **span:** 2026-01-10→2026-01-10 · **builds:** 1 · **browsers:** Edge/Win
- **assessment:** Offline/transient network.
- **action:** Ignore-list transient fetch; offline indicator.

### [1×] UnknownError: [DOMException] The operation failed for an unknown transient reason (e.g. out 
- **status:** ENV · **priority:** ENV · **category:** Storage: transient/cached-state
- **ids:** [870] · **span:** 2026-03-25→2026-03-25 · **builds:** 1 · **browsers:** ?/macOS
- **assessment:** Transient OPFS / cached interface state.
- **action:** Catch; retry or message.

## Strategy — address one by one

**Phase 0 — Reconcile (no code).** Verify on a current build that the RESOLVED group no longer reproduces, then flip `fixed=1` for #982, #667, #738/#740/#745/#748/#758. Clears ~7 reports immediately.

**Phase 1 — Timeline duration family (P1, #933).** Finish what #998 started: `RegionClipResolver.createTasksFromMasks` (line 134) still panics on `duration<=0`. Soften it like `validateTrack`, and pursue the creation-source clamp tracked in the 0-duration origin note. One subsystem, ties off the duration cluster.

**Phase 2 — Mixer 'Unknown key' (P1, 5×).** `Mixer.registerChannelStrip` → `SortedSet.get` miss. Reproduce by adding/removing an audio unit while the mixer is open (or undo/redo of unit creation). Use `getOrNull` + guard. Highest-occurrence open bug, recent, concentrated.

**Phase 3 — Box-graph integrity (P2).** `requires an edge` (#983/#820), `already staged` (#903/#662), `Already assigned` (#915). Reproduce per operation (paste / preset-replace / import / automation-assign / collab). Fix the operation, or validate-and-recover before commit.

**Phase 4 — UI & editor bugs (P2/P3).** Checkbox `.catch` (#815/#816 — quick), Monaco `factory.ts:19` null (#975), Monaco `[object Event]` filtering (#703/#642), `unwrap failed` (#950/#811 — pull stacks first).

**Phase 5 — Resource limits (P3).** Mixdown / offline-render OOM (#291/#302/#70/#71): catch allocation/quota and surface a 'project too large to render' message instead of crashing.

**Phase 6 — Environmental noise (ENV, 27 reports).** Mostly not code bugs. (a) graceful handling + dialogs for storage/audio/network; (b) extend `ErrorHandler` ignore-list / reload-prompt for benign transient cases (same pattern as the #997 'Request timeout' fix). Biggest report-volume reduction for least code.

**Ordering rationale:** Phase 0 is free; 1–2 are the highest-occurrence *real* bugs with concrete leads; 3 is data-model integrity (highest severity if it corrupts projects); 4–5 are smaller real bugs; 6 is noise reduction. One phase per session; mark `fixed=1` as each ships.

---

## Investigation log — 0-duration region origin (#933 / #982 / #998 / #667)

**Status: root cause NOT yet fixed — strong hypothesis, no safe fix shipped (no band-aids).**

The symptom across #933 (`Invalid duration` in `RegionClipResolver.createTasksFromMasks:134`), #982/#998 (`duration must be positive` in `validateTrack`), and #667 is the same: a region reaches `duration === 0` and a post-commit invariant check panics. The validators run *after* the edit commits, so softening them is a band-aid — the real fix is to stop 0-duration regions from being created.

**Ruled out — interactive resize modifiers (all clamp to a positive minimum):**
- `RegionDurationModifier` — floors at `Math.max(Math.min(snap, duration), …)`.
- `RegionLoopDurationModifier` — floors at `Math.min(SemiQuaver, loopDuration)`.
- `RegionStartModifier.computeClampedDelta` — new duration ≥ `min(duration, snap)`.
- `RegionContentStartModifier` — `update()` clamps delta to `duration - SemiQuaver` (`#computeMaxDelta`).
None can turn a positive region into 0; they only preserve an existing 0.

**Strong suspect — the recording path (`packages/studio/core/src/capture/RecordAudio.ts`):**
- `createTakeRegion` (lines 69–78) creates an `AudioRegionBox` **without setting duration/loopDuration** → it starts at the `Float32Field` default until the first live update.
- The live update (lines 270–283) writes `duration.setValue(takeSeconds)` where `takeSeconds = totalSeconds - currentWaveformOffset`. Early in a take, or with a large count-in/latency `currentWaveformOffset`, this is **≤ 0**.
- Recording writes the box field **directly**, bypassing the clamped adapter `set duration`.
- This is a known-fragile area: line 177 comment "fixes #840: short recordings (e.g. count-in) can leave zero-duration regions", with delete-guards on stop (178–191) and loop-take transition (221–225) that evidently don't cover every slip-through.
- Corroboration: #998's session log is full of `createTakeRegion` calls + a `[RecordAudio] abort`, and the offending `d:0` region predated the modifier that surfaced it.

**Why no fix shipped:** the recording timing/latency-compensation logic is delicate; a clamp there could mask the real slip-through or break offset compensation, and the exact escaping branch isn't proven without a reproduction.

**Recommended next step (do before fixing):** reproduce by recording very short / count-in / looped takes and inspecting region duration, **or** add low-noise instrumentation that captures `new Error().stack` only when a non-positive duration is written/persisted (e.g. at `finalizeTake`/the live update, or guarding take regions at finalize). Once the escaping branch is confirmed, fix at that source (refuse to persist a take with `duration ≤ 0`, or clamp `takeSeconds` to a positive minimum at the recording source). Tracked in memory `project-zero-duration-region-origin`.

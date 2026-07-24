# Error Triage Knowledge Base

Living index of production error signatures (from `logs.opendaw.studio`). The `/triage-errors` task reads and
updates this file: it matches each unfixed group from `unfixed.php` against the signatures below, annotates
known ones, and starts a fix when the root cause is known.

Status values: `fixed` · `root-cause-known` (fix designed/started, not yet fully shipped/marked) ·
`investigating` · `parked` (mechanism understood but blocked on a repro / the reporter's project) ·
`environmental` · `unknown`.

Match by the error message (a stable substring); the log ids are just examples of when it was seen.

| Status | Error message (signature) | Root cause | Fix / commit | Notes |
|---|---|---|---|---|
| fixed | `Fullscreen request denied` | Shadertoy canvas `requestFullscreen()` promise rejected (Firefox) with no handler → unhandled rejection | `bd02d1664` (`Promises.tryCatch`) | live id 1028 |
| fixed | `Cannot use 'in' operator to search for '__id__' in null` | Worker `event.data` can be `null`; messenger `Channel` used `"__id__" in data` | `c1a1d6da4` (null-safe guard, drops `in`) | live id 1029 |
| fixed | `Could not remove …/1` (a `<SelectionBox>/1`) | `PointerHub.catchupAndSubscribe` onRemoved unguarded `added.removeByKey`; a selected box deleted while VertexSelection re-subscribes mid-transaction | `473b32ccb` (symmetric `removeByKeyIfExist` guard) | live id 1034; see [[project_boxgraph_incremental_edges]] neighbours |
| fixed | `duration(0) must be positive` | Zero-length audio sample (`numberOfFrames === 0`) → duration-0 audio region → `validateTrack` panic on next edit | `ebe74316b` (import guard) + `859221b85` (sample cleanup) + `ab3824d9f` (project-load migration `migrateZeroDurationRegions`) | live ids 998/1003/1035/1036 |
| fixed | `Pointer …(regions) …/1 requires an edge.` | Clipboard device paste bundles the unit's note tracks+regions; when NOT replacing, `excludeBox` dropped the `TrackBox` but not its regions → dangling mandatory `regions` pointer | `DevicesClipboardHandler` `excludeBox` drops whole timeline subtree (gated on `hasInstrument`) + regression test | live ids 1049–1051 |
| root-cause-known | `No CaptureMidi available` | A unit's capture became `CaptureAudio` (Tape) while note tracks/regions from a prior MIDI instrument remain; `NoteEditor.resolveCapture()` unwraps a `CaptureMidi` and panics. The creation path of that state is still unidentified (legacy / an untraced edit) | Load-migration `migrateCaptureTrackMismatch` deletes capture-mismatched content tracks (cascades regions) — cleanup only, not the creation source | live ids 1040–1048 |
| fixed | `The provided float value is non-finite.` (SVGLength) | `Range.scaleBy` (lib-std `range.ts`) divides by `range = max - min`; a zero-width range → `Infinity`/`NaN` min/max, which `set()` did not sanitize, so `TimelineRangeSlider.tsx:50` set a non-finite `SVGLength.width` and threw. Root: `set()` (the mutator all ops funnel through) did not uphold the minimum-width invariant the min/max setters do | `9dc7dc506` (`set()` upholds the minimum-width invariant + rejects non-finite input) | live id 1037 |
| parked | `regions overlap: prev.complete(…) > next.position(…)` | Clip-mode only (`RegionOverlapResolver.apply` validates just the `clip` behaviour). A `RegionMoveModifier` (deltaPosition -1440, deltaIndex 0) approved a move that left a residual overlap. Sweep (`Region1054OverlapSweep.test.ts`, 7 layouts × regions × 12 deltas) shows single-region moves do NOT reproduce: for every region `validateTrack` checks (note / musical audio; seconds audio is `allowOverlap`-exempt) duration is position-independent so `complete === resolveComplete`, and the resolver's trim target matches the validation. ROOT CAUSE FOUND (2026-07-24): the panics fire on arbitrary edits (incl. a no-op, 1057), so the invalid state PRE-EXISTS the edit — the modifiers only detonate it. The proven creator: `AudioContentFactory.calculateDuration` returned a bpm-less sample's duration in SECONDS as if it were ppqn, so `RegionDragAndDrop.handleSample` built a near-zero clip mask (4 s = "4 ppqn" vs the real tempo-mapped 7680) — the drop left the regions underneath un-clipped, and validateTrack's seconds-exemption (`allowOverlap` checks prev only) hid the stack at drop time. 1080's log shows the exact sequence: file drop, then a loop-duration drag 53 s later → panic, `next.position(0)` = the drop position (the 0/480 signature across occurrences = bar-start drops). A second, still-open creator: `AudioContentModifier.switchTimeBaseToMusical` (StretchSelector) flips the exemption + rewrites duration with no resolver — converting legally-overlapping seconds regions (stacked drops, recorded takes) mints the invalid state silently; fix needs a product call (clip neighbors vs block) | Mask fix: `calculateDuration(sample, tempoMap, position)` converts the bpm-0 extent through the SAME tempo-map math as `TimeBaseConverter.toPPQN`, so mask == region extent by construction + `Region1080DropOverlap.test.ts` (fails pre-fix, green post-fix; 1054 sweep + resolver tests stay green). Diagnostic dump in `validateTrack` (`console.debug`s the full track layout: uuid, TYPE + TIMEBASE, position/duration/complete/loop/mute/mirrored + the offending pair into the shipped `LogBuffer`) confirms remaining creators in production; already-saved corrupted projects still panic until a load-time heal (existing `migrateAudioRegionOverlaps` only absorbs sub-ppqn truncation) | live ids 1054, 1057, 1072, 1078, 1079, 1080 |
| fixed | `No worklet to subscribeDeviceMessage` | `DevicePanel` is bound to `projectProfileService`/`userEditingManager` (not the worklet), so it mounts a scriptable device editor (Apparat) whose ctor calls `subscribeDeviceMessage`. `#listenProject`'s `startAudioWorklet` failure path early-returned leaving the profile installed with `#worklet = None`, violating "profile installed ⇒ worklet present" | `f0a247dd0` (`StudioService.#listenProject` failure path routes the screen to `dashboard` so no worklet-dependent UI mounts) | live ids 1053, 1052 |
| fixed | `no device-host` (touch ghost) | `Surface.#listen()` missing-pointerup workaround fabricated a `pointerup` on the previously-pressed target for ALL pointer types. On touch a tap's up is lost, so the next event dispatched a ghost `pointerup` to the already-removed effect Delete menu item → `deleteEffectDevices` ran a SECOND time on the now-detached adapter → `deviceHost()` panics. Proven via captured logs (double `MenuItem.trigger: Delete '…'`) | `9daf4edd4` (`Surface.tsx` arms the recovery for `pointerType === "mouse"` only; touch/pen deliver reliable up+cancel) | live ids 1039/1038/1020 |
| fixed | `no device-host` (preset-decode) | `PresetService.applyPresetTo` deleted the target effect before `insertEffectChain`, in one transaction. A corrupt preset (`RangeError: Offset is outside the bounds of the DataView`) fails decode, so `insertEffectChain` (validates before mutating) returns a failure without inserting, but the `modify` callback returns normally so the delete commits anyway (modify only rolls back on a throw). The detached effect's follow-up Delete panics | `9910b2e05` (insert first, delete replaced effect only on success; guard `insertEffectChain` header read for truncated presets) | live id 1015 |
| fixed | `{ValueEventBoxAdapter position: … index: …} and {…}` | Collaborative (YSync) merge: two peers each add a value event at the same position, both picking index 0, so the merged doc holds two `ValueEventBox`es at `(position, 0)`. The `(position, index)` uniqueness invariant is not checked at `endTransaction`; it only trips the SortedSet comparator lazily in `asArray`, so the merge commits and crashes later on selection (`onSelected → onEventPropertyChanged → asArray`). `deterministicReconcile` only handled exclusive-target overflow | `b8e3713f7` (add a value-event rule to `deterministicReconcile`: per position first@0/last@1, delete surplus, uuid-tiebroken; mirrors `migrateValueEventCollection` so reconciled + freshly-loaded graphs converge) + `Reconcile.test.ts` | live id 1047 |
| parked | `Cannot access file.` | `AudioRegionBoxAdapter.get file` (line 189) hard-unwraps `#fileAdapter`; the safe `optFile` exists and `RegionRenderer` uses it. `file` is a MANDATORY pointer, so a region resolves its file except in a transient sub-transaction window (file box deleted, region not yet cascade-deleted). A reactive reader using hard `get file` fired in that window. NOT the double-import: `AudioFileBoxFactory.createModifier` re-checks and reuses an existing box (lines 37-45), and both drop paths create region + file atomically, so nothing dangles. Reporter could not reproduce by dropping the same sample twice on a Tape. The failing reader is a lazy-chunk frame not mappable without the sourcemap | — (parked: occ=1, not reproducible from the log; revisit on recurrence or with a resolvable stack) | live id 1021 |
| root-cause-known | `Storage not available` | Two distinct causes, same message (thrown by `OpfsWorker.getOpfsRoot`, OpfsWorker.ts). (1) 1055/1024: `ProjectProfileService.save`/`saveAs` were the only storage flows not wrapped in `tryCatch`, so a mid-session OPFS rejection escaped as an uncaught crash. (2) 1056: the availability gate probes the WRONG runtime — `features.ts:10` + `boot.ts:148` check `navigator.storage.getDirectory()` on the MAIN thread, but every real op runs in the WORKER. Firefox can resolve `getDirectory()` on the window yet reject it in a DedicatedWorker (privacy/persistence config), so boot green-lit a session where the worker could never reach OPFS and the first uncaught worker op crashed (my earlier "evicted after boot" theory was wrong) | 1055/1024: `92936c29a` (wrap both writes; retryable notice, work preserved). 1056: worker-side `OpfsProtocol.isAvailable()` (pings `getOpfsRoot` in the worker) + `boot.ts` gate now awaits `Workers.Opfs.isAvailable()` instead of the main-thread call, so a worker-OPFS-less session shows the "Storage Unavailable" dialog and never starts + `OpfsWorker.test.ts` regression (uncommitted) | RECURRED on post-fix builds via the worker READ path (1067/1075): the boot gate + save-wrapping do not cover raw `read`/`write` calls — see the OPFS caller audit below. live ids 1055, 1024, 1056, 1067, 1075 |
| root-cause-known | `A requested file or directory could not be found` (NotFoundError DOMException) | A `read` of a missing OPFS file. `delete`/`list`/`exists` `tryCatch` internally (no-op / empty / bool), so only `read` throws NotFound; the raw read callers (enumeration loops + load-by-uuid) propagate it. See the OPFS caller audit below | Fix order: group 1 (enumeration skips) first, then load-by-uuid caller-by-caller | live ids 1058, 1059 |
| fixed | `Failed to load because no supported source was found.` | A media element failing to load its source (browser lacking the codec, "no supported source") dispatches a plain `"error"` Event (target = the element), not an `ErrorEvent`/`PromiseRejectionEvent`. `ErrorHandler.#tryIgnore` only filtered ErrorEvent/CSP/Monaco, so it fell through `processError`'s fatal path and was reported as a crash. The underlying media failure is environmental, but reporting it as fatal was a classification bug | `723431ddb` (ignore resource-load errors: a plain `"error"` Event whose `target instanceof HTMLElement`; real JS errors arrive as `ErrorEvent` and are unaffected) | live id 1022 |

## OPFS storage errors — `Storage not available` + `NotFoundError` caller audit (2026-07-24)

Both live errors come from the same `OpfsWorker` layer and share one analysis.

**Already safe by construction.** `delete`, `list`, `exists`, `isAvailable` each `tryCatch` internally: `delete`
no-ops on any failure (incl. NotFound and Storage-not-available), `list` returns `[]` for a missing/unavailable
folder, `exists`/`isAvailable` return a bool. So every delete/list/exists caller (~55 of the 98 call sites) is
already covered — none can crash.

**The only throwing surface.**
- `read` → `NotFoundError` (missing file) or `Storage not available` (getOpfsRoot fails)
- `write` → `Storage not available` only (it creates parents via `{create:true}`, so no NotFound)

So `NotFoundError` is always a `read` of a missing file, and `Storage not available` rides the same read/write
calls. Hardening the reads covers both.

**read callers — guarded (already graceful):** `Recovery.ts:20-26` (inside `tryCatch(Promise.all)` → `None`),
`Storage.ts:21`, `ProjectStorage.ts:40/51/65/67/95`, `TemplateStorage.ts:41/84/86/114`,
`PresetStorage.ts:67/125/139/170`.

**read callers — raw (propagate), all recoverable:**
1. Enumeration reads (one bad entry breaks the whole listing) — the clear bug; fix = skip the unreadable entry
   like `ProjectStorage.listUsedAssets` already does: `ProjectStorage.ts:29`, `TemplateStorage.ts:30`,
   `Storage.ts:36`.
2. Load-by-uuid (missing → surface "not found", not crash): `ProjectStorage.ts:43/47`, `TemplateStorage.ts:44/48`,
   `SampleStorage.ts:53/62/63/64`, `SoundfontStorage.ts:35/37`, `PresetStorage.ts:98`, `NamTone3000.ts:57/71`.
3. Export/bundle (missing referenced file → export fails gracefully): `ProjectBundle.ts:109/110/111/133/134`.
4. Cloud: `SharedFolderSync.ts:383`, `StudioLiveRoomConnect.ts:53/54`.

**Verdict.** None of the raw reads is genuinely unrecoverable — every one has a sane fallback (absent / skip /
failed-load notice). Root-fix order: group 1 (enumeration skips, self-contained and clearly correct), then
groups 2-4 caller-by-caller (each needs a fallback decision: `Option.None` vs a user-facing notice). `write`
throws only Storage-not-available; the save path is wrapped (`92936c29a`), other writes remain raw but only fail
when storage is genuinely gone.

## How to extend

When the task diagnoses a NEW error group:
1. Add a row with `investigating` (or `unknown` if the stack is opaque), the message signature, and what the
   stack/logs reveal.
2. If the root cause is understood, set `root-cause-known`, describe it, and start the fix.
3. On landing a fix, set `fixed` and record the commit(s). Then mark it fixed in the DB (see below).

## Marking fixed in the DB

`unfixed.php` returns rows where `errors.fixed = 0`. There is no write endpoint yet; a group is marked fixed
by setting `fixed = 1` for its ids directly in the DB (the `ids` field of each group lists them). If you want a
one-click flow, add a `fix.php` (POST ids) — not built yet, ask before adding a write endpoint.

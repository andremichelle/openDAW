# Error Triage Knowledge Base

Living index of production error signatures (from `logs.opendaw.studio`). The `/triage-errors` task reads and
updates this file: it matches each unfixed group from `unfixed.php` against the signatures below, annotates
known ones, and starts a fix when the root cause is known.

Status values: `fixed` · `root-cause-known` (fix designed/started, not yet fully shipped/marked) ·
`investigating` · `unknown`.

Match by the error message (a stable substring); the log ids are just examples of when it was seen.

| Status | Error message (signature) | Root cause | Fix / commit | Notes |
|---|---|---|---|---|
| fixed | `Fullscreen request denied` | Shadertoy canvas `requestFullscreen()` promise rejected (Firefox) with no handler → unhandled rejection | `bd02d1664` (`Promises.tryCatch`) | live id 1028 |
| fixed | `Cannot use 'in' operator to search for '__id__' in null` | Worker `event.data` can be `null`; messenger `Channel` used `"__id__" in data` | `c1a1d6da4` (null-safe guard, drops `in`) | live id 1029 |
| fixed | `Could not remove …/1` (a `<SelectionBox>/1`) | `PointerHub.catchupAndSubscribe` onRemoved unguarded `added.removeByKey`; a selected box deleted while VertexSelection re-subscribes mid-transaction | `473b32ccb` (symmetric `removeByKeyIfExist` guard) | live id 1034; see [[project_boxgraph_incremental_edges]] neighbours |
| fixed | `duration(0) must be positive` | Zero-length audio sample (`numberOfFrames === 0`) → duration-0 audio region → `validateTrack` panic on next edit | `ebe74316b` (import guard) + `859221b85` (sample cleanup) + `ab3824d9f` (project-load migration `migrateZeroDurationRegions`) | live ids 998/1003/1035/1036 |
| fixed | `Pointer …(regions) …/1 requires an edge.` | Clipboard device paste bundles the unit's note tracks+regions; when NOT replacing, `excludeBox` dropped the `TrackBox` but not its regions → dangling mandatory `regions` pointer | `DevicesClipboardHandler` `excludeBox` drops whole timeline subtree (gated on `hasInstrument`) + regression test | live ids 1049–1051 |
| root-cause-known | `No CaptureMidi available` | A unit's capture became `CaptureAudio` (Tape) while note tracks/regions from a prior MIDI instrument remain; `NoteEditor.resolveCapture()` unwraps a `CaptureMidi` and panics. The creation path of that state is still unidentified (legacy / an untraced edit) | Load-migration `migrateCaptureTrackMismatch` deletes capture-mismatched content tracks (cascades regions) — cleanup only, not the creation source | live ids 1040–1048 |
| root-cause-known | `The provided float value is non-finite.` (SVGLength) | `Range.scaleBy` (lib-std `range.ts`) divides by `range = max - min`; a zero-width range → `Infinity`/`NaN` min/max, which `set()` does not sanitize, so `TimelineRangeSlider.tsx:50` sets a non-finite `SVGLength.width` and throws | proposed: guard `scaleBy` against `range === 0` + reject non-finite in `set()` | live id 1037 |
| investigating | `regions overlap: prev.complete(…) > next.position(…)` | A region modifier's `approve()` commits overlapping regions that `RegionClipResolver.validateTrack` rejects (sibling of the duration assertion). Which modifier + overlap case is unclear — needs the reporter's project to repro | — | live id 1054; likely `RegionStart`/`RegionMove` modifier vs the clip/overlap resolver |
| fixed | `No worklet to subscribeDeviceMessage` | `DevicePanel` is bound to `projectProfileService`/`userEditingManager` (not the worklet), so it mounts a scriptable device editor (Apparat) whose ctor calls `subscribeDeviceMessage`. `#listenProject`'s `startAudioWorklet` failure path early-returned leaving the profile installed with `#worklet = None`, violating "profile installed ⇒ worklet present" | `f0a247dd0` (`StudioService.#listenProject` failure path routes the screen to `dashboard` so no worklet-dependent UI mounts) | live ids 1053, 1052 |
| fixed | `no device-host` (touch ghost) | `Surface.#listen()` missing-pointerup workaround fabricated a `pointerup` on the previously-pressed target for ALL pointer types. On touch a tap's up is lost, so the next event dispatched a ghost `pointerup` to the already-removed effect Delete menu item → `deleteEffectDevices` ran a SECOND time on the now-detached adapter → `deviceHost()` panics. Proven via captured logs (double `MenuItem.trigger: Delete '…'`) | `9daf4edd4` (`Surface.tsx` arms the recovery for `pointerType === "mouse"` only; touch/pen deliver reliable up+cancel) | live ids 1039/1038/1020 |
| fixed | `no device-host` (preset-decode) | `PresetService.applyPresetTo` deleted the target effect before `insertEffectChain`, in one transaction. A corrupt preset (`RangeError: Offset is outside the bounds of the DataView`) fails decode, so `insertEffectChain` (validates before mutating) returns a failure without inserting, but the `modify` callback returns normally so the delete commits anyway (modify only rolls back on a throw). The detached effect's follow-up Delete panics | `9910b2e05` (insert first, delete replaced effect only on success; guard `insertEffectChain` header read for truncated presets) | live id 1015 |
| investigating | `{ValueEventBoxAdapter position: … index: …} and {…}` | Two value events share the same (position, index) sort key → SortedSet comparator panics in `asArray` (automation editor created/kept duplicate events) | — | live id 1047 |
| investigating | `Cannot access file.` | `AudioRegionBoxAdapter.file` unwraps an empty Option — a region whose `AudioFileBox` didn't resolve (missing sample / load race) | — | live id 1021 |
| environmental | `Storage not available` / `Failed to load because no supported source was found.` | OPFS/storage blocked (private browsing) and an `HTMLMediaElement` with no decodable source — environmental, not a logic bug | (likely no fix; verify stacks) | live ids 1055, 1022 |

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

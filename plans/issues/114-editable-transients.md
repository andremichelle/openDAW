# Allow Transients to Be Moved, Added, Deleted (#114)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — a design doc for this exact issue already exists in-repo with a template implementation to mirror; remaining work is implementation plus two open design decisions
**Type:** feature
**Scope:** small-medium

## What is asked
Automatic transient detection sometimes produces false or misplaced transients. Users need to move, add, and delete transient markers manually.

## Current behaviour / relevant code
There is already an in-repo design document for this exact issue: `packages/app/studio/src/ui/timeline/editors/audio/transient-editing.md` (references `github.com/andremichelle/opendaw/issues/114` directly). It specifies the model, constraints, and two open questions (below). This plan is built on top of it plus direct code inspection.

- Detection: `Workers.Transients.detect(audioData)`, called from `packages/studio/core/src/project/audio/AudioContentModifier.ts:78`; the algorithm itself runs in a worker (`packages/studio/core/src/Workers.ts`).
- Storage: `TransientMarkerBox` (`packages/studio/boxes/src/TransientMarkerBox.ts`, generated from `packages/studio/forge-boxes/src/schema/std/TransientMarkerBox.ts`) — two fields: `owner: PointerField<Pointers.TransientMarkers>` (mandatory) and `position: Float32Field` (`"non-negative"`, unit `"seconds"`). Boxes are owned by `AudioFileBox.transientMarkers` (`AudioFileBoxAdapter.ts:54`), i.e. **shared across every region that references that audio file** — editing one transient affects all regions using that file.
- Adapter: `TransientMarkerBoxAdapter` (`packages/studio/adapters/src/audio/TransientMarkerBoxAdapter.ts`) — `type = "transient-marker"`, exposes `.position`, implements `BoxAdapter, Event` but **not** `Selectable` (no `isSelected`/`onSelected`/`onDeselected`), unlike `WarpMarkerBoxAdapter`.
- Utilities: `TransientMarkerUtils.ts` (`packages/app/studio/src/ui/timeline/editors/audio/`) — `secondsToUnits()` (ppqn↔seconds via warp-marker interpolation) and `createCapturing()` (hit-testing against pointer x-position, `MARKER_RADIUS = 4`, binary-search over both warp markers and transients). No move/add/delete logic yet.
- Rendering: `TransientMarkerEditor.tsx` (same directory).
- Reference implementation to mirror: `WarpMarkerEditing.ts` (`packages/app/studio/src/ui/timeline/editors/audio/`) — a complete `install(project, canvas, range, snapping, reader, audioPlayMode, hoverTransient)` namespace function wiring: `FilteredSelection` over one box type, context-menu delete, double-click delete/add, `Keyboard.isDelete` handler, `Dragging.attach` for move (with min-distance clamping against neighbors and `project.editing.modify(...)`/`.mark()` for undo grouping).

## Plan
Follow the existing design doc's model directly:
1. **Resolve open question 1 (coordinate conversion).** Decide whether transient editing keeps using warp-marker-based ppqn↔seconds conversion (current `TransientMarkerUtils` approach, consistent with how transients are already rendered relative to warp markers) or switches to `project.tempoMap.ppqnToSeconds()`/`secondsToPPQN()`. The doc suggests warp-marker approach for time-stretch mode, TempoMap as fallback — needs a decision given `TransientMarkerBox.position` is stored in raw seconds regardless.
2. **Resolve open question 2 (selection).** Add `Selectable`-style members to `TransientMarkerBoxAdapter` (`isSelected: boolean`, `onSelected()`, `onDeselected()`) mirroring `WarpMarkerBoxAdapter`, to support multi-select and bulk delete.
3. **Create `TransientMarkerEditing.ts`** parallel to `WarpMarkerEditing.ts`, with:
   - `MIN_DISTANCE = 0.050` seconds (per the doc; note this differs in unit from `WarpMarkerEditing.MIN_DISTANCE = PPQN.SemiQuaver` since transients are stored in seconds, not ppqn — the two representations need explicit conversion at the comparison boundary).
   - `FilteredSelection<TransientMarkerBoxAdapter>` scoped to the current `AudioFileBox.transientMarkers` owner, same pattern as `WarpMarkerEditing.ts:43-49`.
   - Context-menu delete + `DebugMenus.debugBox`.
   - Double-click empty space → add (respecting min-distance against neighbors, converting the click's ppqn/x position to seconds via the decision from step 1).
   - Double-click existing marker → delete.
   - `Keyboard.isDelete` → bulk delete selected.
   - `Dragging.attach` → move, clamped between left/right neighbor ± `MIN_DISTANCE`, `project.editing.modify(() => marker.box.position.setValue(clamped), false)` during drag, `project.editing.mark()` on drop (undo grouping, matching `WarpMarkerEditing.ts:157-169`).
4. **Wire into `TransientMarkerEditor.tsx`**, calling `TransientMarkerEditing.install(...)` the same way the warp-marker editor calls `WarpMarkerEditing.install(...)`.
5. **Surface the shared-ownership implication (open question 3)** in the UI if needed — e.g. a confirmation or at least a tooltip noting "this affects all regions using this audio file," since unlike warp markers (per-region via `AudioPlayModeBox`), transients are per-file.

## Risks / open questions
- Shared ownership (`AudioFileBox.transientMarkers`, not per-region) means editing a transient in one region's waveform view changes what every other region referencing that file sees — worth confirming this is the desired UX (vs. per-region overrides), since it's a bigger behavioral difference than the warp-marker analogy suggests.
- Unit mismatch between `MIN_DISTANCE` in `WarpMarkerEditing` (ppqn) and the spec'd 50ms for transients (seconds) means the drag-clamping logic cannot be copy-pasted verbatim; needs its own neighbor-distance check in seconds.
- No mention of undo/redo edge cases when a region's audio file has zero or one transient (min-distance clamping against a nonexistent neighbor) — check `WarpMarkerUtils.findAdjacent`'s handling of missing neighbors (`WarpMarkerEditing.ts:152-156`, `163-164`) transfers cleanly to transients, which (unlike warp markers) have no mandatory anchor markers at start/end.

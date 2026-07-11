# Selecting a MIDI clip should select its track (#289)

**Doability:** ⭐⭐⭐⭐⭐ (5/5) — small, isolated change with an exact existing pattern to mirror in the same file family.
**Type:** ux
**Scope:** small

## What is asked
Clicking a clip (MIDI or otherwise) in the clip launcher should also select the track/audio-unit that owns it, so the device panel switches to that track — matching what already happens when clicking a track header.

## Current behaviour / relevant code
Two independent "current selection" concepts exist:
- `project.timelineFocus` (`packages/studio/core/src/ui/timeline/TimelineFocus.ts`) — tracks focused track/region, used for copy/paste anchoring. Already wired into region clicks: `RegionsArea.tsx:116-131` calls `timelineFocus.focusRegion(target.region)` / `timelineFocus.focusTrack(target.track.trackBoxAdapter)` on `pointerdown`.
- `project.userEditingManager.audioUnit` — the observable that actually drives which track's devices the Device Panel shows (`DevicePanel.tsx:106,202,215`). This is what needs to change for the device panel to switch.

`TrackHeader.tsx:100-104` sets both on header click:
```typescript
Events.subscribe(element, "pointerdown", () => {
    project.timelineFocus.focusTrack(trackBoxAdapter)
    if (!audioUnitEditing.isEditing(audioUnitBoxAdapter.box.editing)) {
        audioUnitEditing.edit(audioUnitBoxAdapter.box.editing)
    }
}),
```
where `audioUnitEditing = project.userEditingManager.audioUnit`.

By contrast, the clip click handler in `packages/app/studio/src/ui/timeline/tracks/audio-unit/clips/ClipsArea.tsx:134-142` only opens the content editor:
```typescript
Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
    const target = capturing.captureEvent(event)
    if (target === null || target.type !== "clip") {return}
    if (!service.panelLayout.getByType(PanelType.ContentEditor).isVisible) {return}
    userEditingManager.timeline.editIfDifferent(target.clip.box)
}),
```
It never touches `timelineFocus` or `userEditingManager.audioUnit`, so selecting a clip does not change the focused track or the Device Panel's target — exactly the reported gap. (Region clicks already do the `timelineFocus` half via `RegionsArea.tsx`, but even those don't touch `userEditingManager.audioUnit` — so the same fix benefits region clicks too, though only clips were reported.)

## Plan
1. In `ClipsArea.tsx`'s `pointerdown` handler, when `target.type === "clip"`, resolve the owning track's `trackBoxAdapter` (available as `target.track.trackBoxAdapter`, used elsewhere in the same file, e.g. line 101) and:
   - call `project.timelineFocus.focusTrack(target.track.trackBoxAdapter)` (mirrors `TrackHeader.tsx:101` and `RegionsArea.tsx:130`), and
   - call `userEditingManager.audioUnit.edit(target.track.trackBoxAdapter.audioUnitBoxAdapter.box.editing)` guarded by `!audioUnitEditing.isEditing(...)` exactly like `TrackHeader.tsx:102-104`, to switch the Device Panel.
2. Confirm `ClipsArea.tsx` already destructures `userEditingManager` (it does, line 47) — the audioUnit-editing call just needs adding alongside the existing `userEditingManager.timeline` usage.
3. Decide whether to fold this into `RegionsArea.tsx` too (selecting a region has the same gap) — the issue only mentions clips, but the fix is identical and the code sits right next to the existing `timelineFocus.focusRegion` call at `RegionsArea.tsx:121`. Recommend doing both in the same change for consistency, unless the maintainer wants clip and region behaviour to diverge.
4. No box-graph/engine changes needed — this is pure UI state wiring.

## Risks / open questions
- Switching the Device Panel on every clip click could feel disruptive if a user is clicking through many clips on the *same* track for playback/preview reasons rather than editing — the existing `TrackHeader.tsx` guard (`!audioUnitEditing.isEditing(...)`) already avoids redundant `edit()` calls when it's already the same unit, which should keep this cheap, but a UX read-through after implementation is worth doing.
- Whether to extend the same fix to `RegionsArea.tsx` (not explicitly requested) is a scope decision, not a technical risk.

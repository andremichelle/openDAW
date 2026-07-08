# Automation clip deletion bug (#292)

**Doability:** ⭐⭐☆☆☆ (2/5) — the obvious code path already looks correct; the actual trigger needs a live repro.
**Type:** bug, ux
**Scope:** small (once root cause confirmed)

## What is asked
Right-clicking an automation (value) clip to delete it sometimes shows the wrong context menu / wrong selection; a second click is needed to get "correct context."

## Current behaviour / relevant code
Clip right-click menu: `packages/app/studio/src/ui/timeline/tracks/audio-unit/clips/ClipContextMenu.ts:19-31`:

```ts
export const installClipContextMenu = ({element, project, selection, capturing}: Creation) =>
    ContextMenu.subscribe(element, collector => {
        const target = capturing.captureEvent(client)
        ...
        } else if (target.type === "clip") {
            const {clip} = target
            if (!selection.isSelected(clip)) {
                selection.deselectAll()
                selection.select(clip)
            }
            ...
            MenuItem.default({label: "Delete"})
                .setTriggerProcedure(() => editing.modify(() => selection.selected().forEach(clip => clip.box.delete())))
```

This already selects the right-clicked clip *before* building the menu, synchronously, in the same callback — so `Delete` should act on the correct clip on the first right-click. The equivalent region-level menu (`packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionContextMenu.ts:45-56`) follows the identical pattern. Neither shows an obvious bug from static reading.

Two structural details worth investigating live, since they're the only asymmetries found:
1. **Context menu event model is a global synthetic-event bubble.** `packages/studio/core/src/ui/clipboard/ContextMenu.ts:51-75`: a single native `contextmenu` listener (`install`, capture-phase, window-level) re-dispatches a synthetic `--context-menu` event from `mouseEvent.target`, which *bubbles*. Every ancestor with `ContextMenu.subscribe` registered (clips area, region area, panel chrome, etc.) gets a chance to append menu items via `collector.appendToChain(...)`. If some ancestor's `capturing.captureEvent(client)` returns a stale/`null` target on the first click (e.g. due to a layout not yet reflowed after a prior selection change) and only resolves correctly after the DOM settles, that would produce exactly a "click twice" symptom without the per-file code being wrong in isolation.
2. **`ClipsArea.tsx:134-142`** has a separate `pointerdown` handler that calls `userEditingManager.timeline.editIfDifferent(target.clip.box)` when the ContentEditor panel is open, for *any* pointer button (not gated on `event.button`). A right-click's `pointerdown` fires this before the browser's native `contextmenu` event — if the "currently edited" clip and "currently selected" clip can disagree for a frame, and something downstream keys off the edited clip instead of the selection, a first right-click could act on the previous edit target.

## Plan
1. Reproduce with an automation (value) clip specifically (not audio/note clips) to confirm whether the bug is clip-type-specific or general to `ClipContextMenu.ts`.
2. Instrument `capturing.captureEvent(client)` in `ClipContextMenu.ts:22` and the selection state at menu-build time on both the first and second right-click of a repro sequence, to see whether the *target* or the *selection* differs between clicks.
3. If it's the bubble-order issue: audit all `ContextMenu.subscribe` registrations on ancestors of the clips/regions area for one that returns non-null for a target it shouldn't handle, or that mutates shared state before the correct handler runs.
4. If it's the `pointerdown`/`editIfDifferent` race: gate that handler on `event.button === 0` (left click only) so a right-click never changes the edit target before the context menu builds.

## Risks / open questions
- Without a confirmed repro this is speculative; per "repro or test first," do not ship a fix before reproducing and instrumenting per step 2.
- If reproducible only for automation clips and not audio/note clips, look for automation-clip-specific state (e.g. `ParameterValueEditing`'s assignment lifecycle, `packages/app/studio/src/ui/timeline/editors/value/ParameterValueEditing.ts:35-51`) that could be one tick behind the clip selection.

# Clip view issues (#185)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — both root causes are pinned to exact lines; fixes are bound-checking, not architectural.
**Type:** ux
**Scope:** small

## What is asked
1. Clips can be dragged into a column that is not currently visible ("shadowed space") and become unreachable until the clip view is widened or the move is undone.
2. The clip-view width (number of visible clip columns) can be dragged out to more than the browser's width, pushing the arrangement/track view off-screen.

## Current behaviour / relevant code
The clip launcher's column count is a single observable, `timeline.clips.count`, rendered via a CSS grid variable in `packages/app/studio/src/ui/timeline/Timeline.tsx:76`:
```
clips.count.catchupAndSubscribe(owner => element.style.setProperty("--clips-count", String(owner.getValue())))
```
and consumed unconditionally in `packages/app/studio/src/ui/timeline/Timeline.sass:18`:
```
grid-template-columns: var(--timeline-header-width) repeat(var(--clips-count), var(--clips-width)) 1fr
```
There is no upper bound on `--clips-count`, so the grid can grow arbitrarily wide.

**Issue 2 root cause** — the resizer drag handler in `packages/app/studio/src/ui/timeline/tracks/audio-unit/clips/ClipsHeader.tsx:94-105`:
```typescript
Dragging.attach(resizer, ({clientX: beginPosition}) => {
    const beginValue = clips.count.getValue()
    const cellSize = parseInt(window.getComputedStyle(element).getPropertyValue("--clips-width")) + 1
    return Option.wrap({
        update: ({clientX: newPosition}) => {
            const newValue = Math.max(0, beginValue + Math.round((newPosition - beginPosition) / cellSize))
            clips.count.setValue(Math.max(1, newValue))
            clips.visible.setValue(newValue > 0)
        },
        cancel: () => {}
    })
})
```
`newValue` is floored at 1 but never capped, so dragging far to the right sets `clips.count` to an arbitrarily large number, and the grid literally exceeds the viewport (matches the report exactly: "more than the whole browser width").

**Issue 1 root cause** — the visible column count (`clips.count`) and the maximum index a clip may be dragged to are two independent values. `packages/app/studio/src/ui/timeline/tracks/audio-unit/TracksManager.ts:54`:
```typescript
this.#maxClipsIndex = this.#terminator.own(new DefaultObservableValue(8))
```
a hardcoded constant, exposed via the `maxClipsIndex` getter (line 110) and consumed by `ClipMoveModifier.ts:90-91`:
```typescript
const listIndex = adapter.indexField.getValue()
return clamp(delta, -listIndex, this.#manager.maxClipsIndex.getValue() + 1)
```
So a clip can be dragged to any index up to 8 regardless of how many columns `clips.count` is currently showing (which defaults to 3, per `StudioService.ts:523-526`). If a user drags a clip to index 5 while only 3 columns are visible, the clip lands in a column with no rendered header/lane (`ClipsHeader.tsx` only builds cells up to `clips.count.getValue()`, lines 32-33) — it becomes invisible and, per the report, unreachable until the clip view is widened.

## Plan
1. **Issue 2 (unbounded width):** clamp `newValue` in `ClipsHeader.tsx`'s resizer `update` to a sane maximum, either a fixed constant or one derived from the current viewport width (`Math.floor(viewportWidth / cellSize)` minus room for the header/track columns). Simplest fix mirrors the existing `Math.max(1, newValue)` pattern: `Math.min(newValue, MaxVisibleClipsColumns)`.
2. **Issue 1 (unreachable clips):** remove the independent `#maxClipsIndex` constant in `TracksManager.ts` and derive the clip-move clamp from `clips.count` directly (i.e. `ClipMoveModifier.ts:91` should clamp to `clips.count.getValue()` or `clips.count.getValue() - 1`, whichever matches "last valid column"), OR keep a generous drag ceiling but auto-grow `clips.count` when a clip is dropped past the current visible range (mirroring how `StudioService.ts:523` already computes `Math.max(maxClipIndex + 1, 3)` at project load — the same formula could run on drop).
3. Prefer option 2's auto-grow behaviour for issue 1 since it matches the load-time precedent in `StudioService.ts` and avoids ever creating an unreachable clip in the first place; the alternative (hard-clamping the drag) would silently refuse to place clips where the user drags them.
4. After the fix, verify: dragging a clip to column 8 with `clips.count` at 3 either (a) is disallowed and clamped to column 2, or (b) grows `clips.count` to 9 — pick (b) per the plan above, then re-check the resizer's new max doesn't fight with this auto-grow.

## Risks / open questions
- No existing constant defines a sane maximum for "more than the whole browser width" — needs a concrete number or a viewport-relative computation; check for a design-system convention (e.g. minimum reasonable clip-cell width) before hardcoding.
- `#maxClipsIndex` may be intentionally decoupled from `clips.count` for some other reason (e.g. allowing programmatic clip placement beyond the visible grid via automation/import) — grep for other readers of `maxClipsIndex` before deleting it; only `ClipMoveModifier.ts` was found as a consumer during this pass, but a wider search is warranted before removing the field.

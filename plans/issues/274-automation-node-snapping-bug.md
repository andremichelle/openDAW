# Automation node placement bug (#274)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — root cause found: node creation never consults the grid at all.
**Type:** bug
**Scope:** small

## What is asked
Placing an automation node sometimes fails to snap to the timeline grid, per the reporter's video/project repro.

## Current behaviour / relevant code
Double-click node creation in `packages/app/studio/src/ui/timeline/editors/value/ValueEditor.tsx:120-131`:

```ts
const rect = canvas.getBoundingClientRect()
const position = Math.round(range.xToUnit(event.clientX - rect.left) - reader.offset)
```

This rounds to the nearest integer **pulse** (1 ppqn tick), completely bypassing the `Snapping` service (`packages/app/studio/src/ui/timeline/Snapping.ts`) that governs the visible grid and every other creation path in the timeline.

Compare with note creation, which does consult snapping:
- `packages/app/studio/src/ui/timeline/editors/notes/NoteCreateModifier.ts:58` — `const position = this.#snapping.floor(pointerPulse)`
- `packages/app/studio/src/ui/timeline/editors/notes/NoteEditor.tsx:66` — `const position = snapping.floor(engine.position.getValue())`

The value editor's `ValuePainter.ts:49` calls `renderTimeGrid(context, ..., range, snapping, ...)` to *draw* the grid using the current `Snapping` unit, but the creation code at `ValueEditor.tsx:122` never calls `snapping.floor/round/ceil`. So whenever the snap unit is coarser than "Off" (e.g. "Bar", "1/4"), a double-click visually lands between grid lines — this reads as "snapping fails" because the user expects the drawn grid to constrain placement the way it does for notes/regions.

Node *dragging* (post-creation) does snap correctly via `Snapping.computeDelta` in `packages/app/studio/src/ui/timeline/editors/value/ValueMoveModifier.ts:106,155`, which is why the bug looks intermittent rather than universal — only the initial placement is unsnapped.

## Plan
1. In `ValueEditor.tsx`'s dblclick handler, replace the raw rounding with the same `Snapping` API used elsewhere:
   ```ts
   const position = snapping.xToUnitRound(event.clientX - rect.left) - reader.offset
   ```
   (or `xToUnitFloor`, matching whatever convention `NoteCreateModifier` uses — floor, to be consistent with note creation).
2. Confirm `snapping` is already in scope in `ValueEditor` (it's a constructor param, `Construct.snapping: Snapping`, already passed into `createValuePainter`) — no new plumbing needed.
3. Manually verify against the reporter's project file/video once available, to confirm the specific repro scenario is this exact code path and not a separate issue (e.g. loop-region offset interacting with `reader.offset`).

## Risks / open questions
- This bug and #275 (desired placement behaviour) share the same code path — fixing this makes #275 point 2 ("place on the grid unless holding a shortcut") straightforward to layer on top; consider implementing them together.
- Need the reporter's repro project to confirm no second contributing cause (e.g. `reader.offset` for looped content, or a stale `TimelineRange` during zoom).

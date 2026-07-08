# Automation node placement behaviour (#275)

**Doability:** ⭐⭐⭐☆☆ (3/5) — builds directly on #274's finding, but adds new interaction rules that need UX decisions.
**Type:** bug, ux
**Scope:** medium

## What is asked
Four concrete UX rules for placing automation nodes:
1. Double-click to place a node (already the current behaviour).
2. Placed on the grid by default; a shortcut disables snapping.
3. If placing at the same time-position as an existing node, which of the (up to two) stacked events gets updated should depend on the mouse cursor's Y position (illustrated in the issue as white/red scenarios).
4. A third click at the same position overwrites the node with the same rule as (3).

## Current behaviour / relevant code
**Point 1** — already implemented: `packages/app/studio/src/ui/timeline/editors/value/ValueEditor.tsx:111-152`, dblclick creates via `ValueEventEditing.createOrMoveEvent`.

**Point 2** — currently false: creation ignores `Snapping` entirely (see `plans/issues/274-automation-node-snapping-bug.md`). Fixing #274 gives grid-snap-by-default. The "hold shortcut to disable" part is new: today, no modifier key disables *time*-grid snapping anywhere in the value editor. The existing convention (`ValueEditorHeader.tsx:26`) is:
   - `Shift` disables **value** snapping (`ValueMoveModifier.ts:136`, `shiftKey ? null : ...`)
   - `Opt`/Alt constrains movement to time-only (freeze mode, `ValueMoveModifier.ts:131,146`, `altKey: freezeMode`)

   No key currently touches time-grid snapping (because it isn't applied at all). A new modifier convention is needed for "disable grid snap at creation" — reusing `Shift` for both axes is possible but conflicts with its existing value-snap meaning; consider a distinct key (e.g. `Ctrl`, mirroring `NoteDurationModifier.ts:90` which uses `ctrlKey` for alignment).

**Points 3 & 4** — the two-event-stack logic lives in `ValueEventEditing.createOrMoveEvent`, `packages/app/studio/src/ui/timeline/editors/value/ValueEventEditing.ts:25-46`:

```ts
export const createOrMoveEvent = (collection, position, value, interpolation) => {
    const le = collection.events.lowerEqual(position)
    const ge = collection.events.greaterEqual(position)
    if (null === le || null === ge) { return collection.createEvent({position, index: 0, ...}) }
    else if (le === ge) {
        if (le.index === 0) { return collection.createEvent({position, index: 1, ...}) }  // add the "landing" value
        else { le.box.value.setValue(value); return le }                                   // update index 1
    } else if (le.position === ge.position) {                                               // two events already stacked
        le.box.value.setValue(value)                                                        // always updates index 1 (le)
        return le
    } else { return collection.createEvent({position, index: 0, ...}) }
}
```

When two events already share a position (a step: index 0 = value-before, index 1 = value-after), a third click at that position **always** updates index 1 (`le`), regardless of where the user clicked vertically. This doesn't implement "closer to cursor" semantics — it's a fixed rule, not cursor-driven. This is the concrete gap for points 3 and 4.

## Plan
1. Land the #274 fix first (grid-snap on creation via `Snapping`).
2. Add a modifier-key check in the dblclick handler (`ValueEditor.tsx:119`, currently `if (dblclck && !event.shiftKey)`) to skip snapping when the chosen key is held — thread it into the `Snapping.value`/`floor` call from point 2's fix.
3. Extend `ValueEventEditing.createOrMoveEvent` to accept the clicked Y value (already computed as `clickValue`/`value` in the caller) and, in the two-index-stack branch (`le.position === ge.position`), pick whichever of the two existing events (`le` index 1, or its sibling index 0 — fetch via `ValueEvent.iterateWindow` or a direct lookup by `(position, index)`) is closer in value to the click, updating that one instead of hard-coding index 1.
4. Confirm the exact desired mapping (which node is "white" vs "red" in the issue's screenshots) against the reporter's illustration before finalizing which index wins ties — this determines the exact comparison direction.

## Risks / open questions
- Which modifier key to standardize on for "disable grid snap" is a UX decision — recommend confirming with the reporter/maintainer before implementation, since it interacts with existing `Shift`/`Alt` conventions.
- Need the issue's illustration (white/red scenarios) to pin the exact cursor-to-index mapping; implementing from written description alone risks a wrong tie-break direction.
- `createOrMoveEvent`'s only current caller is the dblclick handler in `ValueEditor.tsx:130` — low blast radius for a signature change, but re-check before landing in case new call sites appear.

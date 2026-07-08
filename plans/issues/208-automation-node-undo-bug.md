# Automation node undo bug (#208)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — root cause identified precisely, fix is localized to one interaction path.
**Type:** bug
**Scope:** small

## What is asked
Creating an automation node (double-click in the value/automation editor) requires pressing Ctrl+Z twice to fully undo. One press should remove the newly created node.

## Current behaviour / relevant code
Double-click node creation lives in `packages/app/studio/src/ui/timeline/editors/value/ValueEditor.tsx:111-152`. On a double-click that misses an existing target:

```ts
return editing.modify(() =>
    ValueEventEditing.createOrMoveEvent(reader.content, position, value, ...), false)   // mark = false
    .match({
        some: adapter => {
            selection.select(adapter)
            return modifyContext.startModifier(ValueMoveModifier.create({ ... }))        // starts a drag session
        }
    })
```

The creation call uses `editing.modify(fn, false)` — `mark = false` (`packages/lib/box/src/editing.ts:142-173`). This pushes the new event into `#pending` but does **not** flush it into `#marked` (the undo stack). It stays pending.

The same pointer gesture immediately starts a `ValueMoveModifier` (`packages/app/studio/src/ui/timeline/editors/value/ValueMoveModifier.ts`). On pointer-up, `approve()` (line 180-253) only skips the edit when the computed delta is *exactly* zero:

```ts
approve(): void {
    if (this.#deltaValue === 0 && this.#deltaPosition === 0) { ... return }
    ...
    this.#editing.modify(() => { ... })   // line 219, mark defaults to true
}
```

`update()` (line 130-178) recomputes `deltaPosition`/`deltaValue` from raw, unrounded pointer coordinates (`this.#pointerPulse`, `this.#pointerValue`), while the just-created event's reference position/value were rounded/quantized at creation time (`ValueEditor.tsx:122-128`, `Math.round(...)`, `context.quantize(...)`). Any sub-pixel mismatch between the raw click coordinates and the rounded stored values — which happens for most clicks, not just ones with visible mouse movement — produces a small nonzero delta. `approve()` then calls `editing.modify(fn)` with the default `mark = true`.

Per `BoxEditing.modify` (`packages/lib/box/src/editing.ts:142-173`): a call with `mark = true` first flushes any existing `#pending` into its own `#marked` entry (`if (mark && this.#pending.length > 0) { this.mark() }`), *then* runs its own modifier and marks that as a second entry. Net effect: the pending "create" from the dblclick and the "move" from `approve()` become **two separate undo steps** instead of one, even though the user experienced a single gesture.

## Plan
1. In `ValueMoveModifier.approve()`, when the modifier was started as part of a create (i.e. the reference event was just created in the same gesture and no real drag occurred), commit through the same unmarked transaction instead of a fresh marked one. Two viable approaches:
   - Pass `mark = false` into the `editing.modify(...)` call at `ValueMoveModifier.ts:219` when invoked from the dblclick-create path, and rely on the *next* `mark = true` modify (or an explicit `editing.mark()`) to close the compound step. Requires plumbing a flag through `Construct`.
   - Simpler: in `ValueEditor.tsx`'s dblclick handler, don't start `ValueMoveModifier` on the same pointer-down that created the event unless the user actually drags past a small threshold before starting to track deltas — i.e., defer `startModifier` until the first real `update()` shows nonzero delta, otherwise treat the click as a plain placement with no chained modifier.
2. Regardless of approach, verify the root numeric mismatch: use the same rounding function for `pointerPulse`/`pointerValue` passed into `ValueMoveModifier.create(...)` (`ValueEditor.tsx:143-148`) as was used to create the event (`position`/`value` computed at `ValueEditor.tsx:122-128`), so a non-dragged double-click naturally yields `deltaPosition === 0 && deltaValue === 0` and `approve()` already no-ops correctly.
3. Add a regression test exercising `BoxEditing`/`ValueEventEditing.createOrMoveEvent` + `ValueMoveModifier.approve()` sequence to assert a single `undo()` call fully removes the created event.

## Risks / open questions
- Need to confirm which of the two mismatches (position rounding vs value quantization) is the actual trigger in practice — add a temporary log of `deltaPosition`/`deltaValue` in `approve()` during manual repro before picking the fix.
- The fix must not break real click-and-drag placement (drag to a different value/position immediately after creating), which should legitimately remain two conceptually-merged actions but can still be a single undo step if merged into one `Modification`.
- TS-only change; no engine/WASM implication (this is graph-history bookkeeping, not audio-affecting).

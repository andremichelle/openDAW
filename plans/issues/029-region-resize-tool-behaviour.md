# Region Resize Tool Behaviour (#29)

**Doability:** ⭐⭐⭐☆☆ (3/5) — three unrelated sub-bugs bundled in one report; two have a located mechanism, one needs a repro session before a fix can be scoped.
**Type:** bug
**Scope:** medium

## What is asked
Three separate clip/region editing complaints:
1. Drag-copying a region (Ctrl+drag) over another region makes the dragged copy render short.
2. Resizing a region's total duration so it overlaps a following region stops the resize-drag visual feedback at the following region's start, even though the drag itself should be allowed to continue.
3. Resizing a looping region's loop-length handle ("from the bottom") also shifts the end of the first loop iteration, which the reporter finds surprising/unwanted.

## Current behaviour / relevant code

Region resize/move is split across three modifiers in `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/`:
- `RegionDurationModifier.ts` — drag on the `"complete"` hit-target, changes only `region.duration` (total span), never touches `loopDuration`/`loopOffset` (`approve()` at line 108-140).
- `RegionLoopDurationModifier.ts` — drag on `"loop-duration"`/`"content-complete"` hit-targets (wired in `RegionsArea.tsx:288-294`). Its `SelectedModifyStrategy.readComplete()` (lines 23-34) computes:
   ```
   const newLoopDuration = this.readLoopDuration(region)
   const duration = newLoopDuration <= region.loopDuration ? region.duration
       : Math.max(region.duration, newLoopDuration - region.loopOffset)
   ```
   Shrinking the loop handle leaves `region.duration` (total span) alone, but the *loop cycle length itself* is exactly what's being dragged, so the first loop's end point necessarily moves — the same handle conflates "change loop length" with "the annoying side effect" the reporter describes.
- `RegionMoveModifier.ts` — handles move + Ctrl-drag copy. `showOrigin()` (line 106) returns `this.#copy`, which controls whether the pass-1 render in `RegionRenderer.ts` also draws the un-moved original as a ghost.

Rendering for all three cases funnels through `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionRenderer.ts:61-183`. Two passes run per row: `renderRegions(strategy.unselectedModifyStrategy(), true, !strategy.showOrigin())` then `renderRegions(strategy.selectedModifyStrategy(), false, false)` (lines 181-182). Inside `renderRegions` (line 61-76):
```
const complete = region.isSelected
    ? actualComplete
    : Math.min(actualComplete, next?.position ?? Number.POSITIVE_INFINITY)
```
Only *non-selected* regions get clamped to the next region's start; the dragged/selected region's `complete` is never clamped by this code path. That means item 2 ("resize stops drawing beyond the second clip") is not explained by this clamp and needs to be confirmed against `RegionDurationModifier`'s own bound handling (`this.#bounds` is fixed at drag-start from `[reference.position, reference.complete]`, `RegionsArea.tsx:280`, and is never extended past whatever the pointer reports — worth checking whether `Snapping.computeDelta` or the hit-region's own width clips the drag before it reaches the modifier).

For item 1, the exact place where the dragged copy visually shortens is not yet pinned down: neither `RegionMoveModifier`'s `SelectedModifyStrategy.readComplete()` (`RegionMoveModifier.ts:17`, uses `region.resolveComplete(...)`, unclamped) nor the render pass's ternary explain a truncation for a selected region. `RegionClipResolver` (`packages/studio/core/src/ui/timeline/RegionClipResolver.ts`) only runs in `approve()` via `overlapResolver.apply`, not during the live drag, so the live overlap-clip logic is not the cause either. This needs a browser repro to capture which code path actually shortens the rendered preview.

## Plan
1. **Item 3 (loop handle side effect)** — this is arguably correct-but-confusing behaviour rather than a bug: dragging the loop-length marker changes the loop length, so the first loop's boundary moving is expected. Options to resolve as a UX fix:
   - Add a distinct modifier-key variant (e.g. hold Alt while dragging the loop handle) that resizes total duration by whole-loop increments without touching `loopDuration`, or
   - Split the visual affordance so the loop-length handle sits clearly separate from the total-duration handle (currently both are edge-adjacent, `RegionsArea.tsx:274-294`).
   This needs a maintainer decision on the intended affordance before implementation; flag as open question.
2. **Item 2 (resize stops drawing past overlap)** — instrument `RegionDurationModifier.update()` (line 92-106) and `Snapping.computeDelta` with a repro (drag a region's end handle across a following region) to find where the delta gets capped. Once found, the visual preview should track the pointer freely; only `approve()` (via `RegionOverlapResolver.apply` → `RegionClipResolver`) should decide the final clip/truncate outcome.
3. **Item 1 (short-looking copy)** — reproduce with two regions on the same track, Ctrl-drag one on top of the other, and log `actualComplete`/`complete` per frame in `RegionRenderer.ts:69-76` plus the values from `RegionMoveModifier.SelectedModifyStrategy.readComplete()`. Confirm whether the shortening is a canvas draw-order artifact (unlikely, selected pass draws after unselected, `RegionRenderer.ts:181-182`) or a real position/duration miscalculation in the copy path (`RegionMoveModifier.approve()` calls `original.copyTo(...)`, line 169-173 — verify `consolidate: original.isMirrowed === this.#mirroredCopy` doesn't affect duration under a Ctrl-drag with an unrelated overlap).
4. Add regression tests once root causes are confirmed: a `RegionClipResolver`-level test for item 2/3 (duration math), and a manual browser repro checklist for item 1 (canvas-based, hard to unit test) with a documented expected-vs-actual per frame.

## Risks / open questions
- Item 1 has no confirmed root cause yet — do not attempt a fix without a repro session; the render code inspected does not show an obvious clamp for selected/dragged regions.
- Item 3's fix depends on a design decision (new modifier key vs. redesigned handle hit-zones) that should go back to the maintainer before coding.
- All three items touch `RegionOverlapResolver`/`RegionClipResolver`, which is WASM/TS-parity-relevant only indirectly (these are pure UI/editing-time classes, not engine runtime), but any behavioural change to duration/loop math should be re-verified against `RegionClipResolver.test.ts` and `RegionClipResolver.producer.test.ts`.

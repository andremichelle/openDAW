# Visual bug with automation node curves (#291)

**Doability:** ⭐⭐☆☆☆ (2/5) — plausible mechanism identified, but needs a live repro to confirm before fixing.
**Type:** bug
**Scope:** small (once root cause confirmed)

## What is asked
Curve-interpolated automation segments render incorrectly when they reach -100% (the bottom of a bipolar parameter's range, e.g. panning).

## Current behaviour / relevant code
Curve segments are drawn in `packages/studio/core/src/ui/renderer/value.ts:59-79`:

```ts
} else if (type === "curve") {
    const cx0 = Math.max(x0, xMin)
    const cx1 = Math.min(x1, xMax)
    const definition: Curve.Definition = {slope: interpolation.slope, steps: x1 - x0, y0, y1}
    ...
    const {m, q} = Curve.coefficients(definition)
    let value = Curve.valueAt(definition, cx0 - x0)
    for (let x = cx0; x <= cx1; x++) {
        path.lineTo(x, value)
        value = m * value + q      // per-pixel recurrence, not re-evaluated from the closed form
    }
    path.lineTo(cx1, Curve.valueAt(definition, cx1 - x0))
}
```

Two details stand out as candidate causes:
1. `y0`/`y1` here are already **pixel** Y-coordinates (`valueToY(v0)`/`valueToY(v1)` passed in from `ValuePainter.ts:106-118`), not raw 0-1 stored values — the curve shape (`Curve.normalizedAt`, `packages/lib/std/src/curve.ts:26-33`) is applied directly in pixel space. For a linear/affine `eventMapping` (true for both unipolar and bipolar automatable params, per the value-editor's own `readme.md`) this is mathematically equivalent to applying it in value space, so it's likely *not* the bug by itself — but it means any per-pixel numerical error is also visually amplified across the full canvas height rather than a normalized 0-1 range.
2. The `for (let x = cx0; x <= cx1; x++) { value = m * value + q }` loop is a recursive (IIR-style) approximation of the exponential curve, iterated once per **pixel** of segment width (from the referenced paper, `curve.ts:4-6`). This recurrence is a known numerically efficient but drift-prone technique for extreme `slope` values (`m` can exceed 1), especially over long pixel runs — errors compound multiplicatively. A segment ending exactly at the bipolar minimum (raw value 0.0 == "-100%") is a natural place for this drift to become visible, since it's the extreme edge of the curve's dynamic range.

Neither theory is confirmed without seeing the actual glitch (banding, overshoot past the canvas edge, a flat clip, or a sudden jump are all consistent with slightly different root causes).

## Plan
1. Reproduce with a bipolar automatable parameter (e.g. panning) with a curved segment ending at the minimum value, at a few different `slope` values and zoom levels, and capture what specifically breaks (screenshot/video).
2. If the glitch is drift/overshoot along the curve: replace the per-pixel recurrence with periodic re-evaluation via `Curve.valueAt(definition, x - x0)` (the closed form, already used at segment boundaries) at some interval, or clamp each stepped `value` to `[min(y0,y1), max(y0,y1)]` before drawing.
3. If the glitch is at the canvas edge specifically: check `RangePadding` (`packages/app/studio/src/ui/timeline/editors/value/Constants.ts`) and `valueAxis.valueToAxis` (`ValueEditor.tsx:76-81`) for off-by-one/clamping issues when `eventMapping.x(value)` hits exactly 0.0 or 1.0.
4. Add a rendering regression check (visual snapshot or coordinate assertion) for a curve segment ending at each extreme (0.0 and 1.0 raw value) once the fix is identified.

## Risks / open questions
- Per "repro or test first" — this plan intentionally stops short of prescribing a fix; the exact glitch shape needs to be observed before commit to which of the two theories (or a third) is correct.
- If it's the recurrence-drift theory, a fix trades some render performance (more `Math.pow` calls) for correctness — need to check this doesn't regress paint performance on curve-heavy tracks.

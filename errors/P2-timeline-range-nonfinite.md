# TimelineRangeSlider — non-finite SVGLength (Range NaN poisoning)

- **status:** FIXED (code + regression tests; deploy pending) · **priority:** P2
- **occurrences:** 2 · **ids:** [1019, 1023]
- **assessment:** Confirmed by arithmetic. `Range.innerWidth` (`width - padding`) reaches 0 when a timeline element's layout collapses to exactly the padding (the studio's `TimelineRange` uses `padding: 12` and several `watchResize` handlers assign raw `clientWidth`). `xToValue` then divides by zero; the shift-wheel zoom (`RegionsArea.tsx:237` `range.scaleBy(scale, range.xToValue(...))`) feeds the resulting NaN/±Infinity into `Range.set`, which stores it — `#min`/`#max` are poisoned **permanently**, so every subsequent range notification crashes `TimelineRangeSlider.onUpdate` (`width.baseVal.value = x1 - x0` → non-finite SVGLength). Chrome (#1019) and Firefox (#1023) report the same line.
- **fix:** `packages/lib/std/src/range.ts` — `innerWidth` clamps to ≥ 1, killing every division-by-zero in the class at the single source (`xToValue`, `valuesPerPixel`, and `TimelineRange.zoomRange` which also divides by it). A ≤ 0-width viewport renders nothing, so 1px-basis math there is unobservable. Regression tests in `packages/lib/std/src/range.test.ts`. Do NOT mark fixed=1 until deployed.

[< back to index](error-triage.md)

## Reports

### TypeError: Failed to set the 'value' property on 'SVGLength': The provided float value is non-finite.
- **occurrences:** 2 · **ids:** [1019 (Chrome/Win), 1023 (Firefox/Linux)] · **span:** 2026-06-30 → 2026-07-04 · **builds:** 1 (169f7f25)
- **stack (source-mapped):**
  - `TimelineRangeSlider.tsx:50` → `markerParts[2].width.baseVal.value = x1 - x0`
  - `← Range.set → Range.scaleBy → TimelineRange.scaleBy`
  - `← RegionsArea.tsx:237` → `range.scaleBy(scale, range.xToValue(event.clientX - rect.left))` (shift+wheel zoom)
- **context (#1019 log):** "Popout into new browser window" ~80s before the crash — consistent with a (transiently) collapsed timeline layout in one of the windows while wheel events still arrive.

## Notes

- The trigger requires `clientWidth <= padding` on a timeline element that still receives wheel events; the exact layout state (popout, panel collapse, minimized window) varies — the arithmetic path is the invariant part and is now closed.
- `Range.set` remains strict (no silent NaN filtering) — with the division-by-zero gone, a non-finite value reaching `set` would indicate a different bug and should surface.

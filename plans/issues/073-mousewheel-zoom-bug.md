# Mousewheel zoom-in bug (#73)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — root cause is pinned to two cooperating pieces of code with concrete line numbers; the fix is a bounded, mechanical change (normalize by `deltaMode`, clamp the resulting scale).
**Type:** bug
**Scope:** small

## What is asked
On Windows (Chrome/Firefox, mousewheel set to scroll 3 lines per notch), (shift+) scroll-up always jumps straight to maximum zoom-in instead of zooming gradually, in every timeline view and in the Editor's time-axis ruler even without Shift.

## Current behaviour / relevant code
Zoom-by-wheel is implemented in (at least) three near-identical places, all computing a `scale` from `event.deltaY` without ever reading `event.deltaMode`:

1. `packages/app/studio/src/ui/timeline/WheelScaling.ts:4-13` — used by `TimeAxis.tsx:114` (`WheelScaling.install(canvas, range)`), which has **no Shift guard at all**, matching the report's "Editor on the time-axis div even without shift":
   ```typescript
   Events.subscribe(element, "wheel", (event: WheelEvent) => {
       event.preventDefault()
       const scale = StudioPreferences.settings.pointer["normalize-mouse-wheel"]
           ? Math.sign(event.deltaY) * 0.1
           : event.deltaY * 0.01
       range.scaleBy(scale, range.xToValue(event.clientX - rect.left))
   }, {passive: false})
   ```
2. `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionsArea.tsx:231-237` — same `deltaY * 0.01` formula, gated behind `event.shiftKey` (this is the "Timeline everywhere" case from the report).

Both feed into `Range.scaleBy(scale, position)` in `packages/lib/std/src/range.ts:100-119`:
```typescript
scaleBy(scale: number, position: unitValue): void {
    if (scale === 0.0) {return}
    const range = this.#max - this.#min
    const s = this.#min + (this.#min - position) * scale
    const e = this.#max + (this.#max - position) * scale
    if (scale > 0.0) { ... }
    else if (e - s < this.#minimum) {
        const ratio = (this.#minimum - range) / range
        this.set(this.#min + (this.#min - position) * ratio, this.#max + (this.#max - position) * ratio)
    } else {
        this.set(s, e)
    }
}
```
For zoom-in (`scale < 0`), if the computed `e - s` would be smaller than `this.#minimum` (the configured minimum zoom width), the code snaps straight to a range sized by `ratio = (minimum - range) / range` — i.e. it jumps directly to the minimum-width (maximum zoom) window in one step, rather than clamping the *input* `scale` so the zoom approaches the minimum gradually over several wheel events.

**Why this only bites some users:** on a trackpad or a "smooth"/pixel-mode mouse wheel, `event.deltaY` per tick is small (single digits to a few tens), so `scale = deltaY * 0.01` stays small and `e - s` shrinks gradually, never overshooting `this.#minimum` except in the last, expected step. On Windows with "scroll 3 lines per notch," many browsers report a much larger `deltaY` per event for a single notch (and/or a different `deltaMode`, `DOM_DELTA_LINE = 1` instead of `DOM_DELTA_PIXEL = 0`), so `scale` can be an order of magnitude larger than the pixel-mode case — large enough that `Range.scaleBy`'s overshoot branch fires on effectively the *first* scroll tick, snapping straight to minimum zoom. This matches the report precisely, including the existing `"normalize-mouse-wheel"` preference (`StudioPreferences`) being a manual workaround that replaces the proportional `deltaY * 0.01` with a fixed `sign(deltaY) * 0.1` step — which sidesteps the bug only when the user finds and enables that setting.

## Plan
1. Normalize `event.deltaY` by `event.deltaMode` before computing `scale`, in both `WheelScaling.ts` and `RegionsArea.tsx`'s inline duplicate: for `DOM_DELTA_LINE` (1) and `DOM_DELTA_PAGE` (2), convert to an equivalent pixel-ish magnitude (a reasonable constant-per-line, e.g. ~16-40px, is the standard approximation used by most wheel-normalization libraries) before multiplying by the existing `0.01` factor. `DOM_DELTA_PIXEL` (0) keeps today's behaviour unchanged.
2. Additionally clamp the resulting `scale` magnitude to a sane maximum (e.g. mirror the existing `"normalize-mouse-wheel"` fixed-step magnitude, `0.1`, as an upper bound) so that even an unexpectedly large single wheel event can never overshoot `Range.scaleBy`'s minimum-width branch in one jump — this is a defense-in-depth fix independent of the `deltaMode` normalization, since some browsers may still report unusually large pixel-mode deltas.
3. Extract the shared `scale` computation (currently duplicated between `WheelScaling.ts` and `RegionsArea.tsx:235`) into one function so both call sites (and any future one) get the fix consistently — de-duplication also prevents this bug from resurfacing in only one of the two places later.
4. Leave `Range.scaleBy`'s overshoot-clamp branch (`e - s < this.#minimum`) as-is; it is a legitimate safety clamp for genuinely large zoom requests (e.g. programmatic `zoomRange` calls) and is not itself wrong — the bug is entirely in what magnitude of `scale` reaches it from wheel input.
5. Manual regression check: use the OS wheel settings (or a synthetic `WheelEvent` with `deltaMode: 1, deltaY: 3`) to simulate the reported "3 lines per notch" case pre/post fix, confirming zoom now steps gradually instead of snapping to max.

## Risks / open questions
- The exact per-line pixel-equivalent constant is a judgment call; check whether `@opendaw/lib-dom`'s `Events` module already has a wheel-normalization helper before introducing a new magic number.
- `AudioUnitsTimeline.tsx:114` (`scrollModel.position += event.deltaY`) and `WheelScroll.ts` (horizontal scroll, not zoom) use raw `deltaY`/`deltaX` too — out of scope for this zoom bug, but worth flagging since they'd exhibit an analogous "huge jump" symptom for scroll rather than zoom under the same Windows wheel configuration; not fixing them here unless the maintainer wants the sweep widened.

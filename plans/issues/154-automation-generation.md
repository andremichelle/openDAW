# Automation generation (#154)

**Doability:** ⭐☆☆☆☆ (1/5) — biggest scope in the batch: new generator engine, new interactive UI with live preview, several open design questions.
**Type:** feature
**Scope:** large

## What is asked
Generate automation curves algorithmically instead of drawing by hand:
- Function generator: square/saw/sine shapes with min/max, exponent, PWM, quantization, frequency, inverse.
- Random generator: seed, density, quantization, exponent.
- Both should be visible/audible/manipulable live before committing ("baking") the result into actual events.

## Current behaviour / relevant code
No generator infrastructure exists today. The closest analogues:
- Bulk event operations on existing content: `packages/app/studio/src/ui/timeline/editors/value/ValueMenu.ts:16-40` — the region's right-click "Edit" menu already has `Delete`/`Inverse`/`Reverse`, each a `Procedure<ReadonlyArray<ValueEventBoxAdapter>>` run inside `editing.modify(...)`. This is the natural place to add a `Generate...` entry, but a generator needs a **dialog/panel** with many parameters, not a single-shot menu action.
- Curve shaping primitives: `packages/lib/std/src/curve.ts` (`Curve.valueAt`/`normalizedAt`/`walk`) already implements one exponential curve shape between two points — useful for the function generator's "exponent" control, but the request needs square/saw/sine shapes too, which don't exist anywhere in the codebase yet.
- Live preview before commit: the value editor already has a live-preview render path used for in-progress drag modifications — `ValuePainter.ts:89-105` reads from `modifyContext.modifier` (an `Option<ValueModifyStrategy>`) to draw a proposed edit before it's approved, and `ValueModifyStrategies.ts`/`ValueEventDraft.ts` define the modifier contract. A generator's live preview should plug into this same `ObservableModifyContext<ValueModifier>` mechanism (`packages/app/studio/src/ui/timeline/ObservableModifyContext.ts`) rather than inventing a new preview path — implement it as a new `ValueModifyStrategy` (e.g. `ValueGenerateModifier`) alongside `ValuePaintModifier`/`ValueMoveModifier`/`ValueSlopeModifier`.
- Region-scoped quantization needed for "quantization" controls on both generators overlaps with #38's per-region resolution request — same underlying value-axis snapping primitive would serve both.

## Plan (high-level; needs a design pass before real estimation)
1. **Design the interaction model** with the maintainer: is this a modal dialog (params in, events out, one-shot), or a live floating panel with sliders that continuously re-renders the preview and only commits on explicit confirm/dismiss? The "visible/audible/manipulable before baking" requirement points to the latter, which is substantially more work (needs live audio preview wiring too — engine must be able to preview automation that hasn't been committed to the graph yet).
2. Build a generator module (new file, e.g. `packages/app/studio/src/ui/timeline/editors/value/generate/AutomationGenerator.ts`) implementing:
   - Function generator: shape functions (square/saw/sine) parameterized by frequency/PWM/exponent/inverse, sampled at the region's time-grid resolution, min/max-scaled to unit range.
   - Random generator: seeded PRNG (need to pick/add a minimal seedable RNG — check `packages/lib/std` for an existing one before adding a dependency, per "minimal dependencies" convention), density (event spacing/probability), exponent (distribution shaping), quantization.
   - Both emit a list of `{position, value, interpolation}` tuples, the same shape `ValueEventDraft`/`collection.createEvent` already consume.
3. Build the UI: a panel/dialog with the parameter controls, wired to a `ValueGenerateModifier` (new `ValueModifyStrategy`) so `ValuePainter.ts`'s existing preview-render path (`createIterator` via `modifier.match(...)`, lines 89-105) shows the generated curve live as controls change, before commit.
4. On commit, replace the region/clip's existing events (or a selected range) with the generated set via `editing.modify(...)`, following the same collect-and-replace pattern already used in `ValueMoveModifier.approve()` (`ValueMoveModifier.ts:180-253`) for atomic event-set replacement.
5. Audible preview: confirm whether "audible before baking" requires the audio engine to read from the in-progress preview curve (would need a temporary/shadow automation source) or whether committing-as-you-go with undo-coalescing is an acceptable substitute — this materially changes the engine-side scope.

## Risks / open questions
- This is the least-scoped issue in the batch — it describes a feature family (two generator types, many parameters each, live preview, live audio) rather than a single change. Recommend splitting into smaller shippable slices (e.g. ship the function generator as a one-shot dialog first, without live audio preview, before tackling random generation and live-audition).
- "Audible... before baking" implies the engine can preview automation not yet committed to the box graph — no existing mechanism for this; needs an architecture decision (temporary graph mutation + revert, vs. a dedicated preview-value channel bypassing the graph).
- Seeded random number generation: check `packages/lib/std` for any existing PRNG utility before adding one, per the project's minimal-dependency preference.
- Overlaps with #38 (region resolution/unit) on the value-axis grid/quantization primitive — consider sequencing #38 first if both are picked up, so the grid renderer is built once.

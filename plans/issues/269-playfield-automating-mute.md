# Playfield automating mute does not work (#269)

**Doability:** ⭐⭐⭐☆☆ (3/5) — TS root cause fully confirmed; WASM parity needs the same fix plus verification; UI gap is small.
**Type:** bug
**Scope:** medium (cross-engine)

## What is asked
Two issues:
1. Drawing automation on a Playfield sample's `mute` parameter has no audible effect.
2. To create that automation at all, you must open the expanded per-sample editor — the mute button that's directly right-clickable in the compact grid ("slot") view doesn't offer automation.

## Current behaviour / relevant code

### 1. Automation has no effect (TS engine)
`mute` **is** exposed as a proper automatable parameter at the adapter level:
`packages/studio/adapters/src/devices/instruments/PlayfieldDeviceBoxAdapter.ts` → `PlayfieldSampleBoxAdapter.#wrapParameters` (in `.../Playfield/PlayfieldSampleBoxAdapter.ts:156`):
```ts
mute: this.#parametric.createParameter(box.mute, ValueMapping.bool, StringMapping.bool, "Mute"),
```
So the UI can attach an automation track to it and draw a curve. But the audio engine never pulls that automation. In `packages/studio/core-processors/src/devices/instruments/Playfield/SampleProcessor.ts:76-80`:
```ts
handleEvent(event: Event) {
    if (NoteLifecycleEvent.isStart(event)) {
        const {mute, solo, polyphone, exclude} = this.#adapter.namedParameter
        const isMute = mute.getValue()          // reads the raw field adapter directly
```
Compare with `sampleStart`/`sampleEnd`/`attack`/`release`/`pitch`, which **are** wired into the automation-pull system via `this.bindParameter(...)` (`SampleProcessor.ts:40-48`) and stored in `AutomatableParameters` (`.../Playfield/AutomatableParameters.ts`). Only parameters registered with `bindParameter` get added to `#automatedParameters` and get their value refreshed per block by `AbstractProcessor.updateParameters` (`packages/studio/core-processors/src/AbstractProcessor.ts:63-69`, which calls `parameter.updateAutomation(position)`). Critically, `AutomatableParameter.updateAutomation` (`packages/studio/core-processors/src/AutomatableParameter.ts:52-59`) only updates its own internal shadow `#value` — it never writes back to the underlying box field. So a parameter that's read via `adapter.namedParameter.X.getValue()` (the raw field) instead of via a bound `AutomatableParameter.getValue()` will **never** see automated values, no matter what curve is drawn. `mute`/`solo`/`polyphone`/`exclude` are all in this un-bound category.

### 2. WASM engine (parity check requested)
`crates/stock-devices/device-playfield-sample/src/lib.rs` binds `gate`, `pitch`, `sample_start`, `sample_end`, `attack`, `release`, and `polyphone` via `abi::bind_parameter` (lines 120-126) — `mute`/`solo`/`exclude` are **not** in that list either. The composite (`crates/engine/src/composite.rs`) resolves cross-slot mute/solo via direct field reads (`child_flag`, lines 381-396) gated by change-subscriptions (`gate_subs`, lines 482-484) that trigger a reconcile when the field changes. Whether Rust's automation-playback model writes the resolved value back into the field (unlike TS, which keeps it in a separate shadow) needs confirmation — if it does, WASM might already partially work where TS doesn't; if not, it has the identical gap and needs the identical fix.

### 3. Automation entry point missing from the compact grid
The compact grid slot (`packages/app/studio/src/ui/devices/instruments/PlayfieldDeviceEditor/BusySlot.tsx`) renders the mute toggle as a plain `Checkbox` (lines 65-69) bound only through `EditWrapper.forAutomatableParameter` (line 60) — no `attachParameterContextMenu`/automation-control wrapper is attached to it. The slot's own `ContextMenu.subscribe` (lines 181-194) only offers `Reset Mute`/`Reset Solo`/`Reset Exclude`, no "Create Automation". The full per-sample editor (`packages/app/studio/src/ui/devices/instruments/PlayfieldSampleEditor.tsx`) doesn't reference mute at all, so "expanding to the sample" more likely means switching `userEditingManager.audioUnit`'s edit target (via the slot's "Edit" icon, `BusySlot.tsx:169`) so that a generic automation-track/parameter picker elsewhere in the UI becomes scoped to this sample — this needs confirming against the actual UI flow the reporter used.

## Plan
1. **TS engine fix**: add `mute` (and, for consistency, `solo`/`polyphone`/`exclude`) to `AutomatableParameters` (`.../Playfield/AutomatableParameters.ts`), bind them in `SampleProcessor`'s constructor via `this.own(this.bindParameter(mute))` etc., and change `handleEvent` (`SampleProcessor.ts:76-80`) to read `this.#parameters.mute.getValue()` instead of `this.#adapter.namedParameter.mute.getValue()`.
2. **WASM engine parity**: add `mute`/`solo`/`exclude` to the `abi::bind_parameter` calls in `device-playfield-sample/src/lib.rs` (mirroring `polyphone_id` at line 125), and thread the bound/resolved value into the composite's `child_flag`/silent computation (`composite.rs:381-396`) instead of (or in addition to) the raw field read — needs an engine-side read of how `gate_subs`-triggered reconciliation currently interacts with automation, since this may already differ from TS's shadow-value model.
3. **UI automation entry point**: attach the automation control/context-menu wrapper directly to the mute (and solo/exclude) `Checkbox` in `BusySlot.tsx:65-80`, so right-clicking the grid toggle offers "Create Automation" without requiring the per-sample editor.
4. Add a WASM/TS parity test (per project convention) automating Playfield mute and asserting silence during the muted region, mirroring existing Playfield parity tests.

## Risks / open questions
- Confirm the exact "expand to the sample" UI flow the reporter used, to be sure step 3 targets the right control.
- Whether `solo`/`exclude`/`polyphone` should also be fixed now (same underlying bug class) or scoped strictly to `mute` per the issue title — recommend fixing all four together since the same code path is touched.
- Rust composite's automation-resolution model for boolean fields needs a maintainer/engine-dev read before committing to the WASM fix shape; per project convention this is a "WASM CONTRACT" area (`mute`/`solo` field indices are frozen — verify no reordering needed, only wiring).

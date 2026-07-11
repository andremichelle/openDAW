# Custom device inputs (#207)

**Doability:** ⭐⭐☆☆☆ (2/5) — the component-authoring pattern is simple and well-established, but a "pulse" control has no backing box-graph concept today, which is a design question before any code gets written.
**Type:** feature
**Scope:** medium

## What is asked
More input control types for device editors: an X-Y graph (2D pad, presumably binding two parameters at once) and a momentary "button (pulse)" control. (A snapping/integer dial variant was in the original request but has been struck out, so out of scope here.)

## Current behaviour / relevant code
Device parameter controls are built through one factory today: `packages/app/studio/src/ui/devices/ControlBuilder.tsx`:
```typescript
export namespace ControlBuilder {
    export const createKnob = <T extends PrimitiveValues, >({lifecycle, editing, midiLearning, adapter, parameter, options, anchor, color, style, disableAutomation, label}: Creation<T>) => (
        <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning} tracks={tracks} parameter={parameter} disableAutomation={disableAutomation}>
            <Column ems={LKR} color={color ?? Colors.cream} style={style}>
                <h5>{label ?? parameter.name}</h5>
                <ParameterLabelKnob lifecycle={lifecycle} editing={editing} parameter={parameter} options={options} anchor={anchor}/>
            </Column>
        </AutomationControl>
    )
}
```
Every device editor (`packages/app/studio/src/ui/devices/audio-effects/*.tsx`, `instruments/*.tsx`, etc.) composes its UI from `ControlBuilder.createKnob` plus a couple of standalone widgets: `ParameterToggleButton.tsx` (boolean on/off, `packages/app/studio/src/ui/devices/ParameterToggleButton.tsx:17-25`, a plain `click` → `parameter.setValue(!parameter.getValue())`) and `SidechainButton.tsx`. There is no X-Y pad component anywhere in the UI tree (`grep` for `XY`/`XYPad` only turns up an unrelated chart in `pages/stats/charts.tsx`), and no "momentary/pulse" control exists — `ParameterToggleButton` is a *latching* toggle (persists `true`/`false` in a box field), not a momentary trigger.

All existing controls bind to `AutomatableParameterFieldAdapter<T>` — a field that holds **persisted, automatable state** in the box graph (survives save/load, can have automation curves recorded against it, drives `AutomationControl`'s automation-lane wiring). A "pulse" button is conceptually different: it represents a *momentary, one-shot* action, not a value that persists. No existing device schema field in `packages/studio/boxes/src` represents this "fire once" semantic (a `grep` for `trigger`/`bang`/`pulse`/`momentary` only turns up unrelated clip-playback and tempo-map code) — every field found either holds continuous/discrete state or a boolean, all durable.

## Plan
1. **X-Y pad control:** this is the more straightforward of the two, since it binds to two ordinary `AutomatableParameterFieldAdapter<number>` fields (X and Y), no new box-graph concept needed. Add `ControlBuilder.createXYPad({parameterX, parameterY, ...})` following the same shape as `createKnob`, with a new `XYPad.tsx` component that:
   - renders a square/rect canvas or `<div>` with a draggable puck,
   - on pointer drag, maps position within the pad to each parameter's normalized range (reuse whatever normalization `ParameterLabelKnob.tsx` already does for a single knob, applied independently per axis),
   - wraps in `AutomationControl` twice (once per axis) or extends `AutomationControl` to accept a pair, whichever requires less duplication — check `AutomationControl`'s props shape before deciding.
2. **Pulse button:** requires a design decision first, since there's no durable field type for "fired once." Two directions:
   - **UI-only pulse:** the button performs an immediate, transient visual/audio effect without persisting anything to the box graph (e.g. directly invoking an engine-side one-shot call, similar to how `ClipsHeader.tsx:47-53` directly calls `engine.scheduleClipPlay(...)` on `pointerdown` without going through a persisted field). This works if the device's underlying DSP already exposes a one-shot action reachable without a stored parameter (e.g. "retrigger envelope," "reset phase") — needs checking per-device whether such an entry point exists.
   - **Boolean-flash field:** reuse a boolean field like `ParameterToggleButton` does, but auto-reset it to `false` shortly after `pointerdown` sets it `true` (a timer or an engine-side auto-clear), giving downstream automation/engine code a detectable "rising edge" without introducing a new field kind. Simpler to build, but adds a fabricated transient state to the box graph that engine code must specifically watch for the edge, not the level.
   Recommend surfacing both options to the maintainer before implementation, since the right choice depends on what the momentary button is meant to *do* for a specific device (the issue doesn't name one).
3. Once one or both components exist in the shared `ControlBuilder`/`devices` component library, adopt them on a per-device basis as needed — the issue is about adding the building blocks, not necessarily retrofitting every existing device editor in this pass.

## Risks / open questions
- The pulse button's backing semantics (transient UI action vs. a new box-graph field convention) is an open design question and should be resolved before writing code; the two directions in step 2 have different implications for undo/history (a fabricated boolean-flash field would create spurious undo-stack entries unless specifically excluded) and for WASM/engine parity (a UI-only pulse bypassing the box graph would need its own message path to the engine, similar to `engine.scheduleClipPlay`).
- No specific device was named as the first consumer of either control — confirm with the maintainer which device(s) should adopt these first, to scope a concrete first PR rather than building unused infrastructure.

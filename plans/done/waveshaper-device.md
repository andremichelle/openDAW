# Waveshaper Audio Effect Device

## Context

A waveshaper applies a nonlinear transfer function to the audio signal, producing harmonic distortion. The `Waveshaper` namespace in `@opendaw/lib-dsp` already provides 6 optimised equation loops (`hardclip`, `cubicSoft`, `tanh`, `sigmoid`, `arctan`, `asymmetric`). This device wraps them with input drive, output gain, dry/wet mix, and equation selection.

## Signal Flow

```
input → [× inputGain] → Waveshaper.process(equation) → [× outputGain] → mix(dry, wet) → output
```

- Input gain (0–40 dB) pre-multiplies the signal before the waveshaper
- The waveshaper processes in-place on the driven signal
- Output gain (-24 to +24 dB) scales the shaped result
- Mix blends the original dry input with the wet shaped output

## Schema

`packages/studio/forge-boxes/src/schema/devices/audio-effects/WaveshaperDeviceBox.ts`

```typescript
DeviceFactory.createAudioEffect("WaveshaperDeviceBox", {
    10: { type: "string", name: "equation" },
    11: { type: "float32", name: "input-gain", pointerRules: ParameterPointerRules,
          value: 0.0, constraints: {min: 0.0, max: 40.0, scaling: "linear"}, unit: "dB" },
    12: { type: "float32", name: "output-gain", pointerRules: ParameterPointerRules,
          value: 0.0, constraints: {min: -24.0, max: 24.0, scaling: "linear"}, unit: "dB" },
    13: { type: "float32", name: "mix", pointerRules: ParameterPointerRules,
          value: 1.0, constraints: "unipolar", unit: "%" }
})
```

The equation is a `StringField` storing a `Waveshaper.Equation` value (default `"tanh"`). Not automatable — changed via UI selection.

## Adapter

`packages/studio/adapters/src/devices/audio-effects/WaveshaperDeviceBoxAdapter.ts`

Wraps `inputGain`, `outputGain`, and `mix` as automatable parameters. The `equation` StringField is accessed directly via `adapter.box.equation`.

```typescript
#wrapParameters(box: WaveshaperDeviceBox) {
    return {
        inputGain: this.#parametric.createParameter(
            box.inputGain, ValueMapping.linear(0.0, 40.0),
            StringMapping.decible, "Input"),
        outputGain: this.#parametric.createParameter(
            box.outputGain, ValueMapping.linear(-24.0, 24.0),
            StringMapping.decible, "Output"),
        mix: this.#parametric.createParameter(
            box.mix, ValueMapping.unipolar,
            StringMapping.percentage, "Mix")
    } as const
}
```

## Processor

`packages/studio/core-processors/src/devices/audio-effects/WaveshaperDeviceProcessor.ts`

Uses `Ramp.linear(sampleRate)` for smooth input/output gain transitions (same pattern as FoldDeviceProcessor).

```
processAudio:
1. Copy source into output buffer
2. Per sample: multiply by smoothed inputGain
3. Waveshaper.process(output.channels(), equation, fromIndex, toIndex)
4. Per sample: multiply by smoothed outputGain, blend with dry source via mix
```

The equation is subscribed via `adapter.box.equation.catchupAndSubscribe()` and stored as a `Waveshaper.Equation` field. Default to `"tanh"` if the StringField is empty.

## Editor

`packages/app/studio/src/ui/devices/audio-effects/WaveshaperDeviceEditor.tsx`

Layout:
- **Equation selector** — `RadioGroup` or menu showing the 6 equation names
- **Transfer curve canvas** — draws the equation in a coordinate system from -1.5 to +1.5 on both axes, with crosshair at origin. Input drive applied to the plotted curve. Redraws on equation or inputGain change.
- **Knobs** — inputGain (anchor 0.0), outputGain (anchor 0.5), mix (anchor 1.0)
- **Peak meter**

### Canvas rendering

Using `CanvasPainter`, draw:
1. Grid lines at 0 on both axes (crosshair) in `Colors.shadow`
2. The identity line (y=x) faintly as reference
3. The shaped curve: for x in [-1.5, +1.5], compute `equation(x * inputGain)` and plot. Use `DisplayPaint.strokeStyle(0.75)`.

The individual equation functions (`cubicSoft`, `tanh`, etc.) are kept as standalone exports in the `Waveshaper` namespace for use in the editor's curve rendering.

## Factory Registrations

| File | Change |
|------|--------|
| `packages/studio/forge-boxes/src/schema/devices/audio-effects/WaveshaperDeviceBox.ts` | **New** — schema |
| `packages/studio/forge-boxes/src/schema/devices/index.ts` | Export schema |
| `packages/studio/boxes/src/WaveshaperDeviceBox.ts` | **Generated** — run forge build |
| `packages/studio/adapters/src/devices/audio-effects/WaveshaperDeviceBoxAdapter.ts` | **New** — adapter |
| `packages/studio/adapters/src/BoxAdapters.ts` | Add `visitWaveshaperDeviceBox` |
| `packages/studio/core-processors/src/devices/audio-effects/WaveshaperDeviceProcessor.ts` | **New** — processor |
| `packages/studio/core-processors/src/DeviceProcessorFactory.ts` | Add `visitWaveshaperDeviceBox` |
| `packages/app/studio/src/ui/devices/audio-effects/WaveshaperDeviceEditor.tsx` | **New** — editor with canvas |
| `packages/app/studio/src/ui/devices/audio-effects/WaveshaperDeviceEditor.sass` | **New** — styles |
| `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx` | Add `visitWaveshaperDeviceBox` |
| `packages/studio/core/src/EffectFactories.ts` | Add `Waveshaper` factory |
| `packages/studio/adapters/src/DeviceManualUrls.ts` | Add URL |
| `packages/lib/dsp/src/waveshaper.ts` | Keep standalone equation functions exported for editor curve rendering |

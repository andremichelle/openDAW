---
title: Automation and Modulation
group: Guide
order: 5
---

# Automation and Modulation

## Automation tracks

`unit.addValueTrack(target, path)` creates a lane for a parameter of the unit itself, its instrument, any of its
effects, sends or Playfield slots. A parameter has at most one lane per unit, `unit.valueTrack(target, path)`
finds it.

Points are normalized 0.0 to 1.0 over the parameter's range. Two points at the same position form a step.

```ts
const lane = synth.addValueTrack(synth.instrument, "cutoff")
const region = lane.addRegion({duration: PPQN.Bar * 4})
region.addEvents([
    {position: 0, value: 0.1},
    {position: PPQN.Bar * 2, value: 0.9, interpolation: Interpolation.Linear},
    {position: PPQN.Bar * 4, value: 0.1}
])
```

Automation can also live in clips (`lane.addClip()`).

## Modulators

`project.addModulator(kind, props)` creates an LFO, Steps, Macro or Random modulator. `modulator.assign(target,
path, depth)` connects it to a parameter and returns a {@link Modulation} whose `depth`
and `enabled` can be changed later.

```ts
const lfo = project.addModulator("LFO", {label: "Wobble", rateSync: 8, shape: 0})
lfo.assign(synth.instrument, "cutoff", 0.4)
lfo.assign(synth.instrument.lfo, "rate", -0.2)

const steps = project.addModulator("Steps", {count: 8})
steps.setSteps([1, 0, 0.5, 0, 1, 0, 0.5, 0.25])
steps.assign(drums.instrument.slots[0], "pitch", 0.5)
```

Modulator parameters and assignment depths can be automated as well: `modulator.addValueTrack(modulator,
"rateAbsolute")` or `modulator.addValueTrack(modulation, "depth")`.

## Tempo

```ts
project.tempoTrack.enabled = true
project.tempoTrack.addEvent({position: 0, bpm: 120})
project.tempoTrack.addEvent({position: PPQN.Bar * 16, bpm: 128, interpolation: Interpolation.Linear})
```

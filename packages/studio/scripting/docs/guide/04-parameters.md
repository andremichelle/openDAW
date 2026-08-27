---
title: Parameters and Paths
group: Guide
order: 4
---

# Parameters and Paths

Every device, unit, send, slot and modulator exposes its parameters as plain properties. Nested objects are
plain properties too:

```ts
synth.instrument.cutoff = 800
synth.instrument.lfo.rate = 4
synth.instrument.oscillators[1].volume = -12
```

## Construction props

Every `add...` method takes the same properties as an object, nested objects included. Unknown keys are ignored,
read-only properties and methods are not accepted.

```ts
project.addInstrumentUnit("Vaporisateur", {label: "Pad", volume: -9}, {
    attack: 0.4,
    lfo: {rate: 0.3, targetCutoff: 0.4},
    oscillators: [{waveform: ClassicWaveform.Saw}, {volume: -6, octave: -1}]
})
```

## Parameter paths

Automation and modulation address a parameter by its path, a string like `"cutoff"`, `"lfo.rate"` or
`"oscillators.1.volume"`. The path type is derived from the target, so the editor completes valid paths and
rejects invalid ones:

```ts
synth.addValueTrack(synth.instrument, "lfo.rate")
lfo.assign(synth.instrument, "oscillators.0.volume", 0.3)
synth.addValueTrack(synth, "volume")
synth.addValueTrack(synth.sends[0], "amount")
```

Only primitive properties (numbers and booleans) form paths. References like `sample` or `sideChain` do not.

## Discriminated unions

Collections hold unions, narrow them by their discriminator:

```ts
project.audioUnits.forEach(unit => {
    if (unit.kind === "instrument" && unit.instrument.key === "Vaporisateur") {
        unit.instrument.cutoff = 1000
    }
})
unit.audioEffects.forEach(effect => {
    if (effect.key === "Delay") {effect.feedback = 0.3}
})
```

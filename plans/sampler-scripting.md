# Sampler scripting API

An example script first, to find the shape that creates and edits every aspect of the Sampler.

Implemented (2026-11-12): the panel values, `filter`, `ampEnvelope`, `modEnvelope`, `lfos`, `groups`, `zones`,
`modulations`, `addGroup`, `addZone`, `addModulation` and `remove()` on each. Enumerations are the numbers the boxes
store (`loopMode: 2`, `addModulation(6, 5, 1)`), as in the rest of the scripting API, not the strings of the example.
`sampleEnd` and `loopEnd` are 2147483647 for the end of the sample, not null. Not implemented: `addSamples` and the
window tools. Import and export (SFZ, SF2) stay out of scripts for now (decided 2026-11-12).

## Example

```ts
const project = openDAW.newProject("Sampler")
const all = await openDAW.listSamples()
const find = (name: string) => all.find(sample => sample.name === name)!

// 1. the instrument and its panel
const piano = project.addInstrumentUnit("Sampler", {label: "Upright"})
const sampler = piano.instrument
sampler.voices = 32
sampler.glide = 0.0
sampler.legato = false
sampler.octave = 0
sampler.transpose = 0
sampler.tune = 0.0
sampler.filter.type = "lowpass-12" // "off" | "lowpass-12" | "lowpass-24" | "highpass-12"
sampler.filter.cutoff = 6000
sampler.filter.resonance = 0.2
sampler.volume = -6
sampler.panning = 0.0
sampler.mono = 0.0

// 2. envelopes and LFOs are parts, like the Vaporisateur oscillators
sampler.ampEnvelope.attack = 0.002
sampler.ampEnvelope.release = 0.8
Object.assign(sampler.modEnvelope, {delay: 0, attack: 0.01, hold: 0, decay: 0.4, sustain: 0, release: 0.2})
sampler.lfos[0].shape = "sine" // "sine" | "triangle" | "saw" | "square" | "random"
sampler.lfos[0].rate = 5.0
sampler.lfos[0].sync = false
sampler.lfos[1].restart = false

// 3. groups. A new Sampler has one.
const sustain = sampler.groups[0]
sustain.label = "Sustain"
sustain.roundRobin = "cycle" // "off" | "cycle" | "random"
const releases = sampler.addGroup({label: "Release", trigger: "release"})
const hats = sampler.addGroup({label: "Hats", choke: 1})

// 4. zones, every field given
const zone = sampler.addZone(find("Upright C4 mf"), {
    group: sustain,
    keyLow: 58, keyHigh: 62, keyFade: 0, rootKey: 60,
    velocityLow: 1, velocityHigh: 90, velocityFade: 8,
    transpose: 0, tune: 0, keyTrack: 1,
    gain: 0, panning: 0, sequence: 1, reverse: false, oneShot: false,
    sampleStart: 0, sampleEnd: null, // frames, null is the end of the sample
    loop: "gate", loopStart: 12000, loopEnd: 48000, loopFade: 0.01 // "off" | "gate" | "always"
})

// 5. zones from file names: note, dynamic and round robin are read from the name
const mapped = sampler.addSamples(all.filter(sample => sample.name.startsWith("Upright ")))
sampler.addZone(find("Upright Release C4"), {group: releases, keyLow: 58, keyHigh: 62, rootKey: 60})
sampler.addZone(find("TR-808 Closed Hi-Hat"), {group: hats, keyLow: 42, keyHigh: 42, rootKey: 42, oneShot: true})

// 6. editing what is there
sampler.zones.filter(each => each.group === sustain).forEach(each => each.gain = -3)
zone.keyHigh = 64
zone.group = releases
zone.sample = find("Upright C4 ff")
mapped[0].remove()
hats.remove() // its zones go with it

// 7. the tools of the window, on a set of zones
sampler.spreadKeys(mapped)
sampler.spreadVelocity(mapped)
sampler.crossfade(mapped)
sampler.rootToLow(mapped)
sampler.duplicate([zone])
sampler.mapByName(mapped)

// 8. modulation. A new Sampler has Velocity to Gain at 100%.
sampler.modulations[0].amount = 0.8
const vibrato = sampler.addModulation("lfo-1", "pitch", 0.02)
sampler.addModulation("mod-envelope", "cutoff", 0.5)
vibrato.remove()

openDAW.openProject(project)
```

## What the example shows

1. `Sampler extends Instrument` with the panel values as plain properties, `filter`, `ampEnvelope`, `modEnvelope`
   as parts and `lfos` as an array of two. Matches the Vaporisateur.
2. `groups`, `zones` and `modulations` are read-only arrays with `addGroup`, `addZone`, `addModulation`. Each
   element has `remove()`. Matches the Playfield slots.
3. `addZone(sample, props?)` takes every zone field. A zone names its group by the object, not by an index.
4. `addSamples(samples, group?)` is the scripted Add Samples: it maps by name and returns the zones.
5. The tools take the zones they work on. A script has no selection.
6. Enumerations are strings (`"cycle"`, `"release"`, `"lowpass-12"`, `"lfo-1"`), the boxes store indices.
7. Sample positions are frames, as in the boxes. Nano uses fractions. Frames keep imported loops exact.

## Open

1. `sampler.lfos[0]` or `sampler.lfo1` and `sampler.lfo2`. The panel says LFO 1 and LFO 2.
2. Removing a group removes its zones, or moves them to the first group.
3. Removing a zone removes it at once. The window only switches it off until Clean Up. A script probably wants
   the direct way, and `zone.enabled` for the other.
4. Whether the tools belong on the Sampler at all, or only `addSamples` with its mapping.
5. The names of the modulation sources and targets as strings: `"amp-envelope"`, `"mod-envelope"`, `"lfo-1"`,
   `"lfo-2"`, `"velocity"`, `"key"`, `"random"` and `"pitch"`, `"cutoff"`, `"resonance"`, `"gain"`, `"pan"`,
   `"start"`, `"loop"`, `"lfo-1-rate"`, `"lfo-2-rate"`, `"env-depth"`.

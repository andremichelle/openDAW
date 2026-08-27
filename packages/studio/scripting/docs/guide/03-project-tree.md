---
title: The Project Tree
group: Guide
order: 3
---

# The Project Tree

## Audio units

A unit is a mixer channel. There are four kinds, `kind` tells them apart:

* `instrument` units host an {@link Instrument | instrument} and are created with
  `project.addInstrumentUnit(key, props, instrumentProps)`.
* `auxiliary` units are send effect buses (`project.addAuxUnit()`).
* `group` units are sub mixes (`project.addGroupUnit()`).
* `output` is the master, there is exactly one (`project.output`).

Every unit has `volume`, `panning`, `mute`, `solo`, `output` (where it is routed), a MIDI effect chain, an audio
effect chain and tracks. Instrument, aux and group units can add sends.

```ts
const drums = project.addInstrumentUnit("Playfield", {label: "Drums"})
const bus = project.addGroupUnit({label: "Drum Bus", color: "hsl(20, 60%, 50%)"})
drums.output = bus
bus.addAudioEffect("Compressor", {threshold: -18, ratio: 4})
```

`project.findAudioUnit(label)` looks a unit up by its label.

## Instruments

`addInstrumentUnit` creates the unit together with one default track that matches the instrument: a note track
for synths and samplers, an audio track for Tape. `unit.setInstrument(key)` swaps the instrument and keeps
tracks and effects.

Available keys are the properties of {@link Instruments}.

## Effects

`addMIDIEffect(key, props, index)` and `addAudioEffect(key, props, index)` append to the chain or insert at
`index`. `effect.move(index)` reorders, `effect.enabled = false` bypasses, `effect.remove()` deletes.

Composite effects (`Composite`, `StereoSplit`, `FrequencySplit`) have `entries`, each with its own audio effect
chain. `Composite` entries are added with `addEntry()`, the other two have fixed entries.

Sidechain capable effects (`Compressor`, `Gate`, `Vocoder`) take any unit, instrument, effect, Playfield slot or
composite entry as `sideChain`.

## Tracks, regions and clips

A track holds regions on the arrangement and clips in the launcher. `track.type` is `"notes"`, `"audio"` or
`"value"`.

* {@link NoteTrack}: `addRegion()` and `addClip()` hold {@link NoteEvent}s.
* {@link AudioTrack}: `addRegion(sample)` and `addClip(sample)` play a {@link Sample}.
* {@link ValueTrack}: automation of one parameter, created with `unit.addValueTrack(target, "path")`.

Regions cannot overlap on a track, `addRegion` throws if they would. Regions loop their content every
`loopDuration`, so a two bar region with `loopDuration: PPQN.Bar` plays its first bar twice.

Pass `mirror` to a note or value region to share the events of another region or clip (a linked copy).

## Sends

```ts
const reverb = project.addAuxUnit({label: "Reverb"})
reverb.addAudioEffect("Reverb", {decay: 0.8})
synth.addSend(reverb, {amount: -12, mode: "post"})
```

## Global timeline

* `project.markers` and `addMarker()` for arrangement markers.
* `project.tempoTrack` for tempo changes (enable it, then `addEvent({position, bpm})`).
* `project.signatureTrack` for time signature changes.
* `project.loop` for the transport loop, `project.duration` for the project length.
* `project.groove` for the global shuffle.

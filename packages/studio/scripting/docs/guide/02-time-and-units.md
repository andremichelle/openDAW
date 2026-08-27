---
title: Time and Units
group: Guide
order: 2
---

# Time and Units

## PPQN

All timeline positions and durations are in pulses per quarter note. A quarter note is 960 pulses.

| Constant          | Pulses | Meaning                       |
|-------------------|--------|-------------------------------|
| `PPQN.Bar`        | 3840   | one bar in 4/4                |
| `PPQN.Quarter`    | 960    | one beat                      |
| `PPQN.SemiQuaver` | 240    | one sixteenth                 |

Derive other lengths by arithmetic, `PPQN.Quarter / 3` is a triplet eighth, `PPQN.Bar * 8` is eight bars.
`PPQN.fromSignature(numerator, denominator)` gives the bar length for other signatures.

Conversions: `PPQN.secondsToPulses(seconds, bpm)` and `PPQN.pulsesToSeconds(pulses, bpm)`.

Positions inside a region or clip are relative to its start. `NoteRegion.eventOffset` shifts the notes of a
region without moving them.

## Audio regions

An audio region that does not follow the tempo (`playback: "no-sync"`) has its `duration`, `loopDuration` and
`loopOffset` in seconds instead of pulses. Every other playback mode uses pulses.

## Levels

Everything called `volume`, `gain`, `wet`, `dry`, `amount` (on sends) is in decibels. `-Infinity` is silence, `0`
is unity. `dbToGain()` and `gainToDb()` convert to and from linear factors.

## Normalized values

Parameters typed `unitValue` run from 0.0 to 1.0, `bipolar` from -1.0 to 1.0. Automation points
(`ValueEvent.value`) are always normalized 0.0 to 1.0 regardless of the parameter's own range.

## Pitch

Notes are MIDI pitches, 60 is middle C. `midiToHz(note)` gives the frequency in Hz using the project's
`baseFrequency` (440 Hz by default). `Chord` helps building intervals.

## Ranges and clamping

Every documented range is enforced. A numeric value outside its range is clamped, a wrong type or an unknown
enumeration value throws. See [Validation](./07-validation.md).

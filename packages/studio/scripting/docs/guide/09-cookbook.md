---
title: Cookbook
group: Guide
order: 9
---

# Cookbook

Complete scripts. All of them ship with the studio under File > Open, so you can run and modify them there.

## A pluck with a reverb send and a looping arpeggio

```ts
const project = openDAW.newProject("Hello openDAW")
project.bpm = 110

const synth = project.addInstrumentUnit("Vaporisateur", {label: "Pluck", volume: -9}, {
    cutoff: 2400, resonance: 0.4, filterEnvelope: 0.6, decay: 0.25, sustain: 0.1, release: 0.4
})

const reverb = project.addAuxUnit({label: "Reverb"})
reverb.addAudioEffect("Reverb", {decay: 0.7, wet: -6})
synth.addSend(reverb, {amount: -12})

const region = synth.noteTracks[0].addRegion({duration: PPQN.Bar * 2, loopDuration: PPQN.Bar})
const pitches = [60, 64, 67, 71, 72, 71, 67, 64]
region.addEvents(pitches.map((pitch, index) => ({
    position: index * PPQN.SemiQuaver * 2,
    duration: PPQN.SemiQuaver,
    pitch,
    velocity: 0.6 + (index % 2) * 0.3
})))

project.openInStudio()
```

## Drums from the sample library

```ts
const project = openDAW.newProject("Beat")
const samples = await openDAW.listSamples()
const pick = (needle: string) => samples.find(sample => sample.name.toLowerCase().includes(needle))
const kick = pick("kick")
const snare = pick("snare")
const hat = pick("hat")
if (!kick || !snare || !hat) {
    await openDAW.showInfo("Beat", "Could not find kick, snare and hat samples.")
    return
}
const drums = project.addInstrumentUnit("Playfield", {label: "Drums"})
drums.instrument.addSample(kick, {note: 36})
drums.instrument.addSample(snare, {note: 38})
drums.instrument.addSample(hat, {note: 42, exclude: true, release: 0.05})

const region = drums.noteTracks[0].addRegion({duration: PPQN.Bar * 4, loopDuration: PPQN.Bar})
const step = PPQN.SemiQuaver
for (let index = 0; index < 16; index++) {
    if (index % 4 === 0) {region.addEvent({position: index * step, duration: step, pitch: 36})}
    if (index % 8 === 4) {region.addEvent({position: index * step, duration: step, pitch: 38})}
    region.addEvent({position: index * step, duration: step, pitch: 42, velocity: index % 2 === 0 ? 0.8 : 0.4})
}
project.openInStudio()
```

## Generate a sample and place it on an audio track

```ts
const numberOfFrames = sampleRate * 3
const audioData = AudioData.create(sampleRate, numberOfFrames, 1)
const frames = audioData.frames[0]
for (let index = 0, phase = 0.0; index < numberOfFrames; index++) {
    frames[index] = Math.sin(phase * Math.PI * 2.0) * dbToGain(-6.0)
    const t = index / numberOfFrames
    const freq = 200.0 * Math.pow(20.0, 1.0 - Math.abs(2.0 * t - 1.0))
    phase += freq / sampleRate
}
const sample = await openDAW.addSample(audioData, "Chirp")

const project = openDAW.newProject("Chirp")
const tape = project.addInstrumentUnit("Tape")
tape.audioTracks[0].addRegion(sample, {playback: "no-sync"})
tape.addAudioEffect("Reverb", {wet: -9})
project.openInStudio()
```

## Automate a filter sweep and wobble it with an LFO

```ts
const project = openDAW.newProject("Sweep")
const synth = project.addInstrumentUnit("Vaporisateur", {label: "Bass"}, {cutoff: 400, resonance: 2})
synth.noteTracks[0].addRegion({duration: PPQN.Bar * 8}).addEvent({position: 0, duration: PPQN.Bar * 8, pitch: 36})

const lane = synth.addValueTrack(synth.instrument, "cutoff")
lane.addRegion({duration: PPQN.Bar * 8}).addEvents([
    {position: 0, value: 0.1},
    {position: PPQN.Bar * 8, value: 0.8, interpolation: Interpolation.Linear}
])

const lfo = project.addModulator("LFO", {label: "Wobble", rateSync: 8})
lfo.assign(synth.instrument, "cutoff", 0.3)
project.openInStudio()
```

## Transpose every note of the open project

```ts
const project = await openDAW.getProject()
project.audioUnits.forEach(unit => unit.noteTracks.forEach(track => {
    track.regions.forEach(region => region.events.forEach(event => event.pitch += 2))
    track.clips.forEach(clip => clip.events.forEach(event => event.pitch += 2))
}))
project.openInStudio()
```

## Cleanup

Removes empty tracks, muted regions and clips, regions beyond the end and unused aux units, then reports.

```ts
if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Cleanup", "No project is open.")
    return
}
const project = await openDAW.getProject()
const report: string[] = []
const note = (amount: number, what: string) => {if (amount > 0) {report.push(`${amount} × ${what}`)}}

let muted = 0
project.audioUnits.forEach(unit => unit.tracks.forEach(track => {
    track.regions.filter(region => region.mute || region.position >= project.duration).forEach(region => {
        region.remove()
        muted++
    })
    track.clips.filter(clip => clip.mute).forEach(clip => {
        clip.remove()
        muted++
    })
}))
note(muted, "muted or stray regions and clips")

let emptyTracks = 0
project.audioUnits.forEach(unit => {
    const empty = unit.tracks.filter(track => track.regions.length === 0 && track.clips.length === 0)
    const removable = empty.length === unit.tracks.length ? empty.slice(1) : empty
    removable.forEach(track => {
        track.remove()
        emptyTracks++
    })
})
note(emptyTracks, "empty tracks")

const targets = new Set<string>()
project.audioUnits.forEach(unit => {
    if (unit.kind !== "output") {unit.sends.forEach(send => targets.add(send.target.uuid))}
})
const unused = project.auxUnits.filter(aux => !targets.has(aux.uuid))
unused.forEach(aux => aux.remove())
note(unused.length, "unused auxiliary units")

if (report.length === 0) {
    await openDAW.showInfo("Cleanup", "Nothing to remove.")
} else {
    await openDAW.showInfo("Cleanup", report.join("\n"))
    project.openInStudio()
}
```

## Inventory of the open project

```ts
const project = await openDAW.getProject()
const count = new Map<string, number>()
const add = (name: string, amount: number = 1) => count.set(name, (count.get(name) ?? 0) + amount)
project.audioUnits.forEach(unit => {
    add(`${unit.kind} units`)
    if (unit.kind === "instrument") {add(`instrument ${unit.instrument.key}`)}
    unit.audioEffects.forEach(effect => add(`effect ${effect.key}`))
    unit.tracks.forEach(track => {
        add(`${track.type} tracks`)
        add("regions", track.regions.length)
        add("clips", track.clips.length)
    })
})
add("modulators", project.modulators.length)
const lines = [...count.entries()].map(([name, amount]) => `${amount} × ${name}`)
await openDAW.showInfo("Inventory", lines.join("\n"))
```

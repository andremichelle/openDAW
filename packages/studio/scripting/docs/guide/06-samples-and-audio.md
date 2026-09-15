---
title: Samples and Audio
group: Guide
order: 6
---

# Samples and Audio

## Finding samples

`await openDAW.listSamples()` returns every stock and user sample known to the studio as
{@link Sample} handles with `uuid`, `name`, `duration`, `bpm` and `sample_rate`.

```ts
const samples = await openDAW.listSamples()
const kick = samples.find(sample => sample.name.toLowerCase().includes("kick"))
```

## Creating samples

`openDAW.addSample(audioData, name)` imports raw audio into the studio and returns a handle. Build the audio with
`AudioData.create(sampleRate, numberOfFrames, numberOfChannels)` and write into `frames[channel]`.

```ts
const audio = AudioData.create(sampleRate, sampleRate * 2, 1)
const frames = audio.frames[0]
for (let index = 0; index < frames.length; index++) {
    frames[index] = Math.sin(index / sampleRate * 220 * Math.PI * 2) * Math.exp(-index / sampleRate * 3)
}
const pluck = await openDAW.addSample(audio, "Pluck")
```

`sampleRate` is the global holding the studio's sample rate.

## Playing samples

* {@link Playfield}: `addSample(sample, {note})` assigns a slot per note, each with
  envelope, pitch, start and end, its own effect chains.
* {@link Nano}: one sample, played chromatically.
* {@link Tape}: audio tracks with regions and clips.

```ts
const tape = project.addInstrumentUnit("Tape", {label: "Loops"})
const track = tape.audioTracks[0]
track.addRegion(loop, {position: 0, playback: "timestretch", playbackRate: 1})
track.addRegion(vocal, {position: PPQN.Bar * 4, playback: "signalsmith", transpose: -2})
track.addRegion(oneShot, {position: PPQN.Bar * 8, playback: "no-sync", duration: 1.5})
```

`playback` is fixed at creation. The default is `"pitch"` when the sample has a tempo and `"no-sync"` otherwise.
Regions and clips loop via `loopDuration` and `loopOffset` like notes do. `gain`, `fading.in`, `fading.out` and
the slopes shape the region.

## Soundfonts and impulse responses

{@link Soundfont} takes a `SoundfontFile` and a `presetIndex`, the file itself is chosen
in the studio. {@link ConvolverEffect} takes any sample as its `impulse`.

## Mixdown and saving files

`project.mixdown()` renders the project the script holds, including edits that were not yet applied with
`openInStudio()`, and resolves with {@link AudioData}. The studio shows a progress dialog while rendering.
`options.sampleRate` defaults to 48000.

`openDAW.saveFile(data, fileName, mimeType?)` offers any `ArrayBuffer` or typed array for download. The
studio asks for confirmation first, then opens the save dialog. `WavFile.encodeFloats(audioData)` turns
audio into a wav buffer.

```ts
const project = await openDAW.getProject()
const audio = await project.mixdown()
await openDAW.saveFile(WavFile.encodeFloats(audio), `${project.name}.wav`, "audio/wav")
```

Because the render is plain `AudioData`, a script can inspect or process it before saving, or hand it back
to the studio with `openDAW.addSample(audio, "Bounce")`.

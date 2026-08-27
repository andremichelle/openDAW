# Script Editor

The script editor lets you write a few lines of TypeScript that create a new project or change the one you have open.
You find it under openDAW menu > Script Editor.

## Writing a script

Every script talks to the global `openDAW` object. A script either starts a new project or loads the open one, edits
it and hands it back to the studio.

```ts
const project = openDAW.newProject("My Project")
project.bpm = 120
const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
synth.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvent({position: 0, duration: PPQN.Quarter, pitch: 60})
project.openInStudio()
```

```ts
const project = await openDAW.getProject()
project.audioUnits.forEach(unit => unit.tracks.forEach(track => track.regions.forEach(region => region.mute = false)))
project.openInStudio()
```

Auto-completion is your guide. Type `project.` and the editor lists everything that is available, with a
short description for each property and method. All times are in PPQN, `PPQN.Bar`, `PPQN.Quarter` and
`PPQN.SemiQuaver` are the constants you probably need most.

The File menu has two starting points, **New Create Script** and **New Edit Script**, with the necessary lines already
in place.

## Running

Press **Run**. A script that creates a project opens it in the studio. A script that edits the open project applies
its changes as a single undo step, so you can take them back with one undo.

## Saving scripts

Scripts are saved in your browser with a name and a description and are included in the [cloud backup](/manuals/cloud-backup).

- **Save** (Cmd/Ctrl + S) and **Save As...** (Cmd/Ctrl + Shift + S) are in the File menu.
- **Scripts** (Cmd/Ctrl + O) opens the list of your scripts, where you can open, rename and delete them.
- **Import Script...** and **Export Script...** read and write plain `.ts` files.

## Examples

The editor comes with example scripts. They show a first melody, an acid line with drums, a generated sample on an
audio track, a wavetable for Nano, an inventory of the open project and a cleanup script. You can delete them, and
newer openDAW versions replace them with updated copies.

## Talking to the studio

Besides building projects, a script can use a few functions of the studio itself.

- `openDAW.showInfo(headline, message)` shows a dialog and waits until it is closed. Use it to report what a script
  did, or to explain why it did nothing.
- `openDAW.hasProject()` tells whether a project is open, so an edit script can stop with a message instead of an error.
  A script may `return` at any point.
- `openDAW.addSample(audioData, name)` turns audio you generated in the script into a sample in your library.
  `AudioData.create(sampleRate, numberOfFrames, numberOfChannels)` gives you the buffers to fill.
- `openDAW.listSamples()` lists the samples in your library, so a script can place existing material.
- `sampleRate` and `baseFrequency` are available as globals, together with helpers such as `midiToHz`, `dbToGain`
  and `gainToDb`.

```ts
if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Count Regions", "No project is open.")
    return
}
const project = await openDAW.getProject()
const regions = project.audioUnits.flatMap(unit => unit.tracks).reduce((sum, track) => sum + track.regions.length, 0)
await openDAW.showInfo("Count Regions", `${project.name} has ${regions} regions.`)
```

```ts
const audioData = AudioData.create(sampleRate, sampleRate, 1)
audioData.frames[0].forEach((_, index, frames) => frames[index] = Math.sin(index * 440 * 2 * Math.PI / sampleRate) * 0.5)
const sample = await openDAW.addSample(audioData, "Sine 440")
const project = openDAW.newProject("Sine")
project.addInstrumentUnit("Tape").audioTracks[0].addRegion(sample, {playback: "no-sync"})
project.openInStudio()
```

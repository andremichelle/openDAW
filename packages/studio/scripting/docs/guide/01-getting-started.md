---
title: Getting Started
group: Guide
order: 1
---

# Getting Started

Open the script editor (openDAW menu > Script Editor). The File menu offers two templates, **New Create Script**
and **New Edit Script**. Press **Run** to execute.

## Two kinds of scripts

A create script builds a project from scratch and opens it in the studio, replacing whatever is open:

```ts
const project = openDAW.newProject("My Project")
project.bpm = 120
// build
project.openInStudio()
```

An edit script loads the open project, changes it and hands it back. All changes land as one undo step:

```ts
const project = await openDAW.getProject()
project.audioUnits.forEach(unit => unit.tracks.forEach(track => track.regions.forEach(region => region.mute = false)))
project.openInStudio()
```

`openDAW.getProject()` throws if nothing is open, check with `await openDAW.hasProject()` first if the script
should stay friendly. If the studio project changed while the script was running, `openInStudio()` refuses with a
toast and nothing is applied.

## The script body

A script is the body of an async function, not a module. `await` works everywhere and `return` ends the script
early. There is no `import`, everything is a global (see [Globals](./08-globals.md)). Types like
`AnyAudioEffect` or `NoteRegion` are available for annotations.

## Reading and writing

Every object in the API is a live facade over the project. Reading a property reads the project, assigning a
property writes it immediately. There is no `save()` and no intermediate model:

```ts
const synth = project.instrumentUnits[0]
synth.volume = -6
synth.instrument.key === "Vaporisateur" && (synth.instrument.cutoff = 2000)
```

Collections (`tracks`, `regions`, `events`, `audioEffects`, ...) are read-only arrays. Add with the `add...`
method of the owner, delete with `remove()` on the item.

## Where things live

```
Project
├── audioUnits            InstrumentAudioUnit | AuxAudioUnit | GroupAudioUnit | OutputAudioUnit
│   ├── instrument        (instrument units only)
│   ├── midiEffects, audioEffects
│   ├── sends
│   └── tracks            NoteTrack | AudioTrack | ValueTrack
│       ├── regions       arrangement
│       └── clips         clip launcher
├── modulators            LFO, Steps, Macro, Random
├── markers, tempoTrack, signatureTrack
└── groove, loop, meta
```

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

## Asking for values

{@link Api.showDialog} opens a dialog and waits for the user. Every field has a name, a type and a start value.
The result holds one value under the name of each field, or it is `null` when the dialog was cancelled.

```ts
const values = await openDAW.showDialog({
    headline: "New Pad",
    okText: "Create",
    fields: {
        name: {type: "text", label: "Name", value: "Pad"},
        voices: {type: "number", label: "Voices", value: 32, min: 1, max: 64, step: 1},
        sound: {type: "section", label: "Sound"},
        attack: {type: "slider", label: "Attack", value: 0.4, min: 0.01, max: 8, step: 0.01, mapping: "exp", unit: "s"},
        zone: {type: "dropdown", label: "Semitones per zone", value: 3,
            options: [{label: "One", value: 1}, {label: "Three", value: 3}, {label: "Six", value: 6}]},
        demo: {type: "checkbox", label: "Demo notes", value: true}
    }
})
if (values === null) {return}
const project = openDAW.newProject(values.name)
```

| Type       | Returns          | Options                                                        |
|------------|------------------|----------------------------------------------------------------|
| `text`     | string           |                                                                |
| `number`   | number           | `min`, `max`, `step`, `unit`                                   |
| `slider`   | number           | `min`, `max` (both required), `step`, `mapping`, `unit`        |
| `checkbox` | boolean          |                                                                |
| `dropdown` | value of a choice | `options`, a list of `{label, value}` with text or number values |
| `section`  | nothing          | a title for the fields below it                                |

A `step` makes the value snap to its multiples. The slider `mapping` is `"linear"`, `"exp"` (finer at the low
end, needs `min` above 0) or `"int"` (whole numbers). A dialog that makes no sense, such as a start value outside
`min` and `max`, throws before it is shown.

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

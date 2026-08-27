A script is a few lines of TypeScript that create a new project or change the one open in the studio. Scripts run
in the script editor (openDAW menu > Script Editor) and talk to the global `openDAW` object.

```ts
const project = openDAW.newProject("Hello")
project.bpm = 120
const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
synth.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvent({position: 0, duration: PPQN.Quarter, pitch: 60})
project.openInStudio()
```

Start with the guide on the left: [Getting Started](./guide/01-getting-started.md), then
[Time and Units](./guide/02-time-and-units.md) and [The Project Tree](./guide/03-project-tree.md). The
[Cookbook](./guide/09-cookbook.md) holds complete scripts. Everything else is the reference, grouped the way the
studio is organised: units, instruments, effects, timeline, modulators.

The entry point is {@link Api}, everything below it hangs off {@link Project}.

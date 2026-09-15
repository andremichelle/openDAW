# Scripting

Scripts run in a worker with a global `openDAW` object (see `src/Api.ts`). A script either builds a new project
(`openDAW.newProject()`) or loads the project currently open in the studio (`await openDAW.getProject()`),
edits it through typed facades and hands it back with `project.openInStudio()`.

### Architecture

* `src/Api.ts` holds the public interfaces with JSDoc. `npm run generate-api` flattens them into
  `src/api.declaration.d.ts`, which the monaco editor in the studio loads for auto-completion.
* `src/impl/` implements every interface as a thin facade over a real `BoxGraph` (`ProjectSkeleton`). There is no
  intermediate model, every getter reads a box field and every setter writes one inside a transaction.
* `src/impl/Fields.ts` binds facade properties to box fields. `src/impl/Guard.ts` validates every write against the
  field constraints of the box schema (ranges clamp, enumerations and types throw with a descriptive message).
* Structural edits (adding devices, tracks, regions, sends, modulators) mirror the studio factories, including
  index bookkeeping, unique names, default tracks and warp markers.
* `src/test/` runs with `vitest`. `Parity.test.ts` walks every device box and asserts that every automatable field
  is reachable through the facade, so a new schema field cannot silently go missing from the API.

### Not covered yet

* Modular audio effects (inaudible in the engine)
* Neural amp models, recording capture settings, MIDI controller mappings, user interface state

# Script Editor

How a TypeScript script in the studio creates or edits a project, how the editor stores scripts, and where the
seams are. Package: `packages/studio/scripting` (`@opendaw/studio-scripting`), page:
`packages/app/studio/src/ui/pages/CodeEditorPage.tsx`, manual: `public/manuals/script-editor.md`.

## Pipeline

1. The editor (monaco, `code-editor/monaco-setup.ts`) compiles the model with `noLib` and two extra libs:
   `library.d.ts` (a hand-written subset of the JS standard library) and `api.declaration.d.ts` (generated).
   `moduleDetection` is forced, so scripts never need `export {}`. TS1108 (top-level `return`) is ignored in the
   editor and filtered from the diagnostics before running, see `code-editor/TopLevelReturn.ts`.
2. The emitted JS goes to `ScriptHost.executeScript`, which posts it to `ScriptWorker.ts`.
3. `ScriptRunner.run` installs `ScriptGlobals` (`openDAW`, `sampleRate`, `baseFrequency`, `PPQN`, `AudioData`,
   dsp helpers, enums) on `globalThis`, strips the `export {};` marker and runs the code as the body of an
   `AsyncFunction`. It is a function body, not a module, so a script may `return` early.
4. The script talks to `ApiImpl`, which builds or loads a `ProjectSkeleton` (a real `BoxGraph`) and hands it back
   through `ScriptHostProtocol`: `openProject(buffer, name)` for new projects, `applyUpdates(updates, checksum)`
   for edits.

## Api and facades

- `src/Api.ts` is the public surface with JSDoc. `npm run generate-api` (`scripts/generate-api.ts`) flattens it
  into `src/api.declaration.d.ts`, the file monaco loads. Helper types used by template literal types
  (`Primitive`, `Reference`, `Shallower`) must stay exported, or `ParameterPath` resolves to `never` in monaco.
- `src/impl/` implements every interface as a facade over box fields. There is no intermediate model: getters
  read fields, setters write them inside a transaction (`Context.edit`). Facades are cached per box in a
  `WeakMap`, so identity is stable across the script.
- `Fields.bind` maps facade properties to box fields, `Guard` validates every write against the schema
  constraints (ranges clamp, enumerations and types throw with a message). Automation value mappings come from
  the TS `*BoxAdapter`s, not from the schema.
- Structural edits (units, devices, tracks, regions, clips, sends, modulators, markers, tempo and signature
  events) mirror the studio factories, including index bookkeeping, unique names and default tracks.
- `AudioFiles` resolves `Sample` and `SoundfontFile` handles to file boxes and deletes orphaned file boxes on
  reassignment.

## Editing is a history step

`ApiImpl.getProject()` fetches the open project (`fetchProject`), decodes it into a fresh graph and calls
`Context.startRecording()`, which remembers the graph checksum and records an `UpdateTask` per committed
transaction. `project.openInStudio()` then sends `applyUpdates(tasks, checksum)` instead of a whole project. The
studio compares the checksum with the live graph, refuses with a toast if the project changed meanwhile, and
replays the tasks inside `project.editing.modify`, so the script's changes are one undo step.
`applyUpdateTasks` lives in `packages/lib/box/src/sync-target.ts`.

## Storage

- `ScriptStorage` (`packages/studio/core/src/scripts/`) keeps scripts in OPFS under
  `scripts/v1/<uuid>/script.ts` and `meta.json` (`ScriptMeta`: name, description, created, modified, `stock`).
  `trash.json` holds tombstones. The class takes a `ScriptFiles` interface so tests run against an in-memory
  fake.
- Stock scripts (`code-editor/StockScripts.ts`, fixed UUIDs, sources from `code-editor/examples/*.ts` with the
  import header stripped) are seeded by `syncStock` when the page opens. `meta.stock` holds an FNV hash of the
  shipped source. A newer build replaces the stored copy, a deleted stock script stays deleted.
- `CloudBackupScripts` is a `CloudBackup` stage: uploads local scripts that are new or newer, asks before deleting
  tombstoned ones in the cloud, downloads missing ones, and asks once before overriding local scripts that are
  newer in the cloud. Stock copies are never overridden from the cloud.

## Editor page

- `ScriptSession` is a module singleton (current script, saved source, suggested name) and outlives the page
  like the monaco model (`MonacoFactory.create` with `keepExisting`), so navigating to the studio and back keeps
  the opened script and its dirty state.
- File menu: New Create Script, New Edit Script (templates in `StockScripts.ScriptTemplates`), Open (⌘O), Save
  (⌘S), Save As (⇧⌘S), Import and Export `.ts`, Manual. Shortcuts are captured on the page container, before
  the monaco container stops propagation.
- `Scripts` dialog (`src/script/ScriptBrowser.tsx`, `ScriptDialogs.tsx`) lists, opens, renames and deletes.
  Double-clicking the script name in the header opens the same meta dialog. Nested dialogs must be appended to
  `Surface.body`, `Surface.flyout` keeps a single child.
- Unsaved changes are confirmed before content is replaced. Save and open show toasts.

## Tests

`packages/studio/scripting/src/test`: `Parity.test.ts` walks every device box and asserts each automatable
field is reachable, `Roundtrip.test.ts` covers encode, delta replay and the checksum guard, `Examples.test.ts`
runs every stock example through esbuild and an `AsyncFunction` against `FakeHost`, `Runner.test.ts` covers the
function-body execution. `packages/studio/core/src/scripts/ScriptStorage.test.ts` covers storage and stock
seeding. Monaco compile problems can be reproduced without the studio: a `noLib` tsconfig with `library.d.ts`,
`api.declaration.d.ts` and the script, `moduleDetection: "force"`.

## Not covered yet

- Modular audio effects, neural amp models, recording capture settings, MIDI controller mappings, UI state.
- Native file pickers (import, export) and a real cloud sync run have not been exercised end to end.
- `library.d.ts` is a subset. When a script needs a standard function the editor does not know, add it there,
  the studio loads the file straight from the package source.

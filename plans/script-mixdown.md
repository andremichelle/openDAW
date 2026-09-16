# Script Mixdown + saveFile

Let a script render the project it holds to audio and hand a file to the user for download.

## API surface

```ts
// Project (Api.ts, @group Core)
mixdown(options?: MixdownOptions): Promise<AudioData>
interface MixdownOptions { sampleRate?: int }          // default 48_000

// Api (global openDAW)
saveFile(data: ArrayBuffer | ArrayBufferView, fileName: string, mimeType?: string): Promise<void>

// ScriptGlobals: add WavFile (lib-dsp), so scripts encode themselves
const audio = await project.mixdown()
await openDAW.saveFile(WavFile.encodeFloats(audio), `${project.name}.wav`, "audio/wav")
```

Design choice: `mixdown()` returns `AudioData`, not a wav buffer. `AudioData` is already the script
currency (`addSample` takes it), so a script can analyse, trim, normalize or re-import the render
before encoding. Encoding is one call via the new `WavFile` global. If a wav-only convenience is
still wanted, add `project.mixdownToWav(): Promise<ArrayBuffer>` on top, one line in ProjectImpl.

`mixdown()` renders the script's own graph (edits included), not the studio project. It does not
require `openInStudio()`. It runs `validate()` first, exactly like `openInStudio()`.

## Mechanics

Scripts run in the worker (`ScriptWorker.ts`), rendering and file dialogs live on the main thread,
so both calls cross `ScriptHostProtocol`.

1. `ScriptHostProtocol` gains
   - `renderMixdown(buffer: ArrayBufferLike, options: MixdownOptions): Promise<AudioData>`
   - `saveFile(buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<void>`
2. `ScriptWorker.ts`: two `dispatchAndReturn` stubs. Both payloads are structured-cloned, not
   transferred, so the script keeps its buffers (a few minutes of stereo 48k is ~50 MB, acceptable).
3. `ProjectImpl.mixdown`: `validate()`, `ProjectSkeleton.encode(boxGraph)` (the project file
   format `Project.load` expects, not the raw `toArrayBuffer`), forward to `renderMixdown`.
4. `ApiImpl.saveFile`: guards. `data` must be `ArrayBuffer` or `ArrayBufferView` (views are sliced to
   their own `ArrayBuffer`), `fileName` non-empty string without `/` or `\`, `mimeType` optional string,
   default `application/octet-stream`.
5. Host (`CodeEditorPage.tsx`):
   - `renderMixdown`: `Project.load(service, buffer)` (runs `ProjectValidation`), suspend
     `service.audioContext` like `StudioService.exportMixdown`, progress dialog with cancel
     (`AbortController`), `OfflineEngineRenderer.start(project, Option.None, progress, signal,
     sampleRate)`, `project.terminate()` in every branch, resume the context, return the audio.
   - `saveFile`: the approve-then-save flow moved from `Mixdowns.ts` into lib-dom as
     `Files.saveWithApproval` (approve dialog gives the user gesture `showSaveFilePicker` needs,
     then `Files.save`). Both call sites use it. Pass
     `types: [{description: mimeType, accept: {[mimeType]: [extensionOf(fileName)]}}]` so the picker
     filters. Skip `types` when the name has no extension.
6. `ScriptHost.executeScript`: do not toast "The script caused an error." for `Errors.isAbort`
   (user cancelled a render or the save picker). The abort still rejects inside the script so a
   script can catch it.

## Files

- `packages/studio/scripting/src/Api.ts`: `MixdownOptions`, `Project.mixdown`, `Api.saveFile`,
  re-export `WavFile`.
- `packages/studio/scripting/src/ScriptRunner.ts`: `WavFile` in `ScriptGlobals`.
- `packages/studio/scripting/src/ScriptHostProtocol.ts`, `ScriptWorker.ts`: protocol + stubs.
- `packages/studio/scripting/src/impl/ProjectImpl.ts`, `impl/ApiImpl.ts`: implementations + guards.
- `packages/app/studio/src/ui/pages/CodeEditorPage.tsx`: host handlers.
- `packages/lib/dom/src/files.ts`: `Files.saveWithApproval`, `Mixdowns.ts` calls it.
- `packages/studio/scripting/src/api.declaration.d.ts`: regenerate (`npm run generate-api`),
  confirm `WavFile.encodeFloats` lands in the Monaco lib (same path as `FFT`/`AudioData`).
- `packages/studio/scripting/docs/guide/06-samples-and-audio.md`: section "Mixdown and saving files".
- `packages/app/studio/src/ui/pages/code-editor/examples/mixdown.ts`: stock example
  (build a short project, mixdown, saveFile as wav).

## Tests (`packages/studio/scripting/src/test`)

- `Fixture.ts`: `renderMixdown` returns silent `AudioData` at the requested rate and records the
  received buffer, `saveFile` records `{byteLength, fileName, mimeType}`.
- `Project.test.ts`: `mixdown()` sends the graph with the script's edits applied (decode the
  received buffer, assert the edit), invalid project rejects before reaching the host, `sampleRate`
  forwarded, default 48_000.
- `Runner.test.ts`: `WavFile` global exists, `saveFile` guard cases (empty name, path separator,
  non-buffer data, view sliced to its own buffer), default mime type.

## Verified in the browser (2026-09-13)

Starter project rendered to `Hello openDAW.wav`, stereo 48k float, 5.9 s, peak at -1 dB after the
example's normalize step, no console errors, transport untouched.

## Verify list

- Script-built project referencing a sample from `addSample` renders with audio (the offline
  renderer resolves samples through the same `service` env as `Mixdowns`, which also renders a
  non-live `Project` copy, so this should hold).
- Two progress dialogs stack while rendering ("Executing Script..." + "Rendering mixdown..."). If
  ugly, terminate the outer one for the duration of the render.
- Empty project: `lastRegionAction()` is 0, the renderer returns a near-empty buffer. Reject in
  `ProjectImpl.mixdown` with `RangeError("Project has no regions")` when no track has regions or
  clips, so scripts get a clear message.
- Cancel in the render dialog and cancel in the save picker both end quietly, no error toast.

## Later

- `MixdownOptions.range: {start: ppqn, end: ppqn}` via `ExportConfiguration.range` (check that
  `countStems` still yields the master pair without stem selection).
- `project.exportStems()` returning one `AudioData` per unit.
- mp3/flac through `FFmpegWorker` behind `saveFile` when `mimeType` is `audio/mpeg`/`audio/flac`.

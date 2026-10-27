# Sample Editor

A destructive sample editor at `opendaw.studio/sample-editor`. It records, edits, applies effects to the sample and reads and writes samples in OPFS. It looks like the studio.

## Decisions

1. Route inside the studio app (`/sample-editor`), next to `/storage` and `/code`. The studio and the loaded project stay alive. The sample to edit is handed over in memory by a `SampleEditorService`, not via the URL.
2. Effects are destructive and are plain TS files that process `AudioData`. No studio devices, no engine. Chosen from a plain list like Audacity, optionally with a parameter dialog.
3. Saving creates a new sample by default. Overwriting the original is optional and asks first, because projects using it will change.
4. Edits and effects are registered in one list so new ones are a single file.
5. Recording is plain recording. No monitoring through effects.
6. Entry points: main menu, sample browser, audio regions and audio clips ("Edit in Sample Editor...").
7. Sample rate and channel count are kept. Import any decodable file, export WAV and FLAC.
8. Desktop only.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Exit] [File ▾] [Undo] [Redo]          Drum Loop 01 (edited) *   48 kHz · Stereo · 0:07.412  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ [●] [Built-in Mic ▾] (Mono|Stereo) ▮▮▮▯ 0:03.2 │ [▶][■][⟲] │ [Cut][Copy][Paste][Del]         │
│ [Crop][Silence] │ [Effects ▾]                                         [−] [+] [Sel] [Fit]    │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▁▂▅▇▅▃▂▁▂▃▅▇▆▄▂▁▁▂▄▆▇▅▃▁▁▂▃▅▇▅ [=========visible=========] ▂▃▅▇▅▃▂▁▂▃▅▆▄▂▁▁▂▃▅▇▅▃▂▁          │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ 0:00         0:01         0:02         0:03         0:04         0:05         0:06           │
│ L ──▂▅█▅▂────────▂▅█▅▂─────░░░░░░░░│░░░░░░░░░░────▂▅█▅▂────────▂▅█▅▂────────▂▅█▅▂──────────  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ R ──▂▅█▅▂────────▂▅█▅▂─────░░░░░░░░│░░░░░░░░░░────▂▅█▅▂────────▂▅█▅▂────────▂▅█▅▂──────────  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Selection 0:02.250 – 0:03.900 (79 200 frames)   Cursor 0:03.100   Zoom 1:512                 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
  ░ selection   │ playhead   ▮ input meter (visible while armed)   * unsaved changes
```

Effects menu and a parameter dialog:

```
[Effects ▾]                  ┌─ Echo ─────────────────────────┐
┌──────────────────┐         │ Delay      [ 250 ] ms          │
│ Amplify...       │         │ Feedback   [  40 ] %           │
│ Normalize...     │         │ Mix        [  35 ] %           │
│ Fade In          │         │                                │
│ Fade Out         │         │              [Cancel]  [Apply] │
│ Reverse          │         └────────────────────────────────┘
│ Convert to Mono  │
│ ──────────────── │
│ Filter...        │
│ Echo...          │
│ Reverb...        │
│ Distortion...    │
└──────────────────┘
```

1. Header: Exit to the workspace, File menu (New, Open Sample..., Import Audio File..., Save, Save As New Sample, Export...), Undo, Redo, sample name, rate, channels, duration.
2. Toolbar: Record, input, Mono/Stereo, input meter and time, Play, Stop, Loop selection, edit buttons, Effects menu, zoom buttons.
3. Overview strip: whole sample with the visible range.
4. Main waveform: one lane per channel, selection, playhead, cursor, time ruler in seconds and samples.
5. Effects menu: a plain list like Audacity. Entries ending with "..." open a parameter dialog, the others apply at once.
6. Status bar: selection range and length, cursor, zoom.
7. Styling reuses studio sass tokens, `colors.sass`, existing buttons, menus and dialogs. No new colours.

## Model

1. `SampleDocument` holds `AudioData`, `SampleMetaData`, origin uuid and a dirty flag.
2. `Selection` is a frame range (start, end) plus optional channel mask. Empty selection means cursor.
3. Peaks are rebuilt after every change with the existing peaks worker, only for the changed range when possible.
4. Undo stores the replaced frame range and its old content (not whole copies), so long samples stay cheap.

## Edits and effects (extendable)

One file per entry, registered in one list. Edits are toolbar buttons, effects are entries in the Effects menu. An effect with parameters shows a dialog first, one without applies at once.

```ts
type SampleParameter = {
    readonly name: string
    readonly min: number
    readonly max: number
    readonly defaultValue: number
    readonly unit: string
}

interface SampleEffect {
    readonly name: string
    readonly parameters: ReadonlyArray<SampleParameter>
    apply(audio: AudioData, selection: Selection, values: ReadonlyArray<number>): AudioData
}
```

1. Edits (v1): Cut, Copy, Paste, Delete, Crop, Silence.
2. Effects (v1): Amplify, Normalize, Fade In, Fade Out, Reverse, Convert to Mono (reuses `AudioMonoConversion.mixdown`), Filter, Echo, Reverb, Distortion.
3. Plain TS over `Float32Array` channels and the sample rate. No studio devices, no engine.
4. Effects apply to the selection, or the whole sample without one. Each apply is one undo step.
5. Effects run in a worker, never on the main thread. A `SampleEffectProtocol` channel on the existing `Workers` messenger (like `Workers.Peak`) takes the selected frames, effect id and values, and returns the processed frames. `AudioData` lives in a SharedArrayBuffer, so nothing is copied across.
6. A progress dialog with Cancel shows while the worker runs. Cancel discards the result, the sample stays untouched.
7. The parameter dialog is generated from `parameters` with the studio's existing dialog and number inputs. Last used values are remembered per effect.
8. Clipboard is page local `AudioData`.
9. Each edit and effect gets unit tests in core (pure functions over `AudioData`), boundary cases included.

## Recording

1. Input device and mono/stereo picker. Uses the studio's `recording-processor` worklet and `RingBuffer` directly, never `RecordingWorklet` (that one stores every take as a sample).
2. Without an open sample a take becomes a new unsaved sample. With one it replaces the selection or is inserted at the cursor. A take at another sample rate opens as a new sample.
3. Input meter and elapsed time while recording. No latency compensation, nothing is played along.

## Storage

1. Open: a sample picker (stock and local samples) or import an audio file (decoded in the editor, not stored). The bare route shows an empty editor.
2. Save As New Sample: new uuid through `SampleService.importFile`, name suffix " (edited)", bpm kept.
3. Save (overwrite): local samples only, confirm dialog naming that projects using it change, same uuid, then the sample loader is invalidated and the open project's file duration updated.
4. Export: WAV/FLAC through the shared `AudioFormatSelector`.
5. The document lives in `SampleEditorService`, so leaving the route keeps it. Replacing it (open, new, import) asks to discard unsaved changes, closing the tab warns.

## Entry points

1. Main menu entry, opens the route with the sample picker.
2. Sample browser context menu (`SampleView.tsx`).
3. Region context menu (`RegionContextMenu.ts`) and clip context menu (`ClipContextMenu.ts`).
4. From a region or clip the service also keeps the file box. Save As offers "Use in Project" via `AudioMonoConversion.replace` (original stays in storage) and sets the new duration.

## Phases

1. Route, layout, open from OPFS, waveform with zoom, scroll, selection, playback. Browser checkpoint.
2. Registry, v1 edits, undo, clipboard, core tests.
3. Save, Save As, Export, import, unsaved prompt.
4. Recording.
5. Effects menu, generated parameter dialog, effect worker with progress and cancel, v1 effects with core tests.
6. Entry points from main menu, sample browser, regions and clips, replace in region.

# Drum Editor

A note editor variant for instruments that map pitches to sounds (Playfield first). Rows show sound names instead of a piano roll. Notes are painted as rounded rects. Everything else (selection, modifiers, property lane, clipboard, step recording, menus, shortcuts) is the existing note editor.

## Current state

1. `NoteEditor.tsx` wires `PitchEditorHeader` + `PianoRoll` (header) and `PitchEditor` (body) around one `PitchPositioner`.
2. The vertical axis is only touched through `PitchPositioner`: `pitchToY`, `yToPitch`, `noteHeight`, `centerNote`, `scrollModel`, `valueAxis`, `subscribe`. Users: `PitchEditor`, `PitchPainter`, `PitchEventCapturing`, `PitchSelectionLocator` (via `valueAxis`), `NoteMoveModifier`, `NoteViewMenu`, `PianoRoll`.
3. `NoteMoveModifier`, `NoteCreateModifier`, `NoteDurationModifier`, `PropertyEditor` work on pitch values and need no change once the axis is abstract.
4. `PlayfieldDeviceBoxAdapter.samples` holds `PlayfieldSampleBoxAdapter`s with `indexField` (= pitch) and `fileLabel`.

## Design

### 1. Rows

The drum view keeps all 128 pitch rows in pitch order, exactly like the piano roll. Pitches without a mapping entry show an empty label. So `PitchPositioner`, `PitchEventCapturing`, `PitchSelectionLocator` and all modifiers are reused unchanged, one row is one pitch in both views.

### 2. Shared painter (studio app)

Split `PitchPainter.ts` into:

- `NoteEventsPainter.ts`: time grid, loop duration, strategy iteration (unselected/selected passes), scroller track marks. Takes the positioner plus two hooks:
  - `paintRows(context, positioner)`: piano = scale/black-key stripes, drum = alternating stripes + mapped/unmapped tint
  - `paintNote(context, rect, style)`: piano = current outline + fill + cent/playCount marks, drum = rounded rect (`roundRect`), same fill colour logic (hue, chance saturation, velocity opacity), playCount ticks kept
- `createNotePitchPainter` becomes the piano configuration of it, output unchanged.

### 3. Editor composition (studio app)

- `PitchEditor.tsx` takes the painter hooks instead of building the piano painter itself. Everything else in it stays.
- New header `DrumRowList.tsx` beside `PianoRoll.tsx`: draws sound names per row (empty when unmapped), highlights live notes via `NoteStreamReceiver`, click/drag auditions via `CaptureMidi` exactly like `PianoRoll`.
- `NoteEditor.tsx` opens the drum view whenever the instrument provides a note mapping, otherwise the piano view. It swaps the header and painter hooks live when the instrument changes or starts/stops providing a mapping. All the remaining wiring (selection, step recording, clipboard, property lane, menus) stays one code path.

### 4. Note mapping protocol (adapters, additive for SDK)

```ts
// packages/studio/adapters/src/NoteMapping.ts
export type NoteMappingEntry = {pitch: byte, label: string}
export interface NoteMapping extends Observable<NoteMapping> {
    entries(): ReadonlyArray<NoteMappingEntry> // sorted by pitch
}
export interface NoteMappingOwner {
    get noteMapping(): Option<NoteMapping>
}
```

- Optional on instruments, found through a type guard `NoteMappingOwner.is(adapter)` (no `in` checks), so existing SDK implementers are untouched.
- Playfield implements it from its sample collection: subscribes to add/remove on `samples` plus each sample's `index` and `file` pointer, notifies once per change, label = `fileLabel`.
- The editor never writes the mapping. Renaming or reassigning happens on the device (Playfield slots).
- Resolution: track -> audio unit -> input instrument adapter.

### 5. Later providers (out of scope)

1. WebCLAP: CLAP `note-name` extension (`clap.note-name`), polled on `changed()` callback.
2. Soundfont: percussion presets (bank 128) via GM drum names.
3. Nano / Tape: single sound, not useful.
4. Scripts (Werkstatt / Apparat): optional `@noteNames` declaration.

## Phases

1. Split painter into `NoteEventsPainter` + piano hooks. No visible change, existing tests green.
2. `NoteMapping` in adapters + Playfield implementation + unit tests (add, remove, re-index, file swap, undo).
3. `DrumRowList`, rounded rect hooks, automatic switch in `NoteEditor`. Browser checkpoint.
4. Manual page section.

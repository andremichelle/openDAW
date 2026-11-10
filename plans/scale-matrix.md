# Scale Matrix

A MIDI effect that quantises every incoming note onto the nearest key of a chosen scale and root key.
A 12x12 grid shows the resulting mapping (incoming pitch class to output pitch class).
Inspired by Ableton's stock Scale MIDI effect, not a clone.

## Reference: Ableton Scale

1. Grid: columns are incoming notes, rows are outgoing notes, one target per column, removed square mutes that note.
2. Base (root), Scale Name (presets or User), Use Current Scale (follows the clip's root and scale).
3. Transpose ±36 st, Fold (keep a mapped note within ±6 st of its source), Lowest + Range (notes outside pass unchanged).

## What we do differently

1. Pure quantiser: every note always lands on the nearest scale key, never muted, never a chord.
2. No hand-edited grid: the grid is derived from scale + root, the user only picks those two.
3. Later: a project-wide root key and scale track, the device then gets a follow-project option.

## Box schema (`ScaleMatrixDeviceBox`, MIDI effect)

1. `root` int32 0..11, automatable.
2. `scale` int32 index into `MidiKeys.StockScales`, automatable.

## Engine (wasm crate `crates/stock-devices/device-scale-matrix`)

1. Template: `device-note-filter` (param binding, held-note replay table of the existing size 64, release_all).
2. Note-on: move the pitch to the nearest key of the scale shifted by root, octave crossing allowed (B to C).
3. Equal distance in both directions (possible with gaps of 2, e.g. pentatonic): quantise down.
4. Result outside 0..127 falls back to the nearest key inside the range.
5. Note-off replays exactly the pitch its note-on produced, so scale or root changes never hang notes.
6. Collisions (two held inputs quantised onto the same output pitch) are reference counted, the note-off goes out with the last one.

## Wiring

1. forge-boxes schema + index, `engine-modules.ts`, `EffectFactories.ts`, `EffectBox.ts`.
2. Adapter in `studio-adapters`, manual URL in `DeviceManualUrls.ts`.
3. Scripting: `MIDIEffects.ts`, `DeviceBoxes.ts`, `Api.ts`, `api.declaration.d.ts`, parity test, docs.

## Editor

1. 12x12 canvas grid in Delay/Gate house style, read-only, black-key rows/columns shaded, root marked.
2. Live input highlight (which column was hit, which row sounded) over the device live-data channel.
3. Controls beside the grid: root, scale dropdown (fixed width).

## Tests

1. core-wasm test like `note-filter.test.ts`: every stock scale x root x all 128 pitches against a TS reference.
2. Ties, octave crossing, edges 0 and 127, collisions, scale/root change while notes are held.

## Phases

1. Schema + wasm crate + tests (no UI, scriptable).
2. Adapter, factories, editor grid.
3. Live highlight, presets, scripting docs.

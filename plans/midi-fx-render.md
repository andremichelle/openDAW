# Render MIDI Effects into the Timeline

## What it does

1. "Render MIDI Effects" bakes what reaches the instrument when the unit plays in real time into one note region.
2. All note regions of the unit's note tracks play from 0 to the project end marker (`TimelineBox.durationInPulses`). Clips are ignored.
3. The result is one new note track with one region that starts at the first incoming note. Its notes are exactly what the MIDI effect chain hands the instrument. Arpeggio, Spielwerk, WebCLAP MIDI effects, random, chance, play-count, effect automation and Zeitgeist grooves are all baked in.
4. A device that keeps producing notes stops at the end marker. Notes still held there end at the marker.
5. Then all old note tracks and all unit-level MIDI effects (with their automation tracks) are deleted. Everything happens in one undo step.
6. Composite instruments: only the unit-level MIDI effects are rendered and removed. Per-layer chains stay untouched.
7. Anything other than notes is dropped.
8. It's available in the track header menu and in the instrument's device menu. It's disabled when the unit has no MIDI effects.

## Phase 1: engine note capture (Rust, no audio)

1. Add a `NoteCapture` consumer in `crates/engine`, modelled on the MIDI Output node's `process_notes` (`midi_output.rs:440`). It sets `PULL.current` to the unit-level chain (source + unit MIDI effects, before any composite layer split), calls `pull_events_into` per block and records the `EventRecord`s.
2. Add a notes-only render mode. It advances the transport and the update clock per quantum, but runs no instruments, audio effects, strips or the mixer. Only the target unit's capture is pulled.
3. Pair note-on and note-off by `id` into `{position, duration, pitch, velocity, cent}`. Drop pitches above 127. Close open notes at the end position.
4. Add an export to start the capture for a unit UUID and an end position, plus a drain export that returns the records.
5. Tests in `crates/engine/src/audio_unit/tests.rs`:
   1. passthrough chain equals the source notes
   2. test MIDI effect output is captured
   3. endless generator stops at the end
   4. held note is cut at the end
   5. composite layer chains are not captured

## Phase 2: offline protocol

1. Add `OfflineEngineRenderer.renderNotes(project, unitUuid, progress, abortSignal)`. It works on a project copy, wraps the same state as `renderSection` (loop area off, marker track off) and renders from 0 to `durationInPulses`.
2. Wait for `queryLoadingComplete` before rendering, so Spielwerk scripts and WebCLAP MIDI effects are loaded.
3. Add a headless test `packages/studio/core-wasm/test/midi-fx-render.test.ts` (load-full-engine harness):
   1. Arpeggio over a chord
   2. Pitch + Velocity
   3. a grooved region
   4. a muted region
   5. bypassed effects

## Phase 3: core command

1. Add a `MidiEffectsRender` in `packages/studio/core/src` (like `AudioUnitFreeze`). It shows a progress dialog with cancel and calls `renderNotes`.
2. Then, in one `editing.modify`:
   1. Create a note track at the index of the first old note track.
   2. Create a `NoteRegionBox` at the first note position. Its duration runs to the end of the last note.
   3. Create a `NoteEventCollectionBox` holding the notes relative to the region. Positions and durations are rounded to int pulses with duration at least 1, play-count 1, chance 100.
   4. Delete all note tracks of the unit.
   5. Delete all unit-level MIDI effect boxes and their automation tracks.
3. If nothing was produced, delete nothing and say so.
4. Add a unit test for the transaction on a project with two note tracks, two MIDI effects and their automation.

## Phase 4: UI

1. Add "Render MIDI Effects" to `TrackHeaderMenu.ts`, next to Freeze.
2. Add the same item to the instrument device menu (`ui/devices/menu-items.ts`).
3. Rebuild the dists, then check in the browser: Arpeggio, Spielwerk, a WebCLAP MIDI effect, undo.

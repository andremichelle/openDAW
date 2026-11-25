# Note input for audio effects

Any audio effect can listen to the notes of a chosen instrument track. First user: Mango (WebCLAP), whose
delays follow played note lengths and pitches. Stock effects ignore the notes and stay bit identical.

## Schema

1. `AudioEffectDeviceAttributes` gets key 6 (reserved until now, so no box ever stored it):
   `{type: "pointer", name: "note-input", pointerType: Pointers.NoteInput, mandatory: false}`.
2. New `Pointers.NoteInput`, accepted by `AudioUnitBox` (instrument units only, enforced in the menu).
3. Every audio effect box gains the field at once. Unset means no notes, which is the state of every existing
   project. Additive for SDK consumers.

## Engine

1. `PluginAudioEffect` gets an optional `pull_chain` and sets `pull.current` around its device call, exactly
   like `PluginInstrument` (today it sets `None`).
2. Wiring resolves `note-input` to the source unit and builds a fresh `NoteSequencer` over its `track_sets`
   (own instance, so the instrument's held note state is untouched). Rebuilt when the pointer or the source
   unit's tracks change. A dangling or non instrument target yields no chain.
3. No graph edge: notes are pulled from tracks, not from audio, so no ordering or cycle concerns.
4. abi `AudioEffect` gains `handle_event` with a no-op default. The effect block loop pulls events and splits at
   them like the instrument loop does. Effects without a chain pull nothing, so their render path is unchanged.
5. `device-wclap` implements `handle_event` with `abi::wclap_note`, as `device-wclap-instrument` does.

## UI

1. A "MIDI Input" menu in the effect editor header, next to the sidechain menu where one exists. Lists the
   project's instrument tracks plus "None".
2. Shown only for effects that take notes: WebCLAP plugins declaring a note input port (the bridge reports it),
   later Werkstatt scripts.

## Later

1. Live notes (keyboard into the source track): register the effect's sequencer in the unit's note signal
   routing (`audio_unit/params.rs` `route_note_signal`).
2. Notes after the source track's MIDI effects: fold its midi chain onto the effect's sequencer.

## Tests

1. Rust: effect with a chain receives the source track's note on/off at the right sample offsets, an effect
   without one renders bit identical to today, retargeting and deleting the source unit.
2. TS: schema round trip of key 6, menu lists instrument units only.

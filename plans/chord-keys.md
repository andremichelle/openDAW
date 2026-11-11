# Chord Keys (MIDI effect)

A MIDI effect that turns single keys into diatonic chords of the current key. Working title "Chord Keys".

## Goal

1. White keys play the chords on degrees I to VII of the key (C = I, D = ii, ... B = vii°).
2. The next octave of white keys plays the same chords one octave higher.
3. Variations (7th, 9th, sus, inversions) come from helper keys played together with a white key.
4. Works live and from the timeline, without added latency and without retriggering notes that keep sounding.

## How other DAWs do it

1. **InstaChord** (W.A. Production): pick a key, white keys play the diatonic chords. A separate key zone or the black keys are modifiers (7th, 9th, sus, dim, inversion). A held modifier changes the chord that plays, and pressing one while a chord sounds changes it at once.
2. **Native Instruments Smart Play** (Komplete Kontrol): a chord mode that follows the chosen scale, so one key plays the diatonic chord. No key combinations, the chord type is a setting.
3. **Cubase Chord Pads**: pads play chords that follow the key. Inversions are mostly picked by a voice leading option (the closest inversion to the previous chord), not by hand.
4. **Logic Chord Trigger, Ableton Chord, Bitwig Multi-Note**: chord from one key with fixed intervals, not scale aware.

## Own device, not a Spielwerk

Spielwerk scripts cannot read the project key. Stock devices read it through `harmony_at` (`crates/abi/src/lib.rs:365`), as Scale Matrix (`crates/stock-devices/device-scale-matrix`) and Arpeggio do. A Spielwerk would need a new script API first. The device follows Scale Matrix: Follow switch (project key at the note's position) or its own root and scale, and a note-off releases exactly the notes its note-on produced. Chord building can reuse `math::harmony` and `crates/voicing`.

## The sequential notes problem

Notes of one gesture arrive one after another, so the device cannot wait for "all keys" without adding latency.

1. **From the timeline**: notes on the same pulse arrive in the same block. They are grouped exactly, no waiting.
2. **Live**: the first key plays its chord at once. When a helper key arrives while the chord key is held, the device computes the new chord and applies only the difference: shared notes keep sounding, dropped notes get a note-off, new notes get a note-on. An added 7th or 9th starts a few milliseconds late, which is not audible, and nothing retriggers.
3. **Helper first**: a helper key that is already held changes the chord the next white key plays.

## Proposed mapping

1. White keys: chord on the degree, in the octave of the key.
2. Black keys: helpers, since they play no chord. For example C# adds the 7th, D# the 9th, F# first inversion, G# second inversion, A# sus. The exact assignment is open.
3. Optional **Voice Leading** switch: picks the inversion closest to the previous chord, so manual inversions are rarely needed.

## Open decisions

1. Helpers on the black keys, or white key combinations (C + D)? White key pairs cannot be told apart from two chords.
2. Does a helper apply only while held, or latch until the next chord?
3. Voice Leading switch, yes or no?
4. Which helper does what (7th, 9th, sus2, sus4, inversions, maybe dim/aug)?
5. Notes per chord as a setting (3 to 5, like the chord track), or only via helpers?
6. Name of the device.

## Phases

1. Decisions above, schema (`ChordKeysDeviceBox`: follow, root, scale, voice leading, chord size), adapter, factory.
2. Crate `device-chord-keys`: degree to chord via `math::harmony`, held-note table (note-on to produced notes), difference re-voicing, native tests (sequential helper, helper first, same-pulse grouping, key change while held, note-off order).
3. Editor (Scale Matrix style), menu, manual page, scripting, parity test, core-wasm engine tests.

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

## Mapping

1. White keys: the triad on the degree (C = I ... B = VII), in the octave of the key. The degree comes from the white key, whatever the root of the key.
2. Black keys are helpers and play no chord:
   1. C# adds the 7th, D# adds the 9th.
   2. F# plays sus2, G# plays sus4.
   3. A# plays the next inversion.
3. **Voice Leading** switch, off by default: picks the inversion closest to the previous chord.

## Decisions (2026-11-11)

1. Helpers sit on the black keys. White key pairs cannot be told apart from two chords.
2. A helper applies only while held, like the chord itself.
3. Voice Leading switch, off by default.
4. Helper assignment as in Mapping 2.
5. No notes-per-chord setting. A triad is the default, the helpers add the 7th and 9th.
6. Name: Chord Keys.

## Still open

1. Scales with fewer than seven steps (pentatonic, blues): which degrees do the white keys get?

## Phases

1. Schema (`ChordKeysDeviceBox`: follow, root, scale, voice leading), adapter, factory.
2. Crate `device-chord-keys`: degree to chord via `math::harmony`, held-note table (note-on to produced notes), difference re-voicing, native tests (sequential helper, helper first, same-pulse grouping, key change while held, note-off order).
3. Editor (Scale Matrix style), menu, manual page, scripting, parity test, core-wasm engine tests.

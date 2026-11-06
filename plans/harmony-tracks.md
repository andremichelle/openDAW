# Harmony Tracks: Key + Chords

Two new primary timeline tracks next to Marker, Signature and Tempo. They make no sound, they describe the harmony
of the song. MIDI devices with "follow project" read the key and chord at the play position. Notes are never rewritten.

## How other DAWs do it

1. Ableton Live 12: scale per clip, scale-aware MIDI effects follow the playing clip, non-destructive.
2. Bitwig 6: one project key, six note devices have "Use Global Key", Grid quantise/scale-step modules, no chord track.
3. Cubase: chord track + scale lane, tracks follow in modes (Chords, Scale, Bass, Auto), destructive.
4. Studio One: chord track, follow modes Scale, Universal, Narrow, Bass, chord detection from parts.
5. Logic Pro: key signature + chord track as global tracks, Session Players follow, tonic of the key as fallback.

## Model

1. Key: root (0..11) + scale. Default C major, used before the first key event and in every existing project.
2. Scale is stored as its 12-bit mask (`MidiKeys.Scale.bits`), never as a list index, so reordering the list is safe.
3. Chord: a scale degree 1..7 relative to the key at the chord's start position.
4. A chord is the triad stacked from the scale (degree, +2, +4 scale steps), so its quality follows the scale.
   C major: 1 C, 2 Dm, 3 Em, 4 F, 5 G, 6 Am, 7 Bdim. Changing the key to F turns 1 into F and 5 into C.
5. Moving a chord into a section with another key renames and re-voices it there. The key at its start decides.
6. Custom chords stay relative to the key: `shift` lowers/raises the degree's root by a semitone, `shape` replaces
   the scale triad with a chord shape (7th, sus, major in minor, ...). In C major B♭ major is "7, shift -1, major",
   moved to F it becomes E♭ major.

## Schema (forge-boxes, additive)

1. `TimelineBox` field 24 `key-track`: `events` field, `index`, `enabled`, default `root` 0 and `scale` major mask.
2. `KeyEventBox`: pointer to the key track, `position` (ppqn), `root` int32 0..11, `scale` int32 mask.
3. `TimelineBox` field 25 `chord-track`: `events` field, `index`, `enabled`.
4. `ChordEventBox`: pointer to the chord track, `position` + `duration` (ppqn), `degree` int32 1..7,
   `shift` int32 -1..1 (0 default), `shape` int32 12-bit mask relative to the chord root (0 = triad from the scale).

## Adapters + harmony lookup (TS)

1. `KeyTrackAdapter`, `KeyEventBoxAdapter`, `ChordTrackAdapter`, `ChordEventBoxAdapter` like the signature adapters.
2. One `Harmony.at(position)` returning key root, scale mask, and (if any) chord degree, chord root, chord mask.
3. The same pure function names chords for the UI ("5 · G") and feeds the engine, tested once.

## Engine (wasm)

1. Engine cell with the key and chord events, bound like `signatures` in `crates/engine/src/lib.rs`.
2. `host_harmony_at(pulse, out)` + `abi::harmony_at(pulse) -> Harmony {root, scale, chord_root, chord_mask}`, like `bar_at`.
3. Native stub returns C major, no chord, so device crate tests run without a host.
4. Rust tests mirror the TS tests (same tables), including key change inside a chord.

## UI

1. Key track: header + body in `ui/timeline/tracks/primary/key`, events show "C Major", context menu picks root and scale.
2. Chord track: blocks with degree + resolved name, drag to move/resize, keys 1..7 set the degree of the selection.
   Context menu offers shift and shape (custom chord). No chord content editor in the first iteration.
3. Both tracks can be shown/hidden like Signature and Tempo, hidden by default in old projects.
4. Chord preview: selecting or changing a chord plays it shortly on the selected instrument.
5. Piano roll: a follow button takes the red invalid-note marking from the key at the cursor position.
6. Fit to key: command that moves selected notes to the nearest key of the key at their position (ties go down,
   same rule as Scale Matrix).
7. Software keyboard: a 1..7 pad row plays the chords of the key at the cursor. While recording, pads write chord events.
8. Detection: command on a MIDI region that writes chord events (notes sounding together matched to chords)
   and suggests a key (most used notes). MIDI only.
9. Key by playing: while the key display in the header has keyboard focus, it listens to incoming notes
   (MIDI inputs and the software keyboard). A played chord is matched (major or minor triad, 7ths) and sets the
   project key: its root as Root, Major or Natural Minor as Scale. One undo step per detected chord, focus out stops it.

## Devices

1. Scale Matrix (`plans/scale-matrix.md`): own root + scale or "follow project", quantises to the current key.
2. Arpeggio "follow chords": plays the chord at the play position without held keys. First chord consumer.
3. Scale Matrix chord mode (snap to chord tones) as a small second step.
4. Scripting: `project.keyTrack` / `project.chordTrack` like `SignatureTrackImpl`, docs.

## Tests

1. Harmony lookup: no events (C major), events at 0, between events, exactly on boundaries, all stock scales x roots.
2. Chords under non-7-note keys yield no chord, chord spanning a key change.
3. Custom chords: shift and shape under every root, B♭ example above survives a key change.
4. Fit to key against the Scale Matrix tables. Detection on hand-built regions with known chords.
5. Old projects load with the default key and no chord track. Undo/redo of key and chord edits.

## Phases

1. Key track: schema, adapters, harmony lookup, UI, piano roll follow, fit to key.
2. Engine harmony lookup + abi + Rust tests.
3. Scale Matrix device with "follow project".
4. Chord track: schema, adapters, UI, custom chords, preview.
5. Chords in the engine lookup, Arpeggio "follow chords".
6. Software keyboard chord pads, recording chord events.
7. Chord and key detection from MIDI regions, key by playing into the focused header key display.
8. Scripting API + docs.

## Status (2026-11-06, branch scales)

1. Phases 1 to 5 implemented and committed (8b2d1990e, e526af38c), partly browser-checked.
2. The key track stores a default key (C major, edited in the header), key events override it from their position.
3. Deviation: Scale Matrix `scale` is an index into `MidiKeys.StockScales` (automatable), the key events store masks.
4. Open from 1 to 5: Scale Matrix live input highlight, Scale Matrix scripting, manual page for the key and chord tracks.

## Later

1. Per-clip key/chord override (Live clip scale, Logic region chords).
2. Audio following chords (pitch shifting).
3. Key signatures in MIDI file export.
4. Voicing options and a chord content editor.
5. Chord suggestions (next chord), floating chord pad window.

## Decisions

1. Chords need a 7-note scale (Major, the three minors, the modes). Under a key with another scale (pentatonic,
   blues, whole tone, diminished) chord events are drawn disabled and devices get the key only, no chord.
2. Key events sit at free ppqn positions, snapped in the UI.

# MIDI 2.0 Clip File import

## Request

Import MIDI 2.0 Clip Files (`SMF2CLIP`, `.midi2`) through the existing Import MIDI File… action of a track, next to Standard MIDI Files (pull request #580).

## Design

- `MidiFileDecoder` checks the eight-byte `SMF2CLIP` signature and hands the rest to `MidiClipFileDecoder`. Standard MIDI Files take the existing path unchanged.
- `MidiClipFileDecoder` reads 32-bit UMP words, sized by the message type. Delta Clockstamp Ticks Per Quarter Note sets the time division, Delta Clockstamps advance the tick position after Start of Clip, End of Clip must be the last packet. A truncated packet or a missing End of Clip throws.
- Note On and Note Off of MIDI 1.0 channel voice (type 2) and MIDI 2.0 channel voice (type 4) messages become `ControlEvent`s. One `MidiTrack` per UMP group, channels inside it as before.
- MIDI 2.0 Note On keeps its 16-bit velocity in `ControlEvent.noteOnVelocity`. A MIDI 2.0 Note On with velocity 0 stays a note, a MIDI 1.0 Note On with velocity 0 stays a note off.
- Tempo, meter and all other messages are skipped, the project supplies tempo and meter.
- `MidiImport` labels regions of a clip file `Grp#<group> Ch#<channel>`, Standard MIDI Files keep `Ch#<channel>`.
- Additive only: `ControlEvent.noteOnVelocity` and `MidiTrack.umpGroup` are optional, existing callers of lib-midi are unaffected.

## Acceptance

- Unit tests (`MidiClipImport.test.ts`): ticks, simultaneous events, groups and 16-bit velocity survive the decode, a tempo packet does not shift the next event, MIDI 1.0 velocity 0 is a note off, truncated and unterminated clips are rejected, the Standard MIDI File decoder is unchanged.
- `test-files/midi2`: the C major scale decodes to eight notes 96 ticks apart, the Petzold minuet `.midi2` decodes to the same note positions as its `.mid` original.

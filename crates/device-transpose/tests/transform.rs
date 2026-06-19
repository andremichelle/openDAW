//! The transpose MIDI-effect transform (driven by the device ABI's `MidiEffect`): every event's pitch is
//! shifted up one octave, the count is preserved, and other fields pass through unchanged.

use abi::{EventRecord, MidiEffect, EVENT_NOTE_ON};
use device_transpose::Transpose;

fn note_on(id: u32, offset: u32, pitch: u32) -> EventRecord {
    EventRecord {offset, kind: EVENT_NOTE_ON, id, pitch, velocity: 0.8, cent: 0.0}
}

#[test]
fn transposes_up_an_octave_preserving_count_and_offset() {
    let input = [note_on(7, 64, 60), note_on(8, 96, 67)];
    let mut output = [EventRecord {offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0}; 8];
    let count = Transpose::transform(&input, &mut output);
    assert_eq!(count, 2);
    assert_eq!(output[0].pitch, 72);
    assert_eq!(output[1].pitch, 79);
    assert_eq!(output[0].offset, 64, "timing is preserved");
    assert_eq!(output[0].id, 7, "identity is preserved");
}

#[test]
fn clamps_at_the_top_of_the_range() {
    let input = [note_on(0, 0, 120)];
    let mut output = [EventRecord {offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0}; 1];
    Transpose::transform(&input, &mut output);
    assert_eq!(output[0].pitch, 127, "transpose past 127 clamps");
}

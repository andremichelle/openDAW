//! The heap-free sine synth core (driven by the device ABI's `EventRecord`s): a note-on produces
//! audio, the onset is sample-accurate (silent before the event's sample offset), and a note-off's
//! release eventually returns to silence.

use abi::{EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_sine::{render, SynthState};

const SR: f32 = 48_000.0;
const FRAMES: usize = 128;

fn empty_state() -> SynthState {
    // The engine hands the device a zeroed state block; mirror that (all voices free).
    unsafe { core::mem::zeroed() }
}

fn note_on(id: u32, offset: u32, pitch: u32) -> EventRecord {
    EventRecord {position: 0.0, offset, kind: EVENT_NOTE_ON, id, pitch, velocity: 1.0, cent: 0.0, duration: 0.0}
}

fn energy(output: &[f32]) -> f32 {
    output.iter().map(|sample| sample * sample).sum()
}

#[test]
fn a_note_on_produces_audio() {
    let mut state = empty_state();
    let (mut left, mut right) = ([0.0f32; FRAMES], [0.0f32; FRAMES]);
    render(&mut state, &[note_on(0, 0, 69)], &mut left, &mut right, SR);
    assert!(energy(&left) > 0.0, "the buffer is no longer silent");
    assert_eq!(left, right, "a mono voice fills both channels identically");
}

#[test]
fn the_onset_is_sample_accurate() {
    let mut state = empty_state();
    let (mut left, mut right) = ([0.0f32; FRAMES], [0.0f32; FRAMES]);
    render(&mut state, &[note_on(0, 64, 69)], &mut left, &mut right, SR);
    assert!(left[..64].iter().all(|sample| *sample == 0.0), "silent before the onset offset");
    assert!(left[64..].iter().any(|sample| sample.abs() > 0.0), "sounding after it");
}

#[test]
fn a_note_off_eventually_returns_to_silence() {
    let mut state = empty_state();
    let (mut left, mut right) = ([0.0f32; FRAMES], [0.0f32; FRAMES]);
    render(&mut state, &[note_on(0, 0, 69)], &mut left, &mut right, SR);
    render(&mut state, &[EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_OFF, id: 0, pitch: 69, velocity: 0.0, cent: 0.0, duration: 0.0}], &mut left, &mut right, SR);
    // render past the 200 ms release tail (200 blocks = ~0.53 s at 48k).
    for _ in 0..200 {
        render(&mut state, &[], &mut left, &mut right, SR);
    }
    assert!(energy(&left) == 0.0, "the voice released to silence");
}

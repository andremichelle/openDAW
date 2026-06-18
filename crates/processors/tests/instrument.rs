//! SineInstrument: a note-on produces sound and a voice, the onset is sample-accurate (silent before
//! its offset), and a note-off's release eventually reclaims the voice.

use processors::buffer::AudioBuffer;
use processors::instrument::SineInstrument;
use processors::sequencer::{NoteLifecycle, TimedNote};

const SR: f32 = 48_000.0;
const QUANTUM: usize = 128;

fn start(id: u64, pitch: u8) -> TimedNote {
    TimedNote {offset: 0, lifecycle: NoteLifecycle::Start {id, pitch, cent: 0.0, velocity: 1.0}}
}

#[test]
fn a_note_on_produces_sound_and_a_voice() {
    let mut instrument = SineInstrument::new(SR);
    let mut out = AudioBuffer::new();
    instrument.process(&[start(0, 69)], &mut out, 0, QUANTUM);
    assert_eq!(instrument.voice_count(), 1);
    assert!(out.left.iter().any(|sample| sample.abs() > 0.0), "the buffer is no longer silent");
    assert!(out.left.iter().zip(out.right.iter()).all(|(left, right)| left == right), "mono note is centered");
}

#[test]
fn the_onset_is_sample_accurate() {
    let mut instrument = SineInstrument::new(SR);
    let mut out = AudioBuffer::new();
    let note = TimedNote {offset: 64, lifecycle: NoteLifecycle::Start {id: 0, pitch: 69, cent: 0.0, velocity: 1.0}};
    instrument.process(&[note], &mut out, 0, QUANTUM);
    assert!(out.left[..64].iter().all(|sample| *sample == 0.0), "silent before the onset offset");
    assert!(out.left[64..].iter().any(|sample| sample.abs() > 0.0), "sounding after it");
}

#[test]
fn a_note_off_releases_the_voice_after_its_tail() {
    let mut instrument = SineInstrument::new(SR);
    let mut out = AudioBuffer::new();
    instrument.process(&[start(0, 69)], &mut out, 0, QUANTUM);
    instrument.process(&[TimedNote {offset: 0, lifecycle: NoteLifecycle::Stop {id: 0}}], &mut out, 0, QUANTUM);
    // render past the 200 ms release tail (~9600 samples = 75 quanta); 200 quanta is comfortably past.
    for _ in 0..200 {
        instrument.process(&[], &mut out, 0, QUANTUM);
    }
    assert_eq!(instrument.voice_count(), 0, "the voice is reclaimed once its release finishes");
}

#[test]
fn two_notes_play_two_voices() {
    let mut instrument = SineInstrument::new(SR);
    let mut out = AudioBuffer::new();
    instrument.process(&[start(0, 60), start(1, 64)], &mut out, 0, QUANTUM);
    assert_eq!(instrument.voice_count(), 2);
}

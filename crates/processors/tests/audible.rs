//! End-to-end audible path (no browser): a looping note region driven through the NoteSequencer into
//! the SineInstrument over a real 128-sample block loop produces recurring audio. This is the Rust
//! proof that notes are audible in a test processor; the worklet/page just feeds the same pieces.

use processors::buffer::AudioBuffer;
use processors::instrument::SineInstrument;
use processors::sequencer::{NoteLifecycle, NoteRegion, NoteSequencer, TimedNote};
use transport::ppqn::samples_to_pulses;
use transport::transport::{Block, RENDER_QUANTUM};
use value::event::EventCollection;
use value::note::NoteEvent;

const SR: f32 = 48_000.0;
const BPM: f32 = 120.0;
const BAR: f64 = 3840.0;

fn energy(buffer: &AudioBuffer) -> f32 {
    buffer.left.iter().map(|sample| sample * sample).sum()
}

fn starts(events: &[TimedNote]) -> usize {
    events.iter().filter(|timed| matches!(timed.lifecycle, NoteLifecycle::Start {..})).count()
}

#[test]
fn a_looping_note_region_produces_recurring_audio() {
    // A 4-bar region looping a 1-bar phrase with a single note (A4) at the start of the bar.
    let region = NoteRegion {position: 0.0, duration: 4.0 * BAR, loop_offset: 0.0, loop_duration: BAR};
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 480.0, 69, 0.0, 1.0));

    let mut sequencer = NoteSequencer::new(SR);
    let mut instrument = SineInstrument::new(SR);
    let pulses_per_quantum = samples_to_pulses(RENDER_QUANTUM as f64, BPM, SR);
    let quanta = (2.0 * BAR / pulses_per_quantum) as usize; // exactly two bars

    let mut position = 0.0;
    let mut total_energy = 0.0;
    let mut note_onsets = 0;
    let mut events = Vec::new();
    for _ in 0..quanta {
        let block = Block {p0: position, p1: position + pulses_per_quantum, s0: 0, s1: RENDER_QUANTUM, bpm: BPM};
        events.clear();
        sequencer.process(&region, &notes, &block, true, false, &mut events);
        events.sort_by_key(|timed| timed.offset); // note-offs before note-ons at the same offset
        note_onsets += starts(&events);
        let mut out = AudioBuffer::new();
        instrument.process(&events, &mut out, 0, RENDER_QUANTUM);
        total_energy += energy(&out);
        position = block.p1;
    }

    assert_eq!(note_onsets, 2, "the 1-bar loop retriggers the note once per bar over two bars");
    assert!(total_energy > 0.1, "the instrument produced audible energy, got {total_energy}");
}

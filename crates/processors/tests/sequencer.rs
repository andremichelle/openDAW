//! NoteSequencer: note starts within a block (one per loop cycle), cross-block retention with the
//! matching note-off, immediate stop-all on a discontinuity / stop, and region looping repeating a
//! note per cycle. Blocks are built consistent with the bpm / sample-rate so sample offsets are real.

use processors::sequencer::{NoteLifecycle, NoteRegion, NoteSequencer, TimedNote};
use transport::ppqn::pulses_to_samples;
use transport::transport::Block;
use value::event::EventCollection;
use value::note::NoteEvent;

const BAR: f64 = 3840.0;
const SR: f32 = 48_000.0;
const BPM: f32 = 120.0;

/// A block spanning `[p0, p1)` with sample bounds derived from the tempo (so offsets are meaningful).
fn block(p0: f64, p1: f64) -> Block {
    let s1 = pulses_to_samples(p1 - p0, BPM, SR) as usize;
    Block {p0, p1, s0: 0, s1, bpm: BPM}
}

fn full_region() -> NoteRegion {
    NoteRegion {position: 0.0, duration: 4.0 * BAR, loop_offset: 0.0, loop_duration: 4.0 * BAR}
}

fn run(seq: &mut NoteSequencer, region: &NoteRegion, notes: &EventCollection<NoteEvent>, block: &Block, playing: bool, discontinuous: bool) -> Vec<TimedNote> {
    let mut out = Vec::new();
    seq.process(region, notes, block, playing, discontinuous, &mut out);
    out
}

fn starts(events: &[TimedNote]) -> Vec<(u8, usize)> {
    events.iter().filter_map(|timed| match timed.lifecycle {
        NoteLifecycle::Start {pitch, ..} => Some((pitch, timed.offset)),
        NoteLifecycle::Stop {..} => None
    }).collect()
}

fn stops(events: &[TimedNote]) -> Vec<u64> {
    events.iter().filter_map(|timed| match timed.lifecycle {
        NoteLifecycle::Stop {id} => Some(id),
        NoteLifecycle::Start {..} => None
    }).collect()
}

#[test]
fn starts_notes_whose_onset_falls_in_the_block() {
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 240.0, 60, 0.0, 0.8));
    notes.add(NoteEvent::new(480.0, 240.0, 62, 0.0, 0.8));
    let mut seq = NoteSequencer::new(SR);
    let events = run(&mut seq, &full_region(), &notes, &block(0.0, 960.0), true, false);
    assert_eq!(starts(&events), vec![(60, 0), (62, pulses_to_samples(480.0, BPM, SR) as usize)]);
    assert_eq!(seq.active_count(), 2);
}

#[test]
fn retains_a_note_across_blocks_and_stops_it_when_complete() {
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 1440.0, 60, 0.0, 0.8)); // completes at 1440
    let mut seq = NoteSequencer::new(SR);
    let first = run(&mut seq, &full_region(), &notes, &block(0.0, 960.0), true, false);
    assert_eq!(starts(&first), vec![(60, 0)]);
    assert!(stops(&first).is_empty(), "still sounding at the end of the first block");
    let second = run(&mut seq, &full_region(), &notes, &block(960.0, 1920.0), true, false);
    assert_eq!(stops(&second), vec![0], "note 0 stops when its span completes");
    assert_eq!(seq.active_count(), 0);
}

#[test]
fn a_discontinuity_stops_all_retained_notes_at_the_block_start() {
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 10_000.0, 60, 0.0, 0.8)); // long note
    let mut seq = NoteSequencer::new(SR);
    run(&mut seq, &full_region(), &notes, &block(0.0, 960.0), true, false);
    assert_eq!(seq.active_count(), 1);
    let wrapped = run(&mut seq, &full_region(), &notes, &block(0.0, 960.0), true, true);
    assert_eq!(stops(&wrapped), vec![0], "loop wrap releases the held note");
    assert_eq!(wrapped[0].offset, 0, "released at the block start");
}

#[test]
fn stopping_transport_releases_all_and_starts_nothing() {
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 10_000.0, 60, 0.0, 0.8));
    let mut seq = NoteSequencer::new(SR);
    run(&mut seq, &full_region(), &notes, &block(0.0, 960.0), true, false);
    let stopped = run(&mut seq, &full_region(), &notes, &block(960.0, 1920.0), false, false);
    assert_eq!(stops(&stopped), vec![0]);
    assert!(starts(&stopped).is_empty(), "no notes start while stopped");
    assert_eq!(seq.active_count(), 0);
}

#[test]
fn a_looping_region_repeats_the_note_per_cycle() {
    // 4-bar region looping a 1-bar phrase with one note at local 0 -> a hit every bar.
    let region = NoteRegion {position: 0.0, duration: 4.0 * BAR, loop_offset: 0.0, loop_duration: BAR};
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 240.0, 60, 0.0, 0.8));
    let mut seq = NoteSequencer::new(SR);
    let events = run(&mut seq, &region, &notes, &block(0.0, 2.0 * BAR), true, false);
    assert_eq!(starts(&events), vec![(60, 0), (60, pulses_to_samples(BAR, BPM, SR) as usize)]);
    assert_eq!(seq.active_count(), 2);
}

#[test]
fn a_block_before_the_region_yields_nothing() {
    let region = NoteRegion {position: 4.0 * BAR, duration: 4.0 * BAR, loop_offset: 0.0, loop_duration: 4.0 * BAR};
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 240.0, 60, 0.0, 0.8));
    let mut seq = NoteSequencer::new(SR);
    let events = run(&mut seq, &region, &notes, &block(0.0, BAR), true, false);
    assert!(events.is_empty());
}

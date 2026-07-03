//! NoteSequencer parity with TS `NoteSequencer.ts`: a note that completes inside the SAME block emits
//! its note-off in that block (the TS re-drain after region processing, "in case they complete in the
//! same block"), and durations follow the `truncateNotesAtRegionEnd` preference (TS default FALSE: a
//! note rings past its region end; TRUE: truncated at the loop-cycle / region end).

use engine_env::block_flags::BlockFlags;
use engine_env::event::Event;
use engine_env::note_event_source::NoteEventSource;
use engine_env::note_region::NoteRegion;
use engine_env::note_region_source::NoteRegionSource;
use engine_env::note_sequencer::NoteSequencer;
use value::event::EventCollection;
use value::note::NoteEvent;

struct OneRegion {
    region: NoteRegion,
    notes: EventCollection<NoteEvent>
}

impl NoteRegionSource for OneRegion {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        if self.region.position < to && self.region.complete() > from {
            visit(&self.region, &self.notes)
        }
    }
}

fn sequencer(region: NoteRegion, notes: &[NoteEvent]) -> NoteSequencer {
    let mut collection = EventCollection::new();
    for note in notes {
        collection.add(*note);
    }
    NoteSequencer::new(Box::new(OneRegion {region, notes: collection}))
}

fn pull(sequencer: &mut NoteSequencer, from: f64, to: f64) -> Vec<Event> {
    let mut events = Vec::new();
    let flags = BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
    sequencer.process_notes(from, to, flags, &mut |event| events.push(event));
    events
}

#[test]
fn a_note_completing_inside_the_block_emits_its_off_in_the_same_block() {
    let region = NoteRegion {position: 0.0, duration: 960.0, loop_offset: 0.0, loop_duration: 960.0};
    let mut sequencer = sequencer(region, &[NoteEvent::new(0.0, 10.0, 60, 0.0, 1.0)]);
    let events = pull(&mut sequencer, 0.0, 480.0);
    assert!(matches!(events.first(), Some(Event::NoteStart {position, ..}) if *position == 0.0), "note-on first: {events:?}");
    assert!(events.iter().any(|event| matches!(event, Event::NoteComplete {position, ..} if *position == 10.0)),
        "the note-off must land in the SAME block at pulse 10 (TS re-drain), got: {events:?}");
}

#[test]
fn by_default_a_note_rings_past_the_region_end() {
    // TS `truncateNotesAtRegionEnd` defaults to FALSE: the note keeps its full duration.
    let region = NoteRegion {position: 0.0, duration: 100.0, loop_offset: 0.0, loop_duration: 100.0};
    let mut sequencer = sequencer(region, &[NoteEvent::new(50.0, 200.0, 60, 0.0, 1.0)]);
    let first = pull(&mut sequencer, 0.0, 100.0);
    assert!(matches!(first.first(), Some(Event::NoteStart {duration, ..}) if *duration == 200.0),
        "the note-on carries the FULL duration: {first:?}");
    let second = pull(&mut sequencer, 100.0, 200.0);
    assert!(second.is_empty(), "no off at the region end: {second:?}");
    let third = pull(&mut sequencer, 200.0, 300.0);
    assert!(third.iter().any(|event| matches!(event, Event::NoteComplete {position, ..} if *position == 250.0)),
        "the off lands at start + duration (250): {third:?}");
}

#[test]
fn truncate_mode_cuts_notes_at_the_loop_cycle_end() {
    // TS truncate mode: `end = min(rawEnd, region.complete)`, so a note near the cycle end is cut there.
    let region = NoteRegion {position: 0.0, duration: 200.0, loop_offset: 0.0, loop_duration: 100.0};
    let mut sequencer = sequencer(region, &[NoteEvent::new(90.0, 50.0, 60, 0.0, 1.0)]);
    sequencer.set_truncate_at_region_end(true);
    let first = pull(&mut sequencer, 0.0, 100.0);
    assert!(matches!(first.first(), Some(Event::NoteStart {position, duration, ..}) if *position == 90.0 && *duration == 10.0),
        "cycle 1 note-on truncated to the cycle end (duration 10): {first:?}");
    // `complete == to` is NOT released in the same block (TS strict `complete < position`), it drains
    // at the start of the next block, still positioned at the cycle end.
    let second = pull(&mut sequencer, 100.0, 200.0);
    assert!(second.iter().any(|event| matches!(event, Event::NoteComplete {position, ..} if *position == 100.0)),
        "cycle 1 off drained at the next block start, positioned at the cycle end: {second:?}");
    assert!(second.iter().any(|event| matches!(event, Event::NoteStart {position, duration, ..} if *position == 190.0 && *duration == 10.0)),
        "cycle 2 re-trigger at 190, again truncated: {second:?}");
    let third = pull(&mut sequencer, 200.0, 300.0);
    assert!(third.iter().any(|event| matches!(event, Event::NoteComplete {position, ..} if *position == 200.0)),
        "cycle 2 off at the region end: {third:?}");
}

//! A launched clip with a groove: its notes move by the groove on the timeline grid the clip cycles on, also
//! when the groove moves them further than one block, and keep their length in truncate mode.

use std::cell::RefCell;
use std::rc::Rc;
use engine_env::block_flags::BlockFlags;
use engine_env::clip_sequencer::ClipSequencer;
use engine_env::event::Event;
use engine_env::note_event_source::NoteEventSource;
use engine_env::note_region::NoteRegion;
use engine_env::note_content_source::{NoteContentSource, NoteTrackAccess};
use engine_env::note_sequencer::NoteSequencer;
use value::event::EventCollection;
use value::note::NoteEvent;

const TRACK: [u8; 16] = [1; 16];
const CLIP: [u8; 16] = [9; 16];
const GROOVE: [u8; 16] = [7; 16];
const LENGTH: f64 = 1_000.0;

struct Content {
    grooved: bool,
    notes: EventCollection<NoteEvent>
}

impl NoteTrackAccess for Content {
    fn for_each_region(&self, _from: f64, _to: f64, _visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {}
    fn clip_info(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {(clip == &CLIP).then_some((LENGTH, true))}
    fn clip_events(&self, clip: &[u8; 16], visit: &mut dyn FnMut(&EventCollection<NoteEvent>)) {
        if clip == &CLIP {visit(&self.notes)}
    }
    fn clip_groove(&self, clip: &[u8; 16]) -> Option<[u8; 16]> {(self.grooved && clip == &CLIP).then_some(GROOVE)}
    // GROOVE moves every position 30 later, six blocks of 5
    fn warp(&self, groove: &[u8; 16], position: f64) -> f64 {if groove == &GROOVE {position + 30.0} else {position}}
    fn unwarp(&self, groove: &[u8; 16], position: f64) -> f64 {if groove == &GROOVE {position - 30.0} else {position}}
}

impl NoteContentSource for Content {
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {visit(&TRACK, self)}
}

// plays three clip cycles in blocks of 5 and returns every note-on with its duration
fn play(grooved: bool, truncate: bool) -> Vec<(f64, f64)> {
    let mut notes = EventCollection::new();
    for step in 0..10 {
        notes.add(NoteEvent::new(step as f64 * 100.0, 10.0, 60, 0.0, 1.0));
    }
    let clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let mut sequencer = NoteSequencer::new(Box::new(Content {grooved, notes}), clips.clone());
    sequencer.set_truncate_at_region_end(truncate);
    clips.borrow_mut().schedule_play(TRACK, CLIP);
    let flags = BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
    let mut starts = Vec::new();
    for block in 0..600 {
        let from = block as f64 * 5.0;
        sequencer.process_notes(from, from + 5.0, flags, &mut |event| {
            if let Event::NoteStart {position, duration, ..} = event {starts.push((position, duration))}
        });
    }
    starts
}

#[test]
fn a_grooved_clip_moves_every_note_by_more_than_a_block() {
    let straight = play(false, false);
    let grooved = play(true, false);
    assert!(straight.len() > 20, "the clip plays: {straight:?}");
    let expected: Vec<(f64, f64)> = straight.iter().map(|(position, duration)| (position + 30.0, *duration))
        .filter(|(position, _)| *position < 3_000.0).collect();
    assert_eq!(grooved, expected);
}

#[test]
fn truncate_mode_keeps_the_length_of_grooved_clip_notes() {
    let grooved = play(true, true);
    assert!(!grooved.is_empty());
    assert!(grooved.iter().all(|(_, duration)| *duration == 10.0), "{grooved:?}");
}

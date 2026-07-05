//! NoteSequencer parity with TS `NoteSequencer.ts`: a note that completes inside the SAME block emits
//! its note-off in that block (the TS re-drain after region processing, "in case they complete in the
//! same block"), and durations follow the `truncateNotesAtRegionEnd` preference (TS default FALSE: a
//! note rings past its region end; TRUE: truncated at the loop-cycle / region end).

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

struct OneRegion {
    region: NoteRegion,
    notes: EventCollection<NoteEvent>
}

impl NoteTrackAccess for OneRegion {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        if self.region.position < to && self.region.complete() > from {
            visit(&self.region, &self.notes)
        }
    }
    fn clip_info(&self, _clip: &[u8; 16]) -> Option<(f64, bool)> {
        None
    }
    fn clip_events(&self, _clip: &[u8; 16], _visit: &mut dyn FnMut(&EventCollection<NoteEvent>)) {}
}

impl NoteContentSource for OneRegion {
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {
        visit(&TRACK, self)
    }
}

fn sequencer(region: NoteRegion, notes: &[NoteEvent]) -> NoteSequencer {
    let mut collection = EventCollection::new();
    for note in notes {
        collection.add(*note);
    }
    NoteSequencer::new(Box::new(OneRegion {region, notes: collection}), Rc::new(RefCell::new(ClipSequencer::new())))
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

#[test]
fn the_chance_roll_stream_matches_the_ts_sequencer_seed() {
    // The first `nextDouble(0, 100)` values of lib-std `Mulberry32(0xFFF_F123)` (computed in node from the
    // TS source). The sequencer's rolls MUST consume this exact stream for TS-WASM parity.
    use math::random::Mulberry32;
    let expected = [
        74.664209992624819f64, 48.376012477092445, 95.600672857835889,
        75.700043095275760, 71.344265271909535, 89.466835046187043
    ];
    let mut random = Mulberry32::new(0xFFF_F123);
    for (index, want) in expected.iter().enumerate() {
        let got = random.next_double(0.0, 100.0);
        assert_eq!(got, *want, "roll {index}");
    }
}

#[test]
fn chance_gates_notes_on_the_seeded_stream() {
    // chance 60 with the 0xFFF_F123 stream: roll 74.66 SKIPS the first pass, roll 48.38 PLAYS the second.
    // (The exact scenario of the Open Up vocal: TS skipped the first pass, the old WASM always played.)
    let region = NoteRegion {position: 0.0, duration: 200.0, loop_offset: 0.0, loop_duration: 100.0};
    let mut note = NoteEvent::new(10.0, 20.0, 60, 0.0, 1.0);
    note.chance = 60.0;
    let mut sequencer = sequencer(region, &[note]);
    let first = pull(&mut sequencer, 0.0, 100.0);
    assert!(!first.iter().any(|event| matches!(event, Event::NoteStart {..})),
        "first pass: roll 74.66 > 60 skips the note: {first:?}");
    let second = pull(&mut sequencer, 100.0, 200.0);
    assert!(second.iter().any(|event| matches!(event, Event::NoteStart {position, ..} if *position == 110.0)),
        "second pass: roll 48.38 <= 60 plays the loop repeat: {second:?}");
}

#[test]
fn chance_100_notes_never_roll_and_always_play() {
    // A chance-100 note must NOT advance the RNG stream (TS short-circuits `chance < 100.0`).
    let region = NoteRegion {position: 0.0, duration: 100.0, loop_offset: 0.0, loop_duration: 100.0};
    let mut gated = NoteEvent::new(50.0, 10.0, 62, 0.0, 1.0);
    gated.chance = 70.0;
    let plain = NoteEvent::new(10.0, 10.0, 60, 0.0, 1.0);
    let mut sequencer = sequencer(region, &[plain, gated]);
    let events = pull(&mut sequencer, 0.0, 100.0);
    assert!(events.iter().any(|event| matches!(event, Event::NoteStart {pitch: 60, ..})), "the plain note always plays");
    assert!(!events.iter().any(|event| matches!(event, Event::NoteStart {pitch: 62, ..})),
        "the gated note consumed the FIRST roll (74.66 > 70 skips): the plain note did not shift the stream");
}

#[test]
fn play_count_ratchets_the_note_linearly() {
    // playCount 4, curve 0 (linear): a 40-pulse note at 10 ratchets every 10 pulses. The window start (0)
    // lands EXACTLY on the pre-note grid point (index -1), which TS's `searchPosition >= searchStart`
    // includes — so the faithful result is FIVE repeats starting at 0 (the grid-aligned phantom), 10, 20,
    // 30, 40, each 10 long.
    let region = NoteRegion {position: 0.0, duration: 100.0, loop_offset: 0.0, loop_duration: 100.0};
    let mut note = NoteEvent::new(10.0, 40.0, 60, 0.0, 1.0);
    note.play_count = 4;
    let mut sequencer = sequencer(region, &[note]);
    let events = pull(&mut sequencer, 0.0, 100.0);
    let starts: Vec<(f64, f64)> = events.iter().filter_map(|event| match event {
        Event::NoteStart {position, duration, ..} => Some((*position, *duration)),
        _ => None
    }).collect();
    assert_eq!(starts.len(), 5, "five repeats incl the grid-aligned pre-note (TS-faithful): {starts:?}");
    for (index, (position, duration)) in starts.iter().enumerate() {
        assert!((position - index as f64 * 10.0).abs() < 1.0e-9, "repeat {index} at {position}");
        assert!((duration - 10.0).abs() < 1.0e-9, "repeat {index} duration {duration}");
    }
}

#[test]
fn a_ratchet_spanning_blocks_retriggers_via_the_lookback() {
    // The note STARTS before the second block's window; the max-duration lookback must still find it so
    // the repeats inside the window fire (TS iterates from `localStart - collection.maxDuration`).
    let region = NoteRegion {position: 0.0, duration: 200.0, loop_offset: 0.0, loop_duration: 200.0};
    let mut note = NoteEvent::new(0.0, 160.0, 60, 0.0, 1.0);
    note.play_count = 4; // repeats at 0, 40, 80, 120
    let mut sequencer = sequencer(region, &[note]);
    let first = pull(&mut sequencer, 0.0, 50.0);
    assert_eq!(first.iter().filter(|event| matches!(event, Event::NoteStart {..})).count(), 2, "repeats 0 + 40: {first:?}");
    let second = pull(&mut sequencer, 50.0, 130.0);
    let starts: Vec<f64> = second.iter().filter_map(|event| match event {
        Event::NoteStart {position, ..} => Some(*position),
        _ => None
    }).collect();
    assert_eq!(starts, vec![80.0, 120.0], "the lookback finds the running ratchet: {second:?}");
}

struct TrackWithClip {
    region: NoteRegion,
    region_notes: EventCollection<NoteEvent>,
    clip_notes: EventCollection<NoteEvent>,
    clip: [u8; 16]
}

impl NoteTrackAccess for TrackWithClip {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        if self.region.position < to && self.region.complete() > from {
            visit(&self.region, &self.region_notes)
        }
    }
    fn clip_info(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {
        (clip == &self.clip).then_some((960.0, true))
    }
    fn clip_events(&self, clip: &[u8; 16], visit: &mut dyn FnMut(&EventCollection<NoteEvent>)) {
        if clip == &self.clip {
            visit(&self.clip_notes)
        }
    }
}

impl NoteContentSource for TrackWithClip {
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {
        visit(&TRACK, self)
    }
}

#[test]
fn a_launched_clip_replaces_the_timeline_at_the_handover() {
    const CLIP: [u8; 16] = [9; 16];
    let clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let mut region_notes = EventCollection::new();
    region_notes.add(NoteEvent::new(3850.0, 10.0, 60, 0.0, 1.0));
    let mut clip_notes = EventCollection::new();
    clip_notes.add(NoteEvent::new(0.0, 10.0, 72, 0.0, 1.0));
    let source = TrackWithClip {
        region: NoteRegion {position: 0.0, duration: 7680.0, loop_offset: 0.0, loop_duration: 7680.0},
        region_notes,
        clip_notes,
        clip: CLIP
    };
    let mut sequencer = NoteSequencer::new(Box::new(source), clips.clone());
    clips.borrow_mut().schedule_play(TRACK, CLIP);
    // The handover lands on the bar (3840): the clip note plays there, the timeline note at 3850 does not.
    let events = pull(&mut sequencer, 3800.0, 3900.0);
    assert!(events.iter().any(|event| matches!(event, Event::NoteStart {pitch: 72, position, ..} if *position == 3840.0)),
        "the clip note starts at the bar: {events:?}");
    assert!(!events.iter().any(|event| matches!(event, Event::NoteStart {pitch: 60, ..})),
        "the timeline is suppressed while the clip plays: {events:?}");
    // The clip cycles at ITS duration (960): the next repetition starts at 4800.
    let events = pull(&mut sequencer, 4790.0, 4810.0);
    assert!(events.iter().any(|event| matches!(event, Event::NoteStart {pitch: 72, position, ..} if *position == 4800.0)),
        "the clip loops at its own duration: {events:?}");
}

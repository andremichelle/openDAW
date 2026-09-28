//! Several sequencers reading ONE track's launched clips with DIFFERENT windows (a composite layer with its
//! own Zeitgeist): the clip machine advances once per block (`advance_clips`), the layers read pure
//! (`ClipRead::Shared`). The default `ClipRead::Advance` path of a leaf unit stays untouched.

use std::cell::RefCell;
use std::rc::Rc;
use engine_env::block_flags::BlockFlags;
use engine_env::clip_sequencer::{Change, ClipSequencer};
use engine_env::event::Event;
use engine_env::note_event_source::NoteEventSource;
use engine_env::note_region::NoteRegion;
use engine_env::note_content_source::{NoteContentSource, NoteTrackAccess};
use engine_env::note_sequencer::{advance_clips, ClipRead, NoteSequencer};
use value::event::EventCollection;
use value::note::NoteEvent;

const TRACK: [u8; 16] = [1; 16];
const CLIP: [u8; 16] = [9; 16];
const BAR: f64 = 3_840.0;
const REGION_PITCH: u8 = 40;
const CLIP_PITCH: u8 = 70;

struct Content {
    region: NoteRegion,
    region_notes: EventCollection<NoteEvent>,
    clip_notes: EventCollection<NoteEvent>
}

impl NoteTrackAccess for Content {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        if self.region.position < to && self.region.complete() > from {
            visit(&self.region, &self.region_notes)
        }
    }
    fn clip_info(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {
        (clip == &CLIP).then_some((BAR, true))
    }
    fn clip_events(&self, clip: &[u8; 16], visit: &mut dyn FnMut(&EventCollection<NoteEvent>)) {
        if clip == &CLIP {
            visit(&self.clip_notes)
        }
    }
}

impl NoteContentSource for Content {
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {
        visit(&TRACK, self)
    }
}

// A region note every 100 pulses over two bars, a clip note every 100 pulses over its one bar.
fn content() -> Content {
    let mut region_notes = EventCollection::new();
    let mut clip_notes = EventCollection::new();
    for step in 0..76 {
        region_notes.add(NoteEvent::new(step as f64 * 100.0, 10.0, REGION_PITCH, 0.0, 1.0));
    }
    for step in 0..38 {
        clip_notes.add(NoteEvent::new(step as f64 * 100.0, 10.0, CLIP_PITCH, 0.0, 1.0));
    }
    let region = NoteRegion {position: 0.0, duration: 2.0 * BAR, loop_offset: 0.0, loop_duration: 2.0 * BAR, mute: false};
    Content {region, region_notes, clip_notes}
}

fn sequencer(clips: &Rc<RefCell<ClipSequencer>>, read: ClipRead) -> NoteSequencer {
    let mut sequencer = NoteSequencer::new(Box::new(content()), clips.clone());
    sequencer.set_clip_read(read);
    sequencer
}

fn starts(sequencer: &mut NoteSequencer, from: f64, to: f64) -> Vec<(f64, u8)> {
    let mut out = Vec::new();
    let flags = BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
    sequencer.process_notes(from, to, flags, &mut |event| {
        if let Event::NoteStart {position, pitch, ..} = event {
            out.push((position, pitch))
        }
    });
    out
}

fn changes(clips: &Rc<RefCell<ClipSequencer>>) -> Vec<([u8; 16], Change)> {
    let mut out = Vec::new();
    clips.borrow_mut().take_changes(&mut |key, change| out.push((*key, change)));
    out
}

const BLOCK: f64 = 64.0;

#[test]
fn an_unshifted_shared_layer_emits_exactly_what_a_leaf_unit_emits() {
    let leaf_clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let shared_clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let mut leaf = sequencer(&leaf_clips, ClipRead::Advance);
    let mut layer = sequencer(&shared_clips, ClipRead::Shared);
    let source = content();
    leaf_clips.borrow_mut().schedule_play(TRACK, CLIP);
    shared_clips.borrow_mut().schedule_play(TRACK, CLIP);
    let mut position = BAR - 10.0 * BLOCK;
    while position < BAR + 10.0 * BLOCK {
        advance_clips(&source, &mut shared_clips.borrow_mut(), position, position + BLOCK, false);
        assert_eq!(starts(&mut layer, position, position + BLOCK), starts(&mut leaf, position, position + BLOCK), "block at {position}");
        position += BLOCK;
    }
    assert_eq!(changes(&shared_clips), changes(&leaf_clips));
}

#[test]
fn layers_with_shifted_windows_hand_over_at_the_same_position_and_the_clip_starts_once() {
    let clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let source = content();
    let mut straight = sequencer(&clips, ClipRead::Shared);
    let mut behind = sequencer(&clips, ClipRead::Shared);
    let mut ahead = sequencer(&clips, ClipRead::Shared);
    clips.borrow_mut().schedule_play(TRACK, CLIP);
    let (mut all_straight, mut all_behind, mut all_ahead) = (Vec::new(), Vec::new(), Vec::new());
    let mut position = BAR - 10.0 * BLOCK;
    while position < BAR + 10.0 * BLOCK {
        advance_clips(&source, &mut clips.borrow_mut(), position, position + BLOCK, false);
        // node-major: every layer reads AFTER the canonical advance, each with its own window
        all_ahead.extend(starts(&mut ahead, position + 45.0, position + BLOCK + 45.0));
        all_straight.extend(starts(&mut straight, position, position + BLOCK));
        all_behind.extend(starts(&mut behind, position - 45.0, position + BLOCK - 45.0));
        position += BLOCK;
    }
    assert_eq!(changes(&clips), [(CLIP, Change::Started)], "three layers, one transition");
    for (label, events) in [("straight", &all_straight), ("behind", &all_behind), ("ahead", &all_ahead)] {
        assert!(!events.is_empty(), "{label} plays");
        for (position, pitch) in events {
            let expected = if *position < BAR { REGION_PITCH } else { CLIP_PITCH };
            assert_eq!(*pitch, expected, "{label}: note at {position} comes from the wrong side of the handover");
        }
    }
    let inside = |events: &Vec<(f64, u8)>, from: f64, to: f64| events.iter().copied()
        .filter(|(position, _)| *position >= from && *position < to).collect::<Vec<_>>();
    let (from, to) = (BAR - 5.0 * BLOCK, BAR + 5.0 * BLOCK);
    assert_eq!(inside(&all_behind, from, to), inside(&all_straight, from, to));
    assert_eq!(inside(&all_ahead, from, to), inside(&all_straight, from, to));
}

#[test]
fn the_default_read_still_advances_by_itself() {
    let clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let mut leaf = NoteSequencer::new(Box::new(content()), clips.clone());
    clips.borrow_mut().schedule_play(TRACK, CLIP);
    starts(&mut leaf, BAR - BLOCK, BAR + BLOCK);
    assert_eq!(changes(&clips), [(CLIP, Change::Started)]);
}

#[test]
fn a_shared_layer_never_advances_by_itself() {
    let clips = Rc::new(RefCell::new(ClipSequencer::new()));
    let mut layer = sequencer(&clips, ClipRead::Shared);
    clips.borrow_mut().schedule_play(TRACK, CLIP);
    starts(&mut layer, BAR - BLOCK, BAR + BLOCK);
    assert!(changes(&clips).is_empty());
}

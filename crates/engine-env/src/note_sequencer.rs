//! The per-audio-unit note sequencer (TS `NoteSequencer`): a `NoteEventSource` that, per block, reads
//! its note regions from a `NoteContentSource`, resolves region looping with `locate_loops`, and emits
//! note-on events with globally-positioned `Event::NoteStart`. Notes that outlast the block are held in
//! one retainer (one per unit, so ids never collide across the unit's regions) and emit `NoteComplete`
//! when their span completes, or immediately on a transport stop / discontinuity (e.g. a loop wrap).
//!
//! RAW notes (live MIDI / on-screen keys, TS `pushRawNoteOn/Off`) and AUDITION notes (fixed-duration
//! previews, TS `auditionNote`) are emitted BEFORE the transport gate, so they sound while stopped too
//! (the paused render keeps the pulse range advancing).

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use math::clamp;
use math::random::Mulberry32;
use value::event::{EventCollection, EventSpan};
use value::note::NoteEvent;
use value::note::{curve_func, inverse_curve_func};
use value::region::locate_loops;
use value::retainer::EventSpanRetainer;
use crate::block_flags::BlockFlags;
use crate::event::Event;
use crate::clip_sequencer::{ClipInfo, ClipKey, ClipSequencer};
use crate::note_event_source::NoteEventSource;
use crate::note_content_source::{NoteContentSource, NoteTrackAccess};

// The chance-roll seed, mirroring TS `NoteSequencer`'s `Random.create(0xFFFF123)` (one stream per
// sequencer instance, seeded at construction, never re-seeded — not even on a transport stop).
const CHANCE_SEED: u32 = 0xFFF_F123;

// A note held across blocks: its GLOBAL span (start + duration, truncated at the cycle / region end
// only in truncate mode), the id matching its note-on, and its pitch (for the note-off).
#[derive(Clone, Copy)]
struct RetainedNote {
    position: f64,
    duration: f64,
    id: u64,
    pitch: u8
}

impl value::event::Event for RetainedNote {
    fn position(&self) -> f64 {
        self.position
    }
}

impl EventSpan for RetainedNote {
    fn duration(&self) -> f64 {
        self.duration
    }
}

// A live (raw) note: gated by the physical key, `running` carries the emitted note-on's id once started
// (mirrors TS `RawNote`).
struct RawNote {
    pitch: u8,
    velocity: f32,
    gate: bool,
    running: Option<u64>
}

// A queued audition note (TS `ScheduledNote`), started at the next block with its fixed duration.
struct ScheduledNote {
    pitch: u8,
    duration: f64,
    velocity: f32
}

pub struct NoteSequencer {
    source: Box<dyn NoteContentSource>,
    clips: Rc<RefCell<ClipSequencer>>,
    retainer: EventSpanRetainer<RetainedNote>,
    raw_notes: Vec<RawNote>,
    audition_queue: Vec<ScheduledNote>,
    audition_retainer: EventSpanRetainer<RetainedNote>,
    random: Mulberry32,
    next_id: u64,
    truncate_at_region_end: Rc<Cell<bool>>
}

impl NoteSequencer {
    pub fn new(source: Box<dyn NoteContentSource>, clips: Rc<RefCell<ClipSequencer>>) -> Self {
        Self {
            source,
            clips,
            retainer: EventSpanRetainer::new(),
            raw_notes: Vec::new(),
            audition_queue: Vec::new(),
            audition_retainer: EventSpanRetainer::new(),
            random: Mulberry32::new(CHANCE_SEED),
            next_id: 0,
            truncate_at_region_end: Rc::new(Cell::new(false))
        }
    }

    /// The TS preference `playback.truncateNotesAtRegionEnd` (default FALSE: a note rings past its
    /// region / loop-cycle end with its full duration).
    pub fn set_truncate_at_region_end(&mut self, value: bool) {
        self.truncate_at_region_end.set(value);
    }

    /// Share the engine's `playback.truncateNotesAtRegionEnd` preference cell, so a live preference
    /// edit reaches every sequencer per block (TS reads `preferences.settings` inside `process`).
    pub fn bind_truncate_preference(&mut self, cell: Rc<Cell<bool>>) {
        self.truncate_at_region_end = cell;
    }
}

impl NoteEventSource for NoteSequencer {
    fn process_notes(&mut self, from: f64, to: f64, flags: BlockFlags, sink: &mut dyn FnMut(Event)) {
        let read = flags.has(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
        let discontinuous = flags.discontinuous();
        if !read || discontinuous {
            self.retainer.drain_all(|retained|
                sink(Event::NoteComplete {id: retained.id, position: from, pitch: retained.pitch}));
        } else {
            self.retainer.drain_linear_completed(to, |retained| {
                let position = clamp(retained.complete(), from, to);
                sink(Event::NoteComplete {id: retained.id, position, pitch: retained.pitch});
            });
        }
        // AUDITION releases (TS: discontinuous -> stop all at `from`, else stop each at its clamped end).
        if discontinuous {
            self.audition_retainer.drain_all(|retained|
                sink(Event::NoteComplete {id: retained.id, position: from, pitch: retained.pitch}));
        } else {
            self.audition_retainer.drain_linear_completed(to, |retained| {
                let position = clamp(retained.complete(), from, to);
                sink(Event::NoteComplete {id: retained.id, position, pitch: retained.pitch});
            });
        }
        // RAW notes: start every note not yet running (infinite duration, released by its note-off), and
        // release + drop every gated-off note. Runs BEFORE the read gate, so live keys sound while stopped.
        let mut index = 0;
        while index < self.raw_notes.len() {
            if self.raw_notes[index].running.is_none() {
                let id = self.next_id;
                self.next_id += 1;
                let (pitch, velocity) = (self.raw_notes[index].pitch, self.raw_notes[index].velocity);
                sink(Event::NoteStart {id, position: from, duration: f64::INFINITY, pitch, cent: 0.0, velocity});
                self.raw_notes[index].running = Some(id);
            }
            if self.raw_notes[index].gate {
                index += 1;
            } else {
                let RawNote {pitch, running, ..} = self.raw_notes.remove(index);
                sink(Event::NoteComplete {id: running.expect("raw note never started"), position: from, pitch});
            }
        }
        // QUEUED auditions replace the currently retained ones (TS: stop all retained at `from`, then start
        // each queued with its fixed duration).
        if !self.audition_queue.is_empty() {
            self.audition_retainer.drain_all(|retained|
                sink(Event::NoteComplete {id: retained.id, position: from, pitch: retained.pitch}));
            for ScheduledNote {pitch, duration, velocity} in self.audition_queue.drain(..) {
                let id = self.next_id;
                self.next_id += 1;
                sink(Event::NoteStart {id, position: from, duration, pitch, cent: 0.0, velocity});
                self.audition_retainer.add_and_retain(RetainedNote {position: from, duration, id, pitch});
            }
        }
        if !read {
            return;
        }
        let truncate = self.truncate_at_region_end.get();
        let Self {source, retainer, random, next_id, clips, ..} = self;
        let mut clips = clips.borrow_mut();
        source.for_each_track(&mut |track, access| {
            let info = LiveClipInfo {access};
            clips.iterate(track, from, to, &info, &mut |section| {
                match section.clip {
                    // Timeline: the track's regions within the section (TS `#processRegions`).
                    None => access.for_each_region(section.from, section.to, &mut |region, notes| {
                        if region.mute {
                            return; // TS `#processRegions`: `region.mute -> continue` — a muted region emits no notes
                        }
                        for cycle in locate_loops(region.position, region.complete(), region.loop_offset, region.loop_duration, section.from, section.to) {
                            // TS: `end = truncateNotesAtRegionEnd ? min(rawEnd, region.complete) : Infinity` — by
                            // default a note keeps its FULL duration and rings past the region / cycle end.
                            let end = if truncate { cycle.raw_end.min(region.complete()) - cycle.raw_start } else { f64::INFINITY };
                            let local_from = cycle.result_start - cycle.raw_start;
                            let local_to = cycle.result_end - cycle.raw_start;
                            process_collection(notes, local_from, local_to, cycle.raw_start, end, retainer, random, next_id, sink);
                        }
                    }),
                    // A launched clip: its collection cycles at the CLIP duration (TS `#processClip`).
                    Some(clip) => {
                        let Some((clip_duration, _)) = access.clip_info(&clip) else { return };
                        access.clip_events(&clip, &mut |notes| {
                            let clip_start = quantize_floor(section.from, clip_duration);
                            let clip_end = clip_start + clip_duration;
                            let truncate_end = if truncate { clip_duration } else { f64::INFINITY };
                            if section.to > clip_end {
                                process_collection(notes, section.from - clip_start, clip_duration, clip_start, truncate_end, retainer, random, next_id, sink);
                                process_collection(notes, 0.0, section.to - clip_end, clip_end, truncate_end, retainer, random, next_id, sink);
                            } else {
                                process_collection(notes, section.from - clip_start, section.to - clip_start, clip_start, truncate_end, retainer, random, next_id, sink);
                            }
                        });
                    }
                }
            });
        });
        drop(clips);
        // TS re-drains after region processing, "in case they complete in the same block".
        retainer.drain_linear_completed(to, |retained| {
            let position = clamp(retained.complete(), from, to);
            sink(Event::NoteComplete {id: retained.id, position, pitch: retained.pitch});
        });
    }

    fn push_raw_note_on(&mut self, pitch: u8, velocity: f32) {
        self.raw_notes.push(RawNote {pitch, velocity, gate: true, running: None});
    }

    // Mirrors TS `pushRawNoteOff`: drop never-started notes while searching; gate off the FIRST started
    // note of that pitch (its note-off is emitted by the next `process_notes`).
    fn push_raw_note_off(&mut self, pitch: u8) {
        let mut index = 0;
        while index < self.raw_notes.len() {
            if self.raw_notes[index].running.is_none() {
                self.raw_notes.remove(index);
            } else if self.raw_notes[index].pitch == pitch {
                self.raw_notes[index].gate = false;
                return;
            } else {
                index += 1;
            }
        }
    }

    fn audition_note(&mut self, pitch: u8, duration: f64, velocity: f32) {
        self.audition_queue.push(ScheduledNote {pitch, duration, velocity});
    }
}

// Bridge the sequencer's live-clip lookups to the track access (duration / loop stay fresh on edits).
struct LiveClipInfo<'a> {
    access: &'a dyn NoteTrackAccess
}

impl ClipInfo for LiveClipInfo<'_> {
    fn resolve(&self, clip: &ClipKey) -> Option<(f64, bool)> {
        self.access.clip_info(clip)
    }
}

fn quantize_floor(value: f64, interval: f64) -> f64 {
    math::floor(value / interval) * interval
}

/// TS `#processCollection`: emit note-ons for `[local_from, local_to)` of a collection placed at
/// `delta`, truncating at the collection-LOCAL `end` (INFINITY = never). The query extends BACK by the
/// collection's longest duration (a ratchet note that started before the window still repeats inside
/// it), and the CHANCE roll advances the seeded stream for EVERY iterated note — even one whose start
/// check then fails — so the roll ORDER is part of the parity contract.
#[allow(clippy::too_many_arguments)]
fn process_collection(notes: &EventCollection<NoteEvent>, local_from: f64, local_to: f64, delta: f64, end: f64,
                      retainer: &mut EventSpanRetainer<RetainedNote>, random: &mut Mulberry32, next_id: &mut u64,
                      sink: &mut dyn FnMut(Event)) {
    for note in notes.iterate_range(local_from - notes.max_duration(), local_to) {
        if note.chance < 100.0 && random.next_double(0.0, 100.0) > note.chance as f64 {
            continue;
        }
        if note.play_count > 1 {
            let duration = note.duration;
            let count = note.play_count as f64;
            let curve = note.play_curve as f64;
            let search_start = inverse_curve_func((local_from - note.position) / duration, curve);
            let search_limit = inverse_curve_func((local_to - note.position) / duration, curve);
            let mut search_index = math::floor(search_start * count);
            let mut search_position = search_index / count;
            while search_position < search_limit {
                if search_position >= search_start {
                    let a = curve_func(search_position, curve) * duration;
                    if a >= duration {
                        break;
                    }
                    let b = curve_func(search_position + 1.0 / count, curve) * duration;
                    let position = delta + note.position + a;
                    let ratchet = b - a;
                    let id = {
                        let value = *next_id;
                        *next_id += 1;
                        value
                    };
                    sink(Event::NoteStart {
                        id,
                        position,
                        duration: ratchet,
                        pitch: note.pitch,
                        cent: note.cent,
                        velocity: note.velocity
                    });
                    retainer.add_and_retain(RetainedNote {position, duration: ratchet, id, pitch: note.pitch});
                }
                search_index += 1.0;
                search_position = search_index / count;
            }
        } else if local_from <= note.position && note.position < local_to {
            let global = delta + note.position;
            let duration = note.duration.min(end - note.position);
            let id = {
                let value = *next_id;
                *next_id += 1;
                value
            };
            sink(Event::NoteStart {
                id,
                position: global,
                duration,
                pitch: note.pitch,
                cent: note.cent,
                velocity: note.velocity
            });
            retainer.add_and_retain(RetainedNote {position: global, duration, id, pitch: note.pitch});
        }
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;
    use super::*;

    struct NoRegions;

    impl NoteContentSource for NoRegions {
        fn for_each_track(&self, _visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {}
    }

    fn sequencer() -> NoteSequencer {
        NoteSequencer::new(Box::new(NoRegions), Rc::new(RefCell::new(ClipSequencer::new())))
    }

    fn stopped() -> BlockFlags {
        BlockFlags::create(false, false, false, false)
    }

    fn playing() -> BlockFlags {
        BlockFlags::create(true, false, true, false)
    }

    fn collect(sequencer: &mut NoteSequencer, from: f64, to: f64, flags: BlockFlags) -> Vec<Event> {
        let mut events = Vec::new();
        sequencer.process_notes(from, to, flags, &mut |event| events.push(event));
        events
    }

    #[test]
    fn raw_note_sounds_while_stopped_and_releases_on_off() {
        let mut sequencer = sequencer();
        sequencer.push_raw_note_on(60, 0.8);
        let started = collect(&mut sequencer, 0.0, 5.0, stopped());
        assert_eq!(started.len(), 1);
        let id = match started[0] {
            Event::NoteStart {id, position, duration, pitch, velocity, ..} => {
                assert_eq!(position, 0.0);
                assert_eq!(duration, f64::INFINITY);
                assert_eq!(pitch, 60);
                assert_eq!(velocity, 0.8);
                id
            }
            _ => panic!("expected a note-start")
        };
        assert!(collect(&mut sequencer, 5.0, 10.0, stopped()).is_empty(), "a running raw note re-emits nothing");
        sequencer.push_raw_note_off(60);
        let released = collect(&mut sequencer, 10.0, 15.0, stopped());
        assert_eq!(released.len(), 1);
        assert!(matches!(released[0], Event::NoteComplete {id: complete, position, pitch: 60}
            if complete == id && position == 10.0));
        assert!(collect(&mut sequencer, 15.0, 20.0, stopped()).is_empty());
    }

    #[test]
    fn raw_note_off_before_first_block_never_sounds() {
        let mut sequencer = sequencer();
        sequencer.push_raw_note_on(60, 0.8);
        sequencer.push_raw_note_off(60);
        assert!(collect(&mut sequencer, 0.0, 5.0, stopped()).is_empty());
    }

    #[test]
    fn raw_note_works_while_playing_too() {
        let mut sequencer = sequencer();
        sequencer.push_raw_note_on(72, 1.0);
        let events = collect(&mut sequencer, 100.0, 105.0, playing());
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Event::NoteStart {position, pitch: 72, ..} if position == 100.0));
    }

    #[test]
    fn audition_note_plays_for_its_duration() {
        let mut sequencer = sequencer();
        sequencer.audition_note(62, 8.0, 0.9);
        let started = collect(&mut sequencer, 0.0, 5.0, stopped());
        assert_eq!(started.len(), 1);
        let id = match started[0] {
            Event::NoteStart {id, position, duration, pitch, ..} => {
                assert_eq!(position, 0.0);
                assert_eq!(duration, 8.0);
                assert_eq!(pitch, 62);
                id
            }
            _ => panic!("expected a note-start")
        };
        let released = collect(&mut sequencer, 5.0, 10.0, stopped());
        assert_eq!(released.len(), 1);
        assert!(matches!(released[0], Event::NoteComplete {id: complete, position, pitch: 62}
            if complete == id && position == 8.0), "the audition stops at its own end position");
        assert!(collect(&mut sequencer, 10.0, 15.0, stopped()).is_empty());
    }

    #[test]
    fn new_audition_replaces_the_running_one() {
        let mut sequencer = sequencer();
        sequencer.audition_note(60, 100.0, 1.0);
        assert_eq!(collect(&mut sequencer, 0.0, 5.0, stopped()).len(), 1);
        sequencer.audition_note(64, 100.0, 1.0);
        let events = collect(&mut sequencer, 5.0, 10.0, stopped());
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], Event::NoteComplete {pitch: 60, position, ..} if position == 5.0));
        assert!(matches!(events[1], Event::NoteStart {pitch: 64, position, ..} if position == 5.0));
    }

    #[test]
    fn discontinuity_stops_the_running_audition() {
        let mut sequencer = sequencer();
        sequencer.audition_note(60, 100.0, 1.0);
        assert_eq!(collect(&mut sequencer, 0.0, 5.0, playing()).len(), 1);
        let events = collect(&mut sequencer, 200.0, 205.0, BlockFlags::create(true, true, true, false));
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], Event::NoteComplete {pitch: 60, position, ..} if position == 200.0));
    }
}

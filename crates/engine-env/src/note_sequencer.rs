//! The per-audio-unit note sequencer (TS `NoteSequencer`): a `NoteEventSource` that, per block, reads
//! its note regions from a `NoteRegionSource`, resolves region looping with `locate_loops`, and emits
//! note-on events with globally-positioned `Event::NoteStart`. Notes that outlast the block are held in
//! one retainer (one per unit, so ids never collide across the unit's regions) and emit `NoteComplete`
//! when their span completes, or immediately on a transport stop / discontinuity (e.g. a loop wrap).
//!
//! Raw (live MIDI) and audition notes from TS are not ported yet (no MIDI input path).

use alloc::boxed::Box;
use math::clamp;
use math::random::Mulberry32;
use value::event::EventSpan;
use value::note::{curve_func, inverse_curve_func};
use value::region::locate_loops;
use value::retainer::EventSpanRetainer;
use crate::block_flags::BlockFlags;
use crate::event::Event;
use crate::note_event_source::NoteEventSource;
use crate::note_region_source::NoteRegionSource;

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

pub struct NoteSequencer {
    source: Box<dyn NoteRegionSource>,
    retainer: EventSpanRetainer<RetainedNote>,
    random: Mulberry32,
    next_id: u64,
    truncate_at_region_end: bool
}

impl NoteSequencer {
    pub fn new(source: Box<dyn NoteRegionSource>) -> Self {
        Self {source, retainer: EventSpanRetainer::new(), random: Mulberry32::new(CHANCE_SEED), next_id: 0, truncate_at_region_end: false}
    }

    /// The TS preference `playback.truncateNotesAtRegionEnd` (default FALSE: a note rings past its
    /// region / loop-cycle end with its full duration).
    pub fn set_truncate_at_region_end(&mut self, value: bool) {
        self.truncate_at_region_end = value;
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
        if !read {
            return;
        }
        let truncate = self.truncate_at_region_end;
        let Self {source, retainer, random, next_id, truncate_at_region_end: _} = self;
        source.for_each_region(from, to, &mut |region, notes| {
            for cycle in locate_loops(region.position, region.complete(), region.loop_offset, region.loop_duration, from, to) {
                // TS: `end = truncateNotesAtRegionEnd ? min(rawEnd, region.complete) : Infinity` — by
                // default a note keeps its FULL duration and rings past the region / cycle end.
                let end = if truncate { cycle.raw_end.min(region.complete()) } else { f64::INFINITY };
                let local_from = cycle.result_start - cycle.raw_start;
                let local_to = cycle.result_end - cycle.raw_start;
                // TS `#processCollection`: the query extends BACK by the collection's longest duration (a
                // ratchet note that started before the window still repeats inside it), and the CHANCE roll
                // advances the seeded stream for EVERY iterated note — even one whose start check then
                // fails — so the roll ORDER is part of the parity contract.
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
                                let position = cycle.raw_start + note.position + a;
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
                        let global = cycle.raw_start + note.position;
                        let duration = note.duration.min(end - global);
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
        });
        // TS re-drains after region processing, "in case they complete in the same block".
        retainer.drain_linear_completed(to, |retained| {
            let position = clamp(retained.complete(), from, to);
            sink(Event::NoteComplete {id: retained.id, position, pitch: retained.pitch});
        });
    }
}

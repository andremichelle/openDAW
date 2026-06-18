//! NoteSequencer, the Rust counterpart of core-processors `NoteSequencer` (focused on the timeline
//! path: a loopable note region backed by a `NoteEvent` collection). Per render block it emits
//! note-on / note-off lifecycle events at sample offsets. Notes whose start falls in the block begin
//! (one per loop cycle the block overlaps); notes retained from earlier blocks end when their span
//! completes, or immediately on a transport stop or position discontinuity (e.g. a loop wrap).
//!
//! Cross-block notes live in an `EventSpanRetainer`, keyed by a monotonic id so note-offs match their
//! note-on. Region looping is resolved with `locate_loops`; note positions are region-local and mapped
//! to the global timeline per cycle.

use alloc::vec::Vec;
use math::clamp;
use transport::ppqn::pulses_to_samples;
use transport::transport::Block;
use value::event::{Event, EventCollection, EventSpan};
use value::note::NoteEvent;
use value::region::locate_loops;
use value::retainer::EventSpanRetainer;

/// A loopable note region on the global timeline. Note positions in its collection are region-local.
#[derive(Clone, Copy, Debug)]
pub struct NoteRegion {
    pub position: f64,
    pub duration: f64,
    pub loop_offset: f64,
    pub loop_duration: f64
}

impl NoteRegion {
    pub fn complete(&self) -> f64 {
        self.position + self.duration
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NoteLifecycle {
    Start {id: u64, pitch: u8, cent: f32, velocity: f32},
    Stop {id: u64}
}

/// A lifecycle event placed at a sample offset within the current render quantum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimedNote {
    pub offset: usize,
    pub lifecycle: NoteLifecycle
}

// A note held across blocks: its GLOBAL span (start + clamped duration) plus the id matching its start.
#[derive(Clone, Copy)]
struct RetainedNote {
    position: f64,
    duration: f64,
    id: u64
}

impl Event for RetainedNote {
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
    retainer: EventSpanRetainer<RetainedNote>,
    sample_rate: f32,
    next_id: u64
}

impl NoteSequencer {
    pub fn new(sample_rate: f32) -> Self {
        Self {retainer: EventSpanRetainer::new(), sample_rate, next_id: 0}
    }

    /// Drop all retained notes (e.g. when re-binding); does not emit stops.
    pub fn reset(&mut self) {
        self.retainer.clear();
    }

    pub fn active_count(&self) -> usize {
        self.retainer.len()
    }

    /// Emit the note lifecycle for `block` into `out`. `playing` gates note starts; `discontinuous`
    /// (a loop wrap / seek) forces every retained note to stop at the block start.
    pub fn process(
        &mut self,
        region: &NoteRegion,
        notes: &EventCollection<NoteEvent>,
        block: &Block,
        playing: bool,
        discontinuous: bool,
        out: &mut Vec<TimedNote>
    ) {
        if !playing || discontinuous {
            for retained in self.retainer.release_all() {
                out.push(TimedNote {offset: block.s0, lifecycle: NoteLifecycle::Stop {id: retained.id}});
            }
        } else {
            for retained in self.retainer.release_linear_completed(block.p1) {
                let offset = self.sample_offset(retained.complete(), block);
                out.push(TimedNote {offset, lifecycle: NoteLifecycle::Stop {id: retained.id}});
            }
        }
        if !playing {
            return;
        }
        for cycle in locate_loops(region.position, region.complete(), region.loop_offset, region.loop_duration, block.p0, block.p1) {
            let local_from = cycle.result_start - cycle.raw_start;
            let local_to = cycle.result_end - cycle.raw_start;
            for note in notes.iterate_range(local_from, local_to) {
                let global = cycle.raw_start + note.position;
                let id = self.fresh_id();
                let offset = self.sample_offset(global, block);
                out.push(TimedNote {
                    offset,
                    lifecycle: NoteLifecycle::Start {id, pitch: note.pitch, cent: note.cent, velocity: note.velocity}
                });
                let duration = clamp(note.duration, 0.0, region.complete() - global);
                self.retainer.add_and_retain(RetainedNote {position: global, duration, id});
            }
        }
    }

    fn fresh_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }


    /// The sample offset within the quantum for a global pulse position, clamped to `[s0, s1]`.
    fn sample_offset(&self, position: f64, block: &Block) -> usize {
        let samples = pulses_to_samples(position - block.p0, block.bpm, self.sample_rate);
        clamp(block.s0 as f64 + samples, block.s0 as f64, block.s1 as f64) as usize
    }
}

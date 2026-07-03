//! NoteEvent, mirroring lib-dsp `notes.ts`. An `EventSpan` (position + duration) carrying MIDI pitch,
//! fine tuning (cent) and velocity. Ordered by position then pitch, matching `NoteEvent.Comparator`
//! (which allows duplicates at the same position + pitch).

use core::cmp::Ordering;
use crate::event::{Event, EventSpan};

#[derive(Clone, Copy, Debug)]
pub struct NoteEvent {
    pub position: f64,   // pulses (ppqn)
    pub duration: f64,   // pulses
    pub pitch: u8,       // MIDI pitch 0..=127
    pub cent: f32,       // fine tuning in cents
    pub velocity: f32,   // 0..=1
    pub chance: f32,     // 0..=100, the per-pass play probability (100 = always)
    pub play_count: i32, // >= 1, repeats within the note span (a ratchet)
    pub play_curve: f32  // the ratchet time-warp curve (0 = linear)
}

impl NoteEvent {
    /// A plain note (always plays, no ratchet); the box reader overrides the performance fields.
    pub fn new(position: f64, duration: f64, pitch: u8, cent: f32, velocity: f32) -> Self {
        Self {position, duration, pitch, cent, velocity, chance: 100.0, play_count: 1, play_curve: 0.0}
    }
}

/// The ratchet time-warp, mirroring lib-dsp `NoteEvent.curveFunc` (all f64 like the TS `**`).
pub fn curve_func(ratio: f64, curve: f64) -> f64 {
    if curve < 0.0 {
        math::pow(ratio, math::pow(2.0, -curve))
    } else {
        1.0 - math::pow(1.0 - ratio, math::pow(2.0, curve))
    }
}

/// The inverse ratchet time-warp, mirroring lib-dsp `NoteEvent.inverseCurveFunc`.
pub fn inverse_curve_func(ratio: f64, curve: f64) -> f64 {
    if curve < 0.0 {
        math::pow(ratio, math::pow(2.0, curve))
    } else {
        1.0 - math::pow(if 1.0 - ratio > 0.0 { 1.0 - ratio } else { 0.0 }, math::pow(2.0, -curve))
    }
}

impl Event for NoteEvent {
    fn position(&self) -> f64 {
        self.position
    }
}

impl EventSpan for NoteEvent {
    fn duration(&self) -> f64 {
        self.duration
    }
}

// NoteEvent.Comparator: by position, then by pitch.
impl PartialEq for NoteEvent {
    fn eq(&self, other: &Self) -> bool {
        self.position == other.position && self.pitch == other.pitch
    }
}

impl Eq for NoteEvent {}

impl PartialOrd for NoteEvent {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for NoteEvent {
    fn cmp(&self, other: &Self) -> Ordering {
        self.position.total_cmp(&other.position).then(self.pitch.cmp(&other.pitch))
    }
}

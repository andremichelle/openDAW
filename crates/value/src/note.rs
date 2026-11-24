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
    pub key: u64,             // the note box uuid folded, the identity of its random decision
    pub chance: f32,          // 0..=100, the per-pass play probability (100 = always)
    pub group: Option<NoteGroup>,
    pub play_count: i32,      // >= 1, repeats within the note span (a ratchet)
    pub play_curve: f32,      // the ratchet time-warp curve (0 = linear)
    pub repeat_length: f32,   // 0..=1, the gate of each repeat (1 = full)
    pub velocity_fade: f32    // -1..=1, the velocity ramp over the repeats (0 = none)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NoteGroup {
    pub key: u64,     // the group box uuid folded
    pub chance: f32,  // 0..=100
    pub play_one: bool
}

impl NoteEvent {
    /// A plain note (always plays, no ratchet); the box reader overrides the performance fields.
    pub fn new(position: f64, duration: f64, pitch: u8, cent: f32, velocity: f32) -> Self {
        Self {
            position, duration, pitch, cent, velocity, key: 0, chance: 100.0, group: None,
            play_count: 1, play_curve: 0.0, repeat_length: 1.0, velocity_fade: 0.0
        }
    }
}

// mirrors TS `NoteEventFeatures.velocityGain`
pub fn velocity_gain(fade: f32, index: i32, count: i32) -> f32 {
    let ratio = if count > 1 { index as f32 / (count - 1) as f32 } else { 0.0 };
    if fade < 0.0 { 1.0 + fade * ratio } else { 1.0 - fade * (1.0 - ratio) }
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

impl crate::event::ExactEq for NoteEvent {
    fn exact_eq(&self, other: &Self) -> bool {
        self.position == other.position && self.duration == other.duration && self.pitch == other.pitch
            && self.cent == other.cent && self.velocity == other.velocity && self.key == other.key
            && self.chance == other.chance && self.group == other.group
            && self.play_count == other.play_count && self.play_curve == other.play_curve
            && self.repeat_length == other.repeat_length && self.velocity_fade == other.velocity_fade
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

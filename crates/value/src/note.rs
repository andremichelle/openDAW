//! NoteEvent, mirroring lib-dsp `notes.ts`. An `EventSpan` (position + duration) carrying MIDI pitch,
//! fine tuning (cent) and velocity. Ordered by position then pitch, matching `NoteEvent.Comparator`
//! (which allows duplicates at the same position + pitch).

use core::cmp::Ordering;
use crate::event::{Event, EventSpan};

#[derive(Clone, Copy, Debug)]
pub struct NoteEvent {
    pub position: f64, // pulses (ppqn)
    pub duration: f64, // pulses
    pub pitch: u8,     // MIDI pitch 0..=127
    pub cent: f32,     // fine tuning in cents
    pub velocity: f32  // 0..=1
}

impl NoteEvent {
    pub fn new(position: f64, duration: f64, pitch: u8, cent: f32, velocity: f32) -> Self {
        Self {position, duration, pitch, cent, velocity}
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

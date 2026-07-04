//! ValueEvent + interpolation, mirroring lib-dsp `value.ts`. A sorted collection of value events is
//! evaluated at any position via `value_at`, interpolating between the surrounding events.

use core::cmp::Ordering;
use math::curve;
use crate::event::{Event, EventCollection};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Interpolation {
    None,
    Linear,
    Curve(f32)
}

impl Interpolation {
    /// Mirrors `Interpolation.Curve`: a slope of exactly 0.5 collapses to `Linear`.
    pub fn curve(slope: f32) -> Self {
        if slope == 0.5 {
            Interpolation::Linear
        } else {
            Interpolation::Curve(slope)
        }
    }
}

// Position is f64 (absolute pulses, can be large); value is f32 (signal/control-path precision).
#[derive(Clone, Copy, Debug)]
pub struct ValueEvent {
    pub position: f64,
    pub index: i32,
    pub value: f32,
    pub interpolation: Interpolation
}

impl ValueEvent {
    pub fn new(position: f64, index: i32, value: f32, interpolation: Interpolation) -> Self {
        Self {position, index, value, interpolation}
    }
}

impl Event for ValueEvent {
    fn position(&self) -> f64 {
        self.position
    }
}

impl crate::event::ExactEq for ValueEvent {
    fn exact_eq(&self, other: &Self) -> bool {
        self.position == other.position && self.index == other.index && self.value == other.value
            && self.interpolation == other.interpolation
    }
}

// Ordering mirrors `ValueEvent.Comparator`: by position, then by index.
impl PartialEq for ValueEvent {
    fn eq(&self, other: &Self) -> bool {
        self.position == other.position && self.index == other.index
    }
}

impl Eq for ValueEvent {}

impl PartialOrd for ValueEvent {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ValueEvent {
    fn cmp(&self, other: &Self) -> Ordering {
        self.position.total_cmp(&other.position).then(self.index.cmp(&other.index))
    }
}

/// Interpolate between events `a` and `b` at position `x` (a.position <= x <= b.position), using
/// `a`'s interpolation mode. Positions are f64 (the fraction is computed there, then cast once to
/// f32); values are f32.
pub fn interpolate(a: &ValueEvent, b: &ValueEvent, x: f64) -> f32 {
    match a.interpolation {
        Interpolation::None => a.value,
        Interpolation::Linear => {
            let fraction = ((x - a.position) / (b.position - a.position)) as f32;
            a.value + fraction * (b.value - a.value)
        }
        Interpolation::Curve(slope) => {
            curve::value_at(slope, (b.position - a.position) as f32, a.value, b.value, (x - a.position) as f32)
        }
    }
}

/// The value at `position` across the sorted events, or `fallback` if there are none. Holds the
/// boundary values before the first / after the last event. Mirrors `ValueEvent.valueAt`.
pub fn value_at(events: &EventCollection<ValueEvent>, position: f64, fallback: f32) -> f32 {
    if events.is_empty() {
        return fallback;
    }
    let floor = events.floor_last_index(position);
    let prev_index = if floor < 0 {0} else {floor as usize};
    let prev = events.at(prev_index).unwrap();
    if prev.position <= position {
        match events.at(prev_index + 1) {
            None => return prev.value,
            Some(next) => {
                if position < next.position {
                    return interpolate(prev, next, position);
                } else if matches!(prev.interpolation, Interpolation::None) {
                    return prev.value;
                }
            }
        }
    }
    prev.value
}

/// The event immediately after `precursor` in the collection, or `None` if it is the last / absent.
pub fn next_event<'a>(events: &'a EventCollection<ValueEvent>, precursor: &ValueEvent) -> Option<&'a ValueEvent> {
    match events.as_slice().binary_search(precursor) {
        Ok(index) => events.at(index + 1),
        Err(_) => None
    }
}

/// Iterate events from `from`, including the first event whose position reaches or passes `to`.
/// Mirrors `iterateWindow`.
pub fn iterate_window(events: &EventCollection<ValueEvent>, from: f64, to: f64) -> impl Iterator<Item = &ValueEvent> {
    let mut stopped = false;
    events.iterate_from(from).take_while(move |event| {
        if stopped {
            return false;
        }
        if event.position >= to {
            stopped = true;
        }
        true
    })
}

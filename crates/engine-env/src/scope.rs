//! A triggered oscilloscope for the UI: a window of the mono signal starting at a rising zero crossing.

use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::Cell;
use crate::telemetry::{broadcast_slot, BroadcastSlot};

// WASM CONTRACT: PlayfieldPads.ScopePoints, the slot holds the points followed by the peak
pub const SCOPE_POINTS: usize = 128;
const WINDOW: usize = 2048; // samples shown, about 43 ms at 48 kHz
const SEARCH: usize = 2048; // the longest period a trigger locks to, about 23 Hz at 48 kHz
const DECIMATION: usize = 4;
const HISTORY: usize = (WINDOW + SEARCH) / DECIMATION;
const CROSSINGS: usize = 512; // covers the whole history up to about 6 kHz
const PICTURE_EVERY: u32 = 4; // quanta between pictures, still faster than the UI frame rate
const HYSTERESIS: f32 = 0.1; // of the trigger peak, the dip below zero that arms a trigger
const PEAK_DECAY: f32 = 0.99; // per quantum
const TRIGGER_CUTOFF: f32 = 150.0; // Hz, the trigger follows the fundamental, not the harmonics

pub struct Scope {
    slot: BroadcastSlot,
    active: Rc<Cell<bool>>,
    was_active: bool,
    history: Vec<f32>, // every DECIMATION-th sample
    crossings: [u32; CROSSINGS], // sample counter, wrapping
    crossing_count: usize,
    counter: u64, // samples seen
    lowpass_coeff: f32,
    lowpass: f32,
    previous_lowpass: f32,
    trigger_peak: f32,
    armed: bool,
    peak: f32,
    countdown: u32
}

impl Scope {
    pub fn new(sample_rate: f32) -> Self {
        Self {slot: broadcast_slot(SCOPE_POINTS + 1), active: Rc::new(Cell::new(false)), was_active: false,
            history: vec![0.0; HISTORY], crossings: [0; CROSSINGS], crossing_count: 0, counter: 0,
            lowpass_coeff: 1.0 - math::exp(-core::f64::consts::TAU * TRIGGER_CUTOFF as f64 / sample_rate as f64) as f32,
            lowpass: 0.0, previous_lowpass: 0.0, trigger_peak: 0.0, armed: false, peak: 0.0, countdown: 0}
    }

    pub fn slot(&self) -> BroadcastSlot {
        self.slot.clone()
    }

    /// Mirrors the UI subscription, a new watch starts from silence.
    pub fn active(&self) -> Rc<Cell<bool>> {
        self.active.clone()
    }

    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        let active = self.active.get();
        if active && !self.was_active {self.clear()}
        self.was_active = active;
        if !active {return}
        self.peak *= PEAK_DECAY;
        self.trigger_peak *= PEAK_DECAY;
        for index in 0..left.len().min(right.len()) {
            let sample = (left[index] + right[index]) * 0.5;
            self.peak = self.peak.max(sample.abs());
            self.lowpass += self.lowpass_coeff * (sample - self.lowpass);
            self.trigger_peak = self.trigger_peak.max(self.lowpass.abs());
            if self.lowpass < -self.trigger_peak * HYSTERESIS {
                self.armed = true;
            } else if self.armed && self.previous_lowpass < 0.0 && self.lowpass >= 0.0 {
                self.crossings[self.crossing_count % CROSSINGS] = self.counter as u32;
                self.crossing_count += 1;
                self.armed = false;
            }
            self.previous_lowpass = self.lowpass;
            if self.counter % DECIMATION as u64 == 0 {
                self.history[(self.counter / DECIMATION as u64) as usize % HISTORY] = sample;
            }
            self.counter += 1;
        }
        if self.countdown > 0 {
            self.countdown -= 1;
            return;
        }
        self.countdown = PICTURE_EVERY - 1;
        let start = self.trigger();
        let mut values = self.slot.borrow_mut();
        for point in 0..SCOPE_POINTS {
            let sample = start + (point * WINDOW / SCOPE_POINTS) as u64;
            let index = (sample / DECIMATION as u64) as usize;
            let fraction = (sample % DECIMATION as u64) as f32 / DECIMATION as f32;
            let (here, next) = (self.history[index % HISTORY], self.history[(index + 1) % HISTORY]);
            values[point] = here + (next - here) * fraction;
        }
        values[SCOPE_POINTS] = self.peak;
    }

    // the latest crossing that still shows a full window
    fn trigger(&self) -> u64 {
        let now = self.counter as u32;
        (0..self.crossing_count.min(CROSSINGS))
            .map(|index| now.wrapping_sub(self.crossings[(self.crossing_count - 1 - index) % CROSSINGS]) as u64)
            .find(|&age| age >= WINDOW as u64 && age <= (WINDOW + SEARCH - DECIMATION) as u64)
            .map_or(self.counter.saturating_sub(WINDOW as u64), |age| self.counter - age)
    }

    fn clear(&mut self) {
        self.history.fill(0.0);
        self.crossing_count = 0;
        self.lowpass = 0.0;
        self.previous_lowpass = 0.0;
        self.trigger_peak = 0.0;
        self.armed = false;
        self.peak = 0.0;
        self.countdown = 0;
        self.slot.borrow_mut().fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(phase: f32, frames: usize) -> Vec<f32> {
        (0..frames).map(|index| math::sin(phase + index as f32 * core::f32::consts::TAU / 96.0)).collect()
    }

    #[test]
    fn a_tone_with_extra_zero_crossings_still_stands_still() {
        let mut scope = Scope::new(48_000.0);
        scope.active().set(true);
        let period = 210.0f32;
        let mut snapshots: Vec<Vec<f32>> = Vec::new();
        for block in 0..200 {
            let signal: Vec<f32> = (0..128).map(|index| {
                let phase = (block * 128 + index) as f32 * core::f32::consts::TAU / period;
                math::sin(phase) + 0.8 * math::sin(3.0 * phase + 1.0)
            }).collect();
            scope.process(&signal, &signal);
            if block >= 150 && block % 4 == 0 {snapshots.push(scope.slot().borrow().to_vec())}
        }
        for snapshot in &snapshots {
            let drift = snapshot.iter().zip(&snapshots[0]).map(|(value, first)| (value - first).abs()).fold(0.0f32, f32::max);
            assert!(drift < 0.1, "the picture stands still, drift {drift}");
        }
    }

    #[test]
    fn an_idle_scope_stays_silent() {
        let mut scope = Scope::new(48_000.0);
        let signal = sine(0.0, 128);
        scope.process(&signal, &signal);
        assert!(scope.slot().borrow().iter().all(|value| *value == 0.0));
    }

    #[test]
    fn a_steady_tone_stands_still() {
        let mut scope = Scope::new(48_000.0);
        scope.active().set(true);
        let mut snapshots: Vec<Vec<f32>> = Vec::new();
        for block in 0..100 {
            let signal = sine(block as f32 * 128.0 * core::f32::consts::TAU / 96.0, 128);
            scope.process(&signal, &signal);
            if block >= 90 {snapshots.push(scope.slot().borrow().to_vec())}
        }
        for snapshot in &snapshots {
            for (point, value) in snapshot.iter().enumerate() {
                assert!((value - snapshots[0][point]).abs() < 0.07, "the picture stands still");
            }
        }
    }
}

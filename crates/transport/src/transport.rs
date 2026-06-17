//! Fixed-bpm transport over a 128-sample render quantum. Mirrors the BlockRenderer block loop for
//! the no-event case (one block per quantum); loop-region splitting + tempo automation come later.

use crate::ppqn::samples_to_pulses;

pub const RENDER_QUANTUM: usize = 128;

/// A processed slice of one quantum: pulse range `[p0, p1)` over sample range `[s0, s1)` at `bpm`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub p0: f64,
    pub p1: f64,
    pub s0: usize,
    pub s1: usize,
    pub bpm: f64,
}

pub struct Transport {
    position: f64, // pulses (ppqn)
    bpm: f64,
    sample_rate: f64,
    playing: bool,
}

impl Transport {
    pub fn new(sample_rate: f64, bpm: f64) -> Self {
        Self {position: 0.0, bpm, sample_rate, playing: false}
    }

    pub fn position(&self) -> f64 {self.position}
    pub fn bpm(&self) -> f64 {self.bpm}
    pub fn sample_rate(&self) -> f64 {self.sample_rate}
    pub fn is_playing(&self) -> bool {self.playing}

    pub fn set_bpm(&mut self, bpm: f64) {self.bpm = bpm}
    pub fn play(&mut self) {self.playing = true}

    pub fn stop(&mut self, reset: bool) {
        self.playing = false;
        if reset {
            self.position = 0.0
        }
    }

    pub fn seek(&mut self, position: f64) {self.position = position}

    /// Advance one 128-sample quantum and return its block. Fixed bpm with no events → exactly one
    /// block spanning the whole quantum (the no-event path of the TS block loop). The per-quantum
    /// accumulation matches TS's `timeInfo.advanceTo` step-by-step.
    pub fn process_quantum(&mut self) -> Block {
        let p0 = self.position;
        let p1 = p0 + samples_to_pulses(RENDER_QUANTUM as f64, self.bpm, self.sample_rate);
        self.position = p1;
        Block {p0, p1, s0: 0, s1: RENDER_QUANTUM, bpm: self.bpm}
    }
}

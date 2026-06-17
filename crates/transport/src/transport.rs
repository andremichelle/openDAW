//! Transport over a 128-sample render quantum. `process_quantum` is the fixed-bpm fast path (one
//! block); `render_quantum` adds tempo automation, splitting the quantum at the tempo-change grid
//! where a tempo map (a `ValueEvent` collection of bpm) changes the bpm. Loop-region + markers are
//! separate build-order items. Mirrors core-processors `BlockRenderer`.

use crate::ppqn::{pulses_to_samples, samples_to_pulses};
use value::event::EventCollection;
use value::value::{value_at, ValueEvent};

pub const RENDER_QUANTUM: usize = 128;

/// Tempo is re-evaluated on this pulse grid (`PPQN.fromSignature(1, 48)` = 80, a ~10 ms window).
pub const TEMPO_CHANGE_GRID: f64 = 80.0;

fn quantize_ceil(position: f64, grid: f64) -> f64 {
    let floored = (position / grid) as i64 as f64;
    if floored * grid < position {
        (floored + 1.0) * grid
    } else {
        floored * grid
    }
}

/// A processed slice of one quantum: pulse range `[p0, p1)` over sample range `[s0, s1)` at `bpm`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub p0: f64,
    pub p1: f64,
    pub s0: usize,
    pub s1: usize,
    pub bpm: f32,
}

pub struct Transport {
    position: f64, // pulses (ppqn) — f64 for sample-accuracy over a long timeline
    bpm: f32,
    sample_rate: f32,
    playing: bool,
}

impl Transport {
    pub fn new(sample_rate: f32, bpm: f32) -> Self {
        Self {position: 0.0, bpm, sample_rate, playing: false}
    }

    pub fn position(&self) -> f64 {self.position}
    pub fn bpm(&self) -> f32 {self.bpm}
    pub fn sample_rate(&self) -> f32 {self.sample_rate}
    pub fn is_playing(&self) -> bool {self.playing}

    pub fn set_bpm(&mut self, bpm: f32) {self.bpm = bpm}
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

    /// Render one quantum into `emit`, splitting at the tempo-change grid where `tempo` (a bpm value
    /// map) changes the bpm. With no / empty tempo map this emits a single fixed-bpm block. Advances
    /// the position and updates the live bpm. Callback-based so the crate stays zero-alloc / no_std.
    pub fn render_quantum<F: FnMut(&Block)>(&mut self, tempo: Option<&EventCollection<ValueEvent>>, mut emit: F) {
        if !self.playing {
            return;
        }
        let mut p0 = self.position;
        let mut s0: usize = 0;
        while s0 < RENDER_QUANTUM {
            let sn = RENDER_QUANTUM - s0;
            let p1 = p0 + samples_to_pulses(sn as f64, self.bpm, self.sample_rate);
            let mut action_position = f64::INFINITY;
            let mut action_bpm: Option<f32> = None;
            if let Some(events) = tempo {
                if !events.is_empty() {
                    let next_grid = quantize_ceil(p0, TEMPO_CHANGE_GRID);
                    if next_grid >= p0 && next_grid < p1 {
                        let tempo_at = value_at(events, next_grid, self.bpm);
                        if tempo_at != self.bpm {
                            action_position = next_grid;
                            action_bpm = Some(tempo_at);
                        }
                    }
                }
            }
            match action_bpm {
                None => {
                    let s1 = s0 + sn;
                    emit(&Block {p0, p1, s0, s1, bpm: self.bpm});
                    p0 = p1;
                    s0 = s1;
                }
                Some(new_bpm) => {
                    if action_position > p0 {
                        let s1 = s0 + pulses_to_samples(action_position - p0, self.bpm, self.sample_rate) as i64 as usize;
                        if s1 > s0 {
                            emit(&Block {p0, p1: action_position, s0, s1, bpm: self.bpm});
                        }
                        p0 = action_position;
                        s0 = s1;
                    }
                    self.bpm = new_bpm;
                }
            }
        }
        self.position = p0;
    }
}

//! Transport over a 128-sample render quantum. `process_quantum` is the fixed-bpm fast path (one
//! block); `render_quantum` is the block loop: it splits the quantum at the nearest action — a
//! tempo-change grid (where a `ValueEvent` bpm map changes the bpm) or the loop-area end. At the loop
//! end it emits the partial block, jumps the position back to the loop start, re-evaluates the bpm
//! there (the discontinuity), and keeps filling the quantum, so a loop wrap is sample-accurate with
//! no gap. Markers are a separate build-order item. Mirrors core-processors `BlockRenderer`.

use engine_env::ppqn::{pulses_to_samples, samples_to_pulses};
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
/// `discontinuous` is true for the first block after a position jump (a loop wrap), the Rust analog
/// of the TS `BlockFlag.discontinuous`, so consumers can release state held across the jump.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub p0: f64,
    pub p1: f64,
    pub s0: usize,
    pub s1: usize,
    pub bpm: f32,
    pub discontinuous: bool,
}

/// The nearest event that splits a sub-block: a bpm change at a tempo grid, or the loop-area end.
enum Action {
    None,
    Tempo(f32),
    Loop,
}

pub struct Transport {
    position: f64,     // pulses (ppqn) — f64 for sample-accuracy over a long timeline
    bpm: f32,          // the live (effective) bpm: the nominal bpm, or the tempo map's value while automating
    nominal_bpm: f32,  // the configured bpm (TimelineBox.bpm); the live bpm when no tempo automation drives it
    sample_rate: f32,
    playing: bool,
    loop_enabled: bool,
    loop_from: f64, // pulses
    loop_to: f64,   // pulses
}

impl Transport {
    pub fn new(sample_rate: f32, bpm: f32) -> Self {
        Self {position: 0.0, bpm, nominal_bpm: bpm, sample_rate, playing: false, loop_enabled: false, loop_from: 0.0, loop_to: 0.0}
    }

    pub fn position(&self) -> f64 {self.position}
    pub fn bpm(&self) -> f32 {self.bpm}
    pub fn sample_rate(&self) -> f32 {self.sample_rate}
    pub fn is_playing(&self) -> bool {self.playing}

    /// Set the configured tempo (TimelineBox.bpm). It becomes the live bpm immediately and the fallback
    /// the tempo map is evaluated against; while automating, the map overrides the live bpm per block.
    pub fn set_bpm(&mut self, bpm: f32) {self.bpm = bpm; self.nominal_bpm = bpm}
    pub fn set_loop_enabled(&mut self, enabled: bool) {self.loop_enabled = enabled}
    pub fn set_loop_from(&mut self, from: f64) {self.loop_from = from}
    pub fn set_loop_to(&mut self, to: f64) {self.loop_to = to}
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
        Block {p0, p1, s0: 0, s1: RENDER_QUANTUM, bpm: self.bpm, discontinuous: false}
    }

    /// Render one quantum into `emit`, splitting at the nearest action: a tempo-grid bpm change from
    /// `tempo` (a bpm value map), or the loop-area end. With no events and no loop this emits a single
    /// fixed-bpm block. Advances the position and updates the live bpm. Callback-based so the crate
    /// stays zero-alloc / no_std. The block after a loop wrap carries `discontinuous = true` so
    /// sequencers can release notes held across the wrap.
    pub fn render_quantum<F: FnMut(&Block)>(&mut self, tempo: Option<&EventCollection<ValueEvent>>, mut emit: F) {
        if !self.playing {
            return;
        }
        let mut p0 = self.position;
        let mut s0: usize = 0;
        let mut discontinuous = false;
        self.eval_tempo(tempo, p0);
        while s0 < RENDER_QUANTUM {
            let sn = RENDER_QUANTUM - s0;
            let p1 = p0 + samples_to_pulses(sn as f64, self.bpm, self.sample_rate);
            let mut action_position = f64::INFINITY;
            let mut action = Action::None;
            if let Some(events) = tempo {
                if !events.is_empty() {
                    let next_grid = quantize_ceil(p0, TEMPO_CHANGE_GRID);
                    if next_grid >= p0 && next_grid < p1 {
                        let tempo_at = value_at(events, next_grid, self.bpm);
                        if tempo_at != self.bpm {
                            action_position = next_grid;
                            action = Action::Tempo(tempo_at);
                        }
                    }
                }
            }
            // The loop wins ties (`<=`): when a tempo grid lands exactly on `loop_to` (common, since
            // loop ends are usually bar-aligned and the grid divides a bar), applying the tempo change
            // there would advance the position onto `loop_to` and the wrap (`p0 < loop_to`) would never
            // fire. Wrapping first is correct anyway — bpm is re-evaluated at the loop start.
            if self.loop_enabled
                && self.loop_from < self.loop_to
                && p0 < self.loop_to
                && self.loop_to <= p1
                && self.loop_to <= action_position
            {
                action_position = self.loop_to;
                action = Action::Loop;
            }
            match action {
                Action::None => {
                    let s1 = s0 + sn;
                    emit(&Block {p0, p1, s0, s1, bpm: self.bpm, discontinuous});
                    discontinuous = false;
                    p0 = p1;
                    s0 = s1;
                }
                Action::Tempo(new_bpm) => {
                    let s1 = self.emit_until(action_position, p0, s0, discontinuous, &mut emit);
                    if s1 > s0 {
                        discontinuous = false; // a real block carried the flag; later blocks are continuous
                    }
                    s0 = s1;
                    p0 = action_position;
                    self.bpm = new_bpm;
                }
                Action::Loop => {
                    // the partial block up to the loop end carries the current flag; the next block,
                    // resuming at the loop start, is the discontinuity.
                    s0 = self.emit_until(action_position, p0, s0, discontinuous, &mut emit);
                    p0 = self.loop_from;
                    self.eval_tempo(tempo, p0);
                    discontinuous = true;
                }
            }
        }
        self.position = p0;
    }

    /// Emit the block from `p0` to `action_position` (if it spans any samples) and return the new
    /// sample cursor. Shared by the tempo-change and loop-wrap splits.
    fn emit_until<F: FnMut(&Block)>(&self, action_position: f64, p0: f64, s0: usize, discontinuous: bool, emit: &mut F) -> usize {
        let s1 = s0 + pulses_to_samples(action_position - p0, self.bpm, self.sample_rate) as i64 as usize;
        if s1 > s0 {
            emit(&Block {p0, p1: action_position, s0, s1, bpm: self.bpm, discontinuous});
        }
        s1
    }

    /// Set the live bpm at `position`: the tempo map's value when automating (falling back to the
    /// nominal bpm), otherwise the nominal bpm itself. So with no tempo map the live bpm is always the
    /// configured `TimelineBox.bpm`, with no stale value left over from a previous automated pass.
    fn eval_tempo(&mut self, tempo: Option<&EventCollection<ValueEvent>>, position: f64) {
        self.bpm = match tempo {
            Some(events) if !events.is_empty() => value_at(events, position, self.nominal_bpm),
            _ => self.nominal_bpm
        };
    }
}

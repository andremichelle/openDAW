//! The tempo map: converts a PPQN interval to REAL seconds, integrating over tempo automation (the engine
//! port of the TS `TempoMap.intervalToSeconds`, matching `VaryingTempoMap` / `TempoGridCursor`). The audio
//! region player needs this for NO-STRETCH (NoWarp) playback: the source plays at native real-time speed, so
//! the file read offset at a timeline pulse is `intervalToSeconds(loopOrigin, pulse) * sourceRate`. Under a
//! tempo RAMP a single block's bpm cannot describe the whole elapsed interval (using it makes the read offset
//! balloon as bpm drops — the sample races ahead while the tempo falls), so the interval must be integrated
//! across the tempo grid, exactly as the transport advances time.
//!
//! Tempo is sampled as a STEP function on `TEMPO_CHANGE_GRID` (the same grid the transport splits blocks on):
//! constant within each grid cell, evaluated at the cell's grid-aligned start via the live tempo `ValueCurve`
//! (so an edit to the automation is reflected without any rebuild). With no automation it is a constant tempo
//! map (`pulses_to_seconds(to - from, nominal_bpm)`).

use alloc::rc::Rc;
use core::cell::RefCell;
use bindings::value_collection::ValueCurve;
use dsp::ppqn::{pulses_to_seconds, seconds_to_pulses};
use math::floor;
use transport::transport::TEMPO_CHANGE_GRID;

/// The engine's tempo map, shared (the engine keeps it current; the audio region player reads it at render).
/// `curve` is `Some` only while tempo automation is enabled AND non-empty — otherwise the map is the constant
/// `nominal_bpm` (the configured `TimelineBox.bpm`).
pub(crate) struct TempoMap {
    curve: Option<ValueCurve>,
    nominal_bpm: f32
}

pub(crate) type SharedTempoMap = Rc<RefCell<TempoMap>>;

impl TempoMap {
    pub(crate) fn new() -> Self {
        Self {curve: None, nominal_bpm: 120.0}
    }

    /// Refresh the live state (called by the engine each render, off the audio-read path): the configured bpm,
    /// and the automation curve when it is enabled and present, else `None` (constant tempo).
    pub(crate) fn update(&mut self, nominal_bpm: f32, curve: Option<ValueCurve>) {
        self.nominal_bpm = nominal_bpm;
        self.curve = curve;
    }

    /// Real seconds elapsed across the pulse interval `[from, to)`, integrated over the tempo grid. With no
    /// automation this is the constant-tempo `pulses_to_seconds(to - from, nominal_bpm)`.
    pub(crate) fn interval_to_seconds(&self, from: f64, to: f64) -> f64 {
        if to <= from {
            return 0.0;
        }
        let nominal = self.nominal_bpm;
        match &self.curve {
            None => pulses_to_seconds(to - from, nominal),
            Some(curve) => integrate(from, to, |position| curve.value_at(position, nominal))
        }
    }

    /// Real seconds at pulse `position` (TS `TempoMap.ppqnToSeconds`): the elapsed time from the timeline origin.
    pub(crate) fn ppqn_to_seconds(&self, position: f64) -> f64 {
        self.interval_to_seconds(0.0, position)
    }

    /// The pulse reached after `target` real seconds from the timeline origin (TS `TempoMap.secondsToPPQN`,
    /// the inverse of [`ppqn_to_seconds`]). With no automation this is `seconds_to_pulses(target, nominal_bpm)`.
    pub(crate) fn seconds_to_ppqn(&self, target: f64) -> f64 {
        if target <= 0.0 {
            return 0.0;
        }
        let nominal = self.nominal_bpm;
        match &self.curve {
            None => seconds_to_pulses(target, nominal),
            Some(curve) => advance(target, |position| curve.value_at(position, nominal))
        }
    }

    /// Convert a `value` in SECONDS to a PPQN span starting at pulse `position`, integrating over tempo
    /// automation (TS `TimeBaseAwareConverter.toPPQN` for a Seconds time-base: `intervalToPPQN(ppqnToSeconds(
    /// position), +value)`). This is what sizes a seconds-based audio region's duration / loop-duration.
    pub(crate) fn seconds_span_to_ppqn(&self, position: f64, value: f64) -> f64 {
        let start_seconds = self.ppqn_to_seconds(position);
        self.seconds_to_ppqn(start_seconds + value) - self.seconds_to_ppqn(start_seconds)
    }

    #[cfg(test)]
    pub(crate) fn fixed(nominal_bpm: f32) -> Self {
        Self {curve: None, nominal_bpm}
    }
}

/// Grid-walk integration (TS `TempoGridCursor.integrate`): bpm is `bpm_at` evaluated at each grid cell's
/// start, held constant across the cell. Additive, so this equals the sum of the transport's per-block
/// conversions over the same interval.
fn integrate(from: f64, to: f64, bpm_at: impl Fn(f64) -> f32) -> f64 {
    let mut accumulated = 0.0;
    let mut current = from;
    while current < to {
        let bpm = bpm_at(quantize_floor(current, TEMPO_CHANGE_GRID));
        let next_grid = quantize_ceil(current, TEMPO_CHANGE_GRID);
        let segment_end = if next_grid <= current { next_grid + TEMPO_CHANGE_GRID } else { next_grid };
        let actual_end = segment_end.min(to);
        accumulated += pulses_to_seconds(actual_end - current, bpm);
        current = actual_end;
    }
    accumulated
}

/// Inverse grid walk (TS `TempoGridCursor.advance`): the pulse reached after `target` seconds from the origin,
/// stepping the tempo grid and accumulating each cell's seconds until the target is met (then a partial step).
fn advance(target: f64, bpm_at: impl Fn(f64) -> f32) -> f64 {
    let mut accumulated_seconds = 0.0;
    let mut accumulated_ppqn = 0.0;
    while accumulated_seconds < target {
        let bpm = bpm_at(quantize_floor(accumulated_ppqn, TEMPO_CHANGE_GRID));
        let next_grid = quantize_ceil(accumulated_ppqn, TEMPO_CHANGE_GRID);
        let segment_end = if next_grid <= accumulated_ppqn { next_grid + TEMPO_CHANGE_GRID } else { next_grid };
        let segment_seconds = pulses_to_seconds(segment_end - accumulated_ppqn, bpm);
        if accumulated_seconds + segment_seconds >= target {
            accumulated_ppqn += seconds_to_pulses(target - accumulated_seconds, bpm);
            break;
        }
        accumulated_seconds += segment_seconds;
        accumulated_ppqn = segment_end;
    }
    accumulated_ppqn
}

fn quantize_floor(position: f64, grid: f64) -> f64 {
    floor(position / grid) * grid
}

fn quantize_ceil(position: f64, grid: f64) -> f64 {
    let floored = floor(position / grid);
    if floored * grid < position {
        (floored + 1.0) * grid
    } else {
        floored * grid
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_tempo_map_is_linear() {
        let map = TempoMap::fixed(120.0);
        // 3840 ppqn = 4 quarters; at 120 bpm a quarter is 0.5 s -> 2.0 s.
        assert!((map.interval_to_seconds(0.0, 3840.0) - 2.0).abs() < 1e-9);
        // additive and origin-independent
        assert!((map.interval_to_seconds(960.0, 1920.0) - 0.5).abs() < 1e-9);
        assert_eq!(map.interval_to_seconds(100.0, 100.0), 0.0);
    }

    #[test]
    fn integrates_a_falling_tempo_ramp_correctly() {
        use dsp::ppqn::pulses_to_seconds;
        // A tempo ramp from 120 bpm down to 60 bpm over [0, 9600] pulses. The grid-walk integral must match the
        // sum of the per-grid-cell conversions, and must be LARGER than reading at the start bpm (120) yet
        // SMALLER than reading at the end bpm (60) — i.e. the read offset grows correctly, not racing ahead.
        let ramp = |position: f64| -> f32 {
            let alpha = (position / 9600.0).clamp(0.0, 1.0) as f32;
            120.0 - 60.0 * alpha
        };
        let elapsed = integrate(0.0, 9600.0, ramp);
        // Reference: walk the same grid by hand.
        let mut reference = 0.0;
        let mut current = 0.0;
        while current < 9600.0 {
            let end = (current + TEMPO_CHANGE_GRID).min(9600.0);
            reference += pulses_to_seconds(end - current, ramp(quantize_floor(current, TEMPO_CHANGE_GRID)));
            current = end;
        }
        assert!((elapsed - reference).abs() < 1e-9, "grid integral matches the per-cell sum");
        let at_start_bpm = pulses_to_seconds(9600.0, 120.0); // the OLD (buggy) single-bpm extrapolation
        let at_end_bpm = pulses_to_seconds(9600.0, 60.0);
        assert!(elapsed > at_start_bpm, "a falling tempo elapses MORE seconds than the start bpm implies");
        assert!(elapsed < at_end_bpm, "but fewer than the end bpm implies (it was higher earlier)");
    }

    #[test]
    fn tape_tempo_project_region_c_duration_is_sane() {
        // Reproduce tape-tempo.od's tempo automation (pos -> bpm, linear) and the seconds-based region C at pulse
        // 30720, duration 7.86885 s. Its PPQN duration must be a sane positive span (~10585), or the region is
        // zero/garbage-sized and silent. This isolates the duration math from the wasm harness.
        let events = [(60.0_f64, 150.0_f32), (15360.0, 60.0), (15420.0, 120.0), (30720.0, 60.0), (30780.0, 98.0), (46080.0, 60.0)];
        let bpm_at = |position: f64| -> f32 {
            if position < events[0].0 {
                return events[0].1;
            }
            for window in events.windows(2) {
                let (a, b) = (window[0], window[1]);
                if position >= a.0 && position < b.0 {
                    return (a.1 as f64 + (position - a.0) / (b.0 - a.0) * (b.1 - a.1) as f64) as f32;
                }
            }
            events[events.len() - 1].1
        };
        let position = 30720.0;
        let start_seconds = integrate(0.0, position, bpm_at);
        let from_ppqn = advance(start_seconds, bpm_at);
        let to_ppqn = advance(start_seconds + 7.86885, bpm_at);
        let duration = to_ppqn - from_ppqn;
        assert!(duration > 9000.0 && duration < 12000.0, "region C duration {duration} ppqn (start_seconds {start_seconds}, from {from_ppqn}, to {to_ppqn})");
    }

    #[test]
    fn seconds_to_ppqn_inverts_ppqn_to_seconds_under_a_ramp() {
        // `advance` (seconds->ppqn) must invert `integrate` (ppqn->seconds), so a seconds-based region duration
        // converts back correctly. Round-trips within one grid cell of any starting pulse.
        let ramp = |position: f64| -> f32 {
            let alpha = (position / 9600.0).clamp(0.0, 1.0) as f32;
            120.0 - 60.0 * alpha
        };
        for &pulse in &[80.0_f64, 1000.0, 5000.0, 9000.0, 12000.0] {
            let seconds = integrate(0.0, pulse, ramp);
            let back = advance(seconds, ramp);
            assert!((back - pulse).abs() <= TEMPO_CHANGE_GRID, "round-trip {pulse} -> {seconds}s -> {back}");
        }
        // A seconds span placed where the tempo is LOW (~60 bpm, past 9600) occupies FEWER pulses than the same
        // span placed where the tempo is HIGH (120 bpm, at the origin) — the tempo-aware sizing the region needs.
        let span_seconds = 4.0;
        let from_high = advance(integrate(0.0, 0.0, ramp) + span_seconds, ramp) - 0.0;
        let low_start = 11000.0;
        let from_low = advance(integrate(0.0, low_start, ramp) + span_seconds, ramp) - low_start;
        assert!(from_low < from_high, "a 4 s span is fewer pulses at 60 bpm ({from_low}) than at 120 bpm ({from_high})");
    }
}

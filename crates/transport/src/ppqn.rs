//! Pulses-per-quarter-note conversions, mirroring lib-dsp `ppqn.ts`. PPQN = 960. Time quantities
//! (seconds / samples / pulses) are f64 so positions stay sample-accurate over a long timeline;
//! the rate inputs (`bpm`, `sample_rate`) are f32 control values, promoted to f64 inside. Since
//! they are exactly representable in f32, results match the all-f64 math.

pub const QUARTER: f64 = 960.0;
pub const BAR: f64 = 3840.0; // QUARTER * 4
pub const SEMI_QUAVER: f64 = 240.0; // QUARTER / 4

pub fn seconds_to_pulses(seconds: f64, bpm: f32) -> f64 {
    seconds * bpm as f64 / 60.0 * QUARTER
}

pub fn pulses_to_seconds(pulses: f64, bpm: f32) -> f64 {
    (pulses * 60.0 / QUARTER) / bpm as f64
}

pub fn seconds_to_bpm(seconds: f64, pulses: f64) -> f32 {
    ((pulses * 60.0 / QUARTER) / seconds) as f32
}

pub fn samples_to_pulses(samples: f64, bpm: f32, sample_rate: f32) -> f64 {
    seconds_to_pulses(samples / sample_rate as f64, bpm)
}

pub fn pulses_to_samples(pulses: f64, bpm: f32, sample_rate: f32) -> f64 {
    pulses_to_seconds(pulses, bpm) * sample_rate as f64
}

/// Pulses per bar for a time signature (4/4 = 3840). Mirrors `fromSignature`; truncation equals
/// `Math.floor` for these positive values.
pub fn from_signature(nominator: i32, denominator: i32) -> f64 {
    ((BAR / denominator as f64) as i64 as f64) * nominator as f64
}

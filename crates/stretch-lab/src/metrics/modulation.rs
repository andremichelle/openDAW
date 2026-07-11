//! The pad contract: periodic amplitude modulation of the output envelope is the audible "grain".
//! Three views: a Goertzel line at the EXPECTED loop rate (engine-derived, precise), a band-peak
//! sweep (engine-agnostic — catches modulation at rates the expectation missed, so a changed loop
//! length cannot game the metric), and the envelope autocorrelation peak (any periodicity at all).

use super::envelope::{detrend, mean, ENVELOPE_RATE};
use super::goertzel;

pub struct ModulationScores {
    /// 20·log10(modulation depth) at the expected loop rate (+ 2nd/3rd harmonic). Lower is better.
    pub expected_db: f64,
    /// Peak modulation line found anywhere in 1..60 Hz. Lower is better; this one gates.
    pub band_peak_db: f64,
    /// Normalized envelope autocorrelation peak over 20..500 ms lags, in [0, 1]. Lower is better.
    pub acf_peak: f64
}

const EDGE_SKIP_MS: usize = 250;
const DETREND_WINDOW_MS: f64 = 250.0;

fn analysis_region(envelope: &[f32]) -> Option<&[f32]> {
    let skip = EDGE_SKIP_MS;
    if envelope.len() <= skip * 2 + 100 {
        return None;
    }
    Some(&envelope[skip..envelope.len() - skip])
}

/// The detrend (subtracting a moving average) is a known highpass: its gain at `frequency` is
/// `1 - sinc(pi f T)`. Compensate analytically so a 10% AM line reads exactly -20 dB regardless of
/// where it sits; floored to avoid boosting the near-DC region the detrend fully removes.
fn detrend_gain(frequency: f64) -> f64 {
    let x = std::f64::consts::PI * frequency * (DETREND_WINDOW_MS / 1000.0);
    let sinc = if x.abs() < 1e-9 { 1.0 } else { x.sin() / x };
    (1.0 - sinc).abs().max(0.25)
}

/// EXCESS modulation over a reference render (the parametric ideal, or the source): material like a
/// detuned chord BEATS on its own (pitch-derived rates that survive stretching), and the stretcher
/// must not be charged for modulation the perfect output would also have. Values are dB of excess;
/// 0 = no more modulation than the reference, positive = added grain.
/// Absolute audibility reference for envelope modulation: depth below this is hard to hear on
/// sustained material regardless of frequency, so excess is never charged against a quieter floor.
/// TUNABLE — calibrate by ear against renders.
const MODULATION_AUDIBILITY_DB: f64 = -40.0;

pub fn modulation_excess(output_env: &[f32], reference_env: &[f32], expected_loop_hz: f64) -> Option<ModulationScores> {
    modulation_excess_rated(output_env, reference_env, expected_loop_hz, 1.0)
}

/// `reference_ratio`: a perfect stretch SLOWS the material's own envelope fluctuations by the
/// stretch ratio — the honest reference for an output line at f is the reference at f * ratio.
/// Comparing same-frequency penalized correct slowing as if it were added grain.
pub fn modulation_excess_rated(output_env: &[f32], reference_env: &[f32], expected_loop_hz: f64, reference_ratio: f64) -> Option<ModulationScores> {
    let output = modulation_lines(output_env)?;
    let reference = modulation_lines(reference_env)?;
    let reference_at = |frequency: f64| -> f64 {
        let shifted = frequency * reference_ratio;
        let index = ((shifted - 1.0) / 0.25).round() as isize;
        if index < 0 || index as usize >= reference.lines.len() {
            MODULATION_AUDIBILITY_DB
        } else {
            reference.lines[index as usize].1
        }
    };
    let mut band_excess = f64::NEG_INFINITY;
    let mut expected_excess = f64::NEG_INFINITY;
    for (index, (frequency, output_db)) in output.lines.iter().enumerate() {
        // Masking-aware floor: an artifact is judged against the LOUDEST of (a) the reference at
        // this exact line, (b) partial masking from nearby loud reference lines (within ~1/3
        // octave, 10 dB below the masker), (c) the absolute audibility reference. Baseline's grain
        // hiding on a pad's intrinsic beating lines and adaptive's smaller-but-exposed wobble are
        // then compared by how far each pokes above what a listener could actually notice.
        let _ = index;
        let mut floor = reference_at(*frequency).max(MODULATION_AUDIBILITY_DB);
        for (masker_frequency, masker_db) in &reference.lines {
            let masker_frequency = masker_frequency / reference_ratio;
            let distance = (frequency / masker_frequency).ln().abs();
            // Two-tier masking: co-band lines (same critical band) are masked near-completely;
            // neighbors within ~1/3 octave partially. Applied symmetrically to both engines.
            if distance < 0.05 {
                floor = floor.max(masker_db - 3.0);
            } else if distance < 0.3 {
                floor = floor.max(masker_db - 10.0);
            }
        }
        let excess = output_db - floor;
        if excess > band_excess {
            band_excess = excess;
        }
        if expected_loop_hz > 0.2 && (frequency - expected_loop_hz).abs() < 0.26 {
            expected_excess = excess;
        }
    }
    Some(ModulationScores {
        expected_db: expected_excess,
        band_peak_db: band_excess,
        acf_peak: (output.acf - reference.acf).max(0.0)
    })
}

struct ModulationLines {
    lines: Vec<(f64, f64)>,
    acf: f64
}

fn modulation_lines(smooth_env: &[f32]) -> Option<ModulationLines> {
    let region = analysis_region(smooth_env)?;
    let level = mean(region);
    if level < 1e-5 {
        return None;
    }
    let residual = detrend(region, DETREND_WINDOW_MS);
    let mut lines = Vec::new();
    let mut frequency = 1.0;
    while frequency <= 60.0 {
        let magnitude = goertzel::magnitude(&residual, ENVELOPE_RATE, frequency) / detrend_gain(frequency);
        lines.push((frequency, goertzel::db(magnitude / level)));
        frequency += 0.25;
    }
    Some(ModulationLines {lines, acf: acf_peak(&residual)})
}

pub fn modulation_scores(smooth_env: &[f32], expected_loop_hz: f64) -> Option<ModulationScores> {
    let region = analysis_region(smooth_env)?;
    let level = mean(region);
    if level < 1e-5 {
        return None;
    }
    let residual = detrend(region, DETREND_WINDOW_MS);
    let line = |frequency: f64| goertzel::magnitude(&residual, ENVELOPE_RATE, frequency) / detrend_gain(frequency);
    let expected = if expected_loop_hz > 0.2 {
        let power = line(expected_loop_hz).powi(2) + line(2.0 * expected_loop_hz).powi(2) + line(3.0 * expected_loop_hz).powi(2);
        goertzel::db(power.sqrt() / level)
    } else {
        f64::NEG_INFINITY
    };
    let mut band_peak = 0.0f64;
    let mut frequency = 1.0;
    while frequency <= 60.0 {
        band_peak = band_peak.max(line(frequency));
        frequency += 0.25;
    }
    let band_peak_db = goertzel::db(band_peak / level);
    let acf_peak = acf_peak(&residual);
    Some(ModulationScores {expected_db: expected, band_peak_db, acf_peak})
}

fn acf_peak(residual: &[f32]) -> f64 {
    let count = residual.len();
    let energy: f64 = residual.iter().map(|value| (*value as f64).powi(2)).sum();
    if energy < 1e-12 {
        return 0.0;
    }
    let mut peak = 0.0f64;
    let (lag_from, lag_to) = (20usize, 500usize.min(count / 2));
    for lag in lag_from..lag_to {
        let mut sum = 0.0f64;
        for index in 0..count - lag {
            sum += residual[index] as f64 * residual[index + lag] as f64;
        }
        peak = peak.max(sum / energy);
    }
    peak
}

/// The pad symptom in its purest form: sidebands at f0 ± n·loop_rate around a pure sine's
/// fundamental, plus THD from harmonic distortion of the splices.
pub struct SineScores {
    pub sideband_db: f64,
    pub thd_db: f64
}

pub fn sine_scores(mono_out: &[f32], sample_rate: f64, f0: f64, expected_loop_hz: f64) -> SineScores {
    let _ = expected_loop_hz;
    let carrier = goertzel::magnitude(mono_out, sample_rate, f0);
    let carrier_power = carrier * carrier;
    // Engine-agnostic sideband: the loop rate depends on the engine's chosen loop length, so probe
    // a sweep of candidate rates and take the worst line (a fixed expected rate measured noise at
    // the wrong frequency — the same baseline-anchored flaw mod_expected had).
    let mut sideband_power = 0.0f64;
    let mut offset = 1.0;
    while offset <= 30.0 {
        let power = goertzel::magnitude(mono_out, sample_rate, f0 - offset).powi(2)
            + goertzel::magnitude(mono_out, sample_rate, f0 + offset).powi(2);
        sideband_power = sideband_power.max(power);
        offset += 0.5;
    }
    let mut harmonic_power = 0.0;
    for harmonic in 2..=5 {
        harmonic_power += goertzel::magnitude(mono_out, sample_rate, f0 * harmonic as f64).powi(2);
    }
    SineScores {
        sideband_db: goertzel::power_ratio_db(sideband_power, carrier_power),
        thd_db: goertzel::power_ratio_db(harmonic_power, carrier_power)
    }
}

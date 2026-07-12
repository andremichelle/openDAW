
//! Envelope ROUGHNESS: the ear-calibrated grain-artifact number. "Clicky rapid volume
//! modulation", "ghost playbacks" and "random grain attacks" all share one signature — fast
//! envelope movement (20-200 Hz band) that the source does not have at the mapped rate. The old
//! modulation metrics low-passed the envelope at 50 Hz and were structurally deaf to it.

use super::envelope::{fast_envelope, ENVELOPE_RATE};

/// RMS of the fast-envelope derivative over the mean level, in dB — how violently the loudness
/// moves per millisecond, normalized so material loudness cancels.
pub fn roughness_db(fast_env: &[f32]) -> f64 {
    if fast_env.len() < 100 {
        return -120.0;
    }
    let mean: f64 = fast_env.iter().map(|v| *v as f64).sum::<f64>() / fast_env.len() as f64;
    if mean < 1e-5 {
        return -120.0;
    }
    let mut sum = 0.0f64;
    for window in fast_env.windows(2) {
        let d = (window[1] - window[0]) as f64;
        sum += d * d;
    }
    let rms = (sum / (fast_env.len() - 1) as f64).sqrt();
    20.0 * (rms / mean + 1e-9).log10()
}

/// Output roughness in EXCESS of the source's (dB). A perfect stretch keeps roughness at or below
/// the source's own (slowed material moves less per ms, so <= 0 is the honest target).
pub fn roughness_excess_db(source_env: &[f32], output_env: &[f32]) -> f64 {
    roughness_db(output_env) - roughness_db(source_env)
}

pub use legacy::*;
mod legacy {
    use super::*;
    pub fn envelope_onsets(fast_env: &[f32]) -> alloc::vec::Vec<f64> {
        let _ = fast_env;
        alloc::vec::Vec::new()
    }
    pub fn spurious_attack_rate(source_env: &[f32], output_env: &[f32], ratio: f64) -> f64 {
        let _ = ratio;
        roughness_excess_db(source_env, output_env)
    }
}

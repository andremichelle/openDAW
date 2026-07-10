//! The drum contract: for each ground-truth onset (annotations / recipe positions mapped through
//! the stretch ratio — never a detector, for determinism), compare the stretched output's attack to
//! the source's attack at the same event. Rise time and local crest must stay near the source's
//! (ratio ~1); extra envelope peaks near an onset are double-triggers.

use super::envelope::ENVELOPE_RATE;

pub struct AttackScores {
    /// Median over onsets of rise_out / rise_src (10% -> 90% of the local peak). 1.0 = perfect.
    pub rise_ratio: f64,
    /// Median over onsets of crest_out / crest_src. 1.0 = perfect, < 1 = smeared.
    pub crest_ratio: f64,
    /// Mean count of extra envelope peaks (> 50% of window max, > 5 ms apart) beyond the first.
    pub extra_peaks: f64,
    pub onsets_measured: usize
}

struct OnsetShape {
    rise_ms: f64,
    crest: f64,
    peaks: usize
}

fn measure_onset(envelope: &[f32], onset_seconds: f64) -> Option<OnsetShape> {
    let center = (onset_seconds * ENVELOPE_RATE) as isize;
    let from = (center - 20).max(0) as usize;
    let to = ((center + 60) as usize).min(envelope.len());
    if to <= from + 5 {
        return None;
    }
    let window = &envelope[from..to];
    let peak = window.iter().fold(0.0f32, |max, value| max.max(*value));
    if peak < 1e-4 {
        return None;
    }
    let peak_index = window.iter().position(|value| *value == peak).unwrap_or(0);
    let low = 0.1 * peak;
    let high = 0.9 * peak;
    let mut t_low = None;
    let mut t_high = None;
    for index in (0..=peak_index).rev() {
        if t_high.is_none() && window[index] < high {
            t_high = Some(index + 1);
        }
        if window[index] < low {
            t_low = Some(index + 1);
            break;
        }
    }
    let t_low = t_low.unwrap_or(0);
    let t_high = t_high.unwrap_or(peak_index);
    let rise_ms = (t_high.saturating_sub(t_low)).max(1) as f64;
    let sustain_to = ((center as usize) + 70).min(envelope.len());
    let sustain_from = (center.max(0) as usize).min(sustain_to);
    let sustain = &envelope[sustain_from..sustain_to];
    let sustain_rms = (sustain.iter().map(|value| (*value as f64).powi(2)).sum::<f64>() / sustain.len().max(1) as f64).sqrt();
    let crest = peak as f64 / (sustain_rms + 1e-9);
    let mut peaks = 0usize;
    let mut last_peak: isize = -10;
    for index in 1..window.len().saturating_sub(1) {
        if window[index] > 0.5 * peak && window[index] >= window[index - 1] && window[index] > window[index + 1] && (index as isize - last_peak) > 5 {
            peaks += 1;
            last_peak = index as isize;
        }
    }
    Some(OnsetShape {rise_ms, crest, peaks})
}

fn median(values: &mut Vec<f64>) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[values.len() / 2]
}

/// `source_onsets` in SOURCE seconds; output onsets are `t * ratio`.
pub fn attack_scores(source_env: &[f32], output_env: &[f32], source_onsets: &[f64], ratio: f64) -> Option<AttackScores> {
    let mut rise_ratios = Vec::new();
    let mut crest_ratios = Vec::new();
    let mut extra_total = 0usize;
    for &onset in source_onsets {
        let Some(source) = measure_onset(source_env, onset) else { continue };
        let Some(output) = measure_onset(output_env, onset * ratio) else { continue };
        rise_ratios.push(output.rise_ms / source.rise_ms);
        crest_ratios.push(output.crest / source.crest);
        extra_total += output.peaks.saturating_sub(1);
    }
    if rise_ratios.is_empty() {
        return None;
    }
    let onsets_measured = rise_ratios.len();
    Some(AttackScores {
        rise_ratio: median(&mut rise_ratios),
        crest_ratio: median(&mut crest_ratios),
        extra_peaks: extra_total as f64 / onsets_measured as f64,
        onsets_measured
    })
}

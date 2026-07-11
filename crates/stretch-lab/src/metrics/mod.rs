//! Per-case metric assembly. Every metric carries a name, a value, and its better-direction; which
//! metrics apply depends on the corpus class. The judges are judged first: `tests/metrics_selftest.rs`
//! calibrates each one on signals with known answers before any engine is measured.

pub mod envelope;
pub mod goertzel;
pub mod attack;
pub mod modulation;
pub mod spectral;
pub mod annotate;

use crate::corpus::{Class, Entry};
use crate::render::RenderSpec;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    LowerBetter,
    HigherBetter,
    TargetOne,
    /// Only values BELOW one are bad (smear); above one is fine (sparse impulsive material reads
    /// punchier when loops repeat its quiet tail — not a defect).
    AtLeastOne,
    /// Only values ABOVE one are bad (a slower rise is smear; a faster-than-source attack is not).
    AtMostOne
}

#[derive(Clone, Debug)]
pub struct MetricValue {
    pub name: &'static str,
    pub value: f64,
    pub better: Direction
}

fn metric(name: &'static str, value: f64, better: Direction) -> MetricValue {
    MetricValue {name, value, better}
}

/// The loop rate the BASELINE engine is expected to produce for this entry: segments loop over
/// their length minus the fixed margins. Engine-agnostic gating uses the band-peak sweep instead.
pub fn expected_loop_hz(entry: &Entry) -> f64 {
    let period = entry.median_segment_seconds() - 0.030;
    if period > 0.02 { 1.0 / period } else { 0.0 }
}

/// Measure one rendered case. `ratio > 1` enables the loop-modulation family (compression does not
/// loop). Attack metrics need ground-truth onsets and a percussive/tonal class.
pub fn measure_case(entry: &Entry, spec: &RenderSpec, out_left: &[f32], out_right: &[f32], playback_markers: Option<&[stretch::TransientDescriptor]>) -> Vec<MetricValue> {
    let engine_rate = crate::render::ENGINE_RATE as f64;
    let mut results = Vec::new();
    let source_mono = envelope::mono(spec.left, spec.right);
    let output_mono = envelope::mono(out_left, out_right);
    let source_fast = envelope::fast_envelope(&source_mono, spec.file_rate);
    let output_fast = envelope::fast_envelope(&output_mono, crate::render::ENGINE_RATE);
    results.push(metric("trailing_silence", spectral::trailing_silence_ratio(&output_fast), Direction::LowerBetter));
    let gapping_spectral = spec.mode == crate::render::PlayMode::Once && spec.ratio > 1.01;
    if !gapping_spectral {
        let source_bands = spectral::band_fractions(&source_mono, spec.file_rate as f64);
        let output_bands = spectral::band_fractions(&output_mono, engine_rate);
        results.push(metric("spectral_delta_db", spectral::spectral_delta_db(&source_bands, &output_bands), Direction::LowerBetter));
    }
    // Once mode gaps by design once the segment runs out — its level/spectral drift is the correct
    // musical behavior, not a defect, so those guards only judge the looping modes.
    let gapping = spec.mode == crate::render::PlayMode::Once && spec.ratio > 1.01;
    if !gapping && matches!(entry.class, Class::Sustained | Class::Sine | Class::Sweep | Class::Tonal) {
        results.push(metric("level_delta_db", spectral::level_delta_db(envelope::rms(&source_mono), envelope::rms(&output_mono)), Direction::LowerBetter));
    }
    let looping = spec.ratio > 1.01;
    if looping && matches!(entry.class, Class::Sustained | Class::Sine | Class::Sweep | Class::Tonal | Class::Mixed) {
        // Modulation is judged as EXCESS over the reference: the parametric ideal when the entry
        // has one, else the source (intrinsic beat rates are pitch-derived and survive stretching).
        let reference_mono = entry.ideal.as_ref().map(|ideal| ideal(spec.ratio));
        let (reference_env, reference_rate) = match &reference_mono {
            Some(ideal) => (ideal.as_slice(), crate::render::ENGINE_RATE),
            None => (source_mono.as_slice(), spec.file_rate)
        };
        let smooth_out = envelope::smooth_envelope(&output_mono, crate::render::ENGINE_RATE);
        let smooth_ref = envelope::smooth_envelope(reference_env, reference_rate);
        // Real fixtures use the unstretched source as reference: rate-shift the comparison.
        let reference_ratio = if entry.ideal.is_some() { 1.0 } else { spec.ratio };
        if let Some(scores) = modulation::modulation_excess_rated(&smooth_out, &smooth_ref, expected_loop_hz(entry), reference_ratio) {
            if scores.expected_db.is_finite() {
                results.push(metric("mod_expected_db", scores.expected_db, Direction::LowerBetter));
            }
            results.push(metric("mod_band_peak_db", scores.band_peak_db, Direction::LowerBetter));
            results.push(metric("mod_acf_peak", scores.acf_peak, Direction::LowerBetter));
        }
    }
    if looping {
        if let (Class::Sine, Some(f0)) = (entry.class, entry.sine_f0) {
            let scores = modulation::sine_scores(&output_mono, engine_rate, f0, expected_loop_hz(entry));
            results.push(metric("sine_sideband_db", scores.sideband_db, Direction::LowerBetter));
            results.push(metric("sine_thd_db", scores.thd_db, Direction::LowerBetter));
        }
    }
    if matches!(entry.class, Class::Percussive | Class::Tonal | Class::Mixed) {
        // CONSENSUS onsets judge attacks: positions where the annotation grid and the detector
        // agree within 20 ms are high-confidence hits — no detector judges itself, no crude
        // annotator gets the final word either.
        let consensus: Vec<f64> = match playback_markers {
            Some(markers) => entry.transients.iter().copied()
                .filter(|&onset| markers.iter().any(|marker| (marker.position - onset).abs() < 0.020))
                .collect(),
            None => entry.transients.clone()
        };
        if let Some(scores) = attack::attack_scores(&source_fast, &output_fast, &consensus, spec.ratio) {
            // Untrusted (machine-annotated, unreviewed) onsets report as advisory adv_* names —
            // outside TARGETS/GUARDS — because a gate fed by annotation noise blocks randomly in
            // both directions (baseline itself read 0.32..1.9 on those fixtures). The independent
            // sa_attack_ratio guards real drums meanwhile.
            if entry.trusted_onsets {
                results.push(metric("attack_rise_ratio", scores.rise_ratio, Direction::AtMostOne));
                results.push(metric("attack_crest_ratio", scores.crest_ratio, Direction::AtLeastOne));
                results.push(metric("attack_extra_peaks", scores.extra_peaks, Direction::LowerBetter));
            } else {
                results.push(metric("adv_attack_rise_ratio", scores.rise_ratio, Direction::AtMostOne));
                results.push(metric("adv_attack_crest_ratio", scores.crest_ratio, Direction::AtLeastOne));
                results.push(metric("adv_attack_extra_peaks", scores.extra_peaks, Direction::LowerBetter));
            }
        }
    }
    #[cfg(feature = "analyzer")]
    {
        let mut second = crate::second_opinion::second_opinion(&source_mono, spec.file_rate, &output_mono, crate::render::ENGINE_RATE);
        // HPSS attack sharpness means "attack preservation" only on percussive material — on
        // sustained/tonal content it measures our own loop artifacts, where LOWER is better
        // (guarding it there punished the biggest wins). Gapping Once renders skew its global
        // statistics too. Advisory outside its domain.
        // Pingpong deliberately REVERSES material — HPSS attack statistics on reversed clicks
        // measure the mode's sound, not smear.
        let attack_meaningful = matches!(entry.class, Class::Percussive | Class::Mixed) && !gapping
            && spec.mode != crate::render::PlayMode::Pingpong;
        for value in &mut second {
            if value.name == "sa_attack_ratio" && !attack_meaningful {
                value.name = "adv_sa_attack_ratio";
            }
        }
        results.extend(second);
    }
    results
}

/// Distance from ideal for a metric value: 0 = perfect, larger = worse, regardless of direction.
pub fn badness(value: &MetricValue) -> f64 {
    match value.better {
        Direction::LowerBetter => value.value,
        Direction::HigherBetter => -value.value,
        Direction::TargetOne => (value.value - 1.0).abs(),
        Direction::AtLeastOne => (1.0 - value.value).max(0.0),
        Direction::AtMostOne => (value.value - 1.0).max(0.0)
    }
}

/// The mathematically perfect score for each metric (the "ideal" report column). The mod_* family
/// is excess-over-reference: 0 means "no more modulation than the perfect output".
pub fn ideal_value(name: &str) -> f64 {
    match name {
        "attack_rise_ratio" | "attack_crest_ratio" => 1.0,
        "sine_sideband_db" | "sine_thd_db" => -120.0,
        _ => 0.0
    }
}

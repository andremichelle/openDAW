// The built-in profiles are designed spectra run through the reference analysis. Their loudness, tilt and side
// level must come out as designed, and different profiles must lead to different matches.

use matchering::analysis::{match_target, ReferenceProfile};
use matchering::config::{BINS, FFT_SIZE, SAMPLE_RATE};
use matchering::profiles::{builtin, COUNT};

fn bin_of(frequency: f64) -> usize {(frequency * FFT_SIZE as f64 / SAMPLE_RATE as f64).round() as usize}

fn db(value: f64) -> f64 {20.0 * value.log10()}

#[test]
fn profiles_are_deterministic_and_complete() {
    for index in 0..COUNT {
        let profile = builtin(index);
        assert_eq!(profile.mid_spectrum.len(), BINS);
        assert!(profile.mid_spectrum.iter().chain(&profile.side_spectrum).all(|value| value.is_finite()));
        assert_eq!(profile, builtin(index));
    }
}

#[test]
fn loudness_and_tilt_follow_the_design() {
    let balanced = builtin(0);
    let loudness = |profile: &ReferenceProfile| db(profile.match_rms * profile.final_amplitude);
    assert!((loudness(&balanced) - -14.0).abs() < 0.5, "balanced rms {}", loudness(&balanced));
    assert!((loudness(&builtin(3)) - -12.0).abs() < 0.5, "punchy rms {}", loudness(&builtin(3)));
    let tilt = |index: usize| {
        let profile = builtin(index);
        let average = |frequency: f64| {
            let center = bin_of(frequency);
            profile.mid_spectrum[center - 4..=center + 4].iter().sum::<f64>() / 9.0
        };
        db(average(4000.0)) - db(average(500.0))
    };
    assert!((tilt(0) - -13.5).abs() < 1.5, "balanced tilt over three octaves {}", tilt(0));
    assert!(tilt(2) > tilt(0) && tilt(0) > tilt(1), "bright is brighter than balanced is brighter than warm");
}

#[test]
fn side_is_quieter_than_mid_and_widens_upwards() {
    let profile = builtin(0);
    let ratio = |frequency: f64| db(profile.side_spectrum[bin_of(frequency)] / profile.mid_spectrum[bin_of(frequency)]);
    assert!(ratio(100.0) < ratio(5000.0));
    assert!(ratio(5000.0) < -3.0);
}

#[test]
fn profiles_differ_from_each_other() {
    let curves: Vec<Vec<f64>> = (0..COUNT).map(|index| builtin(index).mid_spectrum).collect();
    for a in 0..COUNT {
        for b in a + 1..COUNT {assert_ne!(curves[a], curves[b]);}
    }
}

#[test]
fn different_profiles_give_different_curves_for_the_same_target() {
    let warm = builtin(1);
    let balanced = builtin(0);
    let target: Vec<f64> = (0..20 * SAMPLE_RATE).map(|index| ((index as f64) * 0.05).sin() * 0.3).collect();
    let warm_result = match_target(&target, &target, &warm, None, None, &mut |_| {}).unwrap();
    let balanced_result = match_target(&target, &target, &balanced, None, None, &mut |_| {}).unwrap();
    assert_ne!(warm_result.mid_curve, balanced_result.mid_curve);
}

#[test]
fn the_peak_budget_keeps_a_dynamic_mix_from_being_crushed() {
    use matchering::analysis::apply;
    use matchering::config::{CURVE_LIMIT_DB, PEAK_BUDGET_DB, THRESHOLD};
    // a quiet bed with a loud hit every second, peaks far above its loudness
    let target: Vec<f64> = (0..20 * SAMPLE_RATE).map(|index| {
        let bed = ((index as f64) * 0.05).sin() * 0.05;
        let hit = if index % SAMPLE_RATE < 200 {((index as f64) * 0.3).sin() * 0.9} else {0.0};
        bed + hit
    }).collect();
    let punchy = builtin(3);
    let free = match_target(&target, &target, &punchy, Some(CURVE_LIMIT_DB), None, &mut |_| {}).unwrap();
    let held = match_target(&target, &target, &punchy, Some(CURVE_LIMIT_DB), Some(PEAK_BUDGET_DB), &mut |_| {}).unwrap();
    let peak = |result| {
        let (left, right) = apply(&target, &target, result);
        left.iter().chain(&right).fold(0.0f64, |peak, value| peak.max(value.abs()))
    };
    assert!(db(peak(&free) / THRESHOLD) > PEAK_BUDGET_DB + 3.0, "without a budget the limiter takes {} dB", db(peak(&free) / THRESHOLD));
    assert!(db(peak(&held) / THRESHOLD) <= PEAK_BUDGET_DB + 1e-6, "with the budget {} dB", db(peak(&held) / THRESHOLD));
    assert!(held.gain < free.gain);
}

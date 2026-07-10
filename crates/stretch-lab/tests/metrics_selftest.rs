//! The judges are judged first: every metric must read known answers off constructed signals
//! before it is allowed to judge an engine.

use stretch_lab::metrics::{attack, envelope, goertzel, modulation};

const RATE: f32 = 48_000.0;

fn sine(frequency: f64, duration: f64, amplitude: f64) -> Vec<f32> {
    let count = (duration * RATE as f64) as usize;
    (0..count).map(|index| (amplitude * (2.0 * std::f64::consts::PI * frequency * index as f64 / RATE as f64).sin()) as f32).collect()
}

#[test]
fn goertzel_reads_a_full_scale_sine_as_unity() {
    let signal = sine(440.0, 1.0, 1.0);
    let magnitude = goertzel::magnitude(&signal, RATE as f64, 440.0);
    assert!((magnitude - 1.0).abs() < 0.01, "full-scale 440 Hz sine reads {magnitude}");
    let elsewhere = goertzel::magnitude(&signal, RATE as f64, 700.0);
    assert!(elsewhere < 0.001, "no energy at 700 Hz, read {elsewhere}");
}

#[test]
fn injected_am_reads_back_within_one_db() {
    // A 300 Hz carrier with 10% AM at 3 Hz: modulation depth is exactly -20 dB.
    let count = (4.0 * RATE as f64) as usize;
    let signal: Vec<f32> = (0..count).map(|index| {
        let t = index as f64 / RATE as f64;
        let am = 1.0 + 0.1 * (2.0 * std::f64::consts::PI * 3.0 * t).sin();
        (0.5 * am * (2.0 * std::f64::consts::PI * 300.0 * t).sin()) as f32
    }).collect();
    let smooth = envelope::smooth_envelope(&signal, RATE);
    let scores = modulation::modulation_scores(&smooth, 3.0).expect("long enough for analysis");
    assert!((scores.expected_db - (-20.0)).abs() < 1.0, "10% AM at the expected rate reads {:.2} dB, want -20", scores.expected_db);
    assert!((scores.band_peak_db - (-20.0)).abs() < 1.5, "band sweep finds the same line: {:.2} dB", scores.band_peak_db);
    assert!(scores.acf_peak > 0.5, "periodic envelope autocorrelates: {}", scores.acf_peak);
}

#[test]
fn clean_sine_scores_near_silence_on_modulation() {
    let signal = sine(300.0, 4.0, 0.5);
    let smooth = envelope::smooth_envelope(&signal, RATE);
    let scores = modulation::modulation_scores(&smooth, 3.0).expect("long enough");
    assert!(scores.expected_db < -50.0, "clean sine has no AM line: {:.2} dB", scores.expected_db);
    assert!(scores.band_peak_db < -50.0, "clean sine has no band peak: {:.2} dB", scores.band_peak_db);
}

#[test]
fn sine_sidebands_read_injected_am_sidebands() {
    // 10% AM puts two sidebands at -26 dB relative to the carrier EACH (20log10(0.05));
    // summed power over both -> ~-23 dB.
    let count = (4.0 * RATE as f64) as usize;
    let signal: Vec<f32> = (0..count).map(|index| {
        let t = index as f64 / RATE as f64;
        let am = 1.0 + 0.1 * (2.0 * std::f64::consts::PI * 2.0 * t).sin();
        (0.5 * am * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32
    }).collect();
    let scores = modulation::sine_scores(&signal, RATE as f64, 440.0, 2.0);
    assert!((scores.sideband_db - (-23.0)).abs() < 1.5, "AM sidebands read {:.2} dB, want ~-23", scores.sideband_db);
    let clean = modulation::sine_scores(&sine(440.0, 4.0, 0.5), RATE as f64, 440.0, 2.0);
    assert!(clean.sideband_db < -60.0, "clean sine has no sidebands: {:.2} dB", clean.sideband_db);
}

fn click_train(positions: &[f64], duration: f64) -> Vec<f32> {
    let count = (duration * RATE as f64) as usize;
    let mut samples = vec![0.0f32; count];
    for &position in positions {
        let start = (position * RATE as f64) as usize;
        for offset in 0..(0.030 * RATE as f64) as usize {
            let index = start + offset;
            if index >= samples.len() {
                break;
            }
            let t = offset as f64 / RATE as f64;
            samples[index] += (0.9 * (-t / 0.005).exp() * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as f32;
        }
    }
    samples
}

#[test]
fn identical_clicks_at_mapped_times_score_ratio_one() {
    let source_onsets = [0.2, 0.7, 1.2];
    let ratio = 2.0;
    let source = click_train(&source_onsets, 1.7);
    let output_onsets: Vec<f64> = source_onsets.iter().map(|&t| t * ratio).collect();
    let output = click_train(&output_onsets, 1.7 * ratio);
    let source_env = envelope::fast_envelope(&source, RATE);
    let output_env = envelope::fast_envelope(&output, RATE);
    let scores = attack::attack_scores(&source_env, &output_env, &source_onsets, ratio).expect("onsets measured");
    assert_eq!(scores.onsets_measured, 3);
    assert!((scores.rise_ratio - 1.0).abs() < 0.15, "identical clicks -> rise ratio ~1, got {}", scores.rise_ratio);
    assert!((scores.crest_ratio - 1.0).abs() < 0.15, "identical clicks -> crest ratio ~1, got {}", scores.crest_ratio);
    assert!(scores.extra_peaks < 0.5, "no double triggers: {}", scores.extra_peaks);
}

#[test]
fn smeared_clicks_score_below_one_on_crest() {
    let source_onsets = [0.2, 0.7, 1.2];
    let source = click_train(&source_onsets, 1.7);
    // Smear: 8 ms box blur wipes the 5 ms attack.
    let kernel = (0.008 * RATE as f64) as usize;
    let mut smeared = vec![0.0f32; source.len()];
    let mut running = 0.0f32;
    for index in 0..source.len() {
        running += source[index];
        if index >= kernel {
            running -= source[index - kernel];
        }
        smeared[index] = running / kernel as f32;
    }
    let source_env = envelope::fast_envelope(&source, RATE);
    let smeared_env = envelope::fast_envelope(&smeared, RATE);
    let scores = attack::attack_scores(&source_env, &smeared_env, &source_onsets, 1.0).expect("onsets measured");
    assert!(scores.crest_ratio < 0.8 || scores.rise_ratio > 1.3, "smearing must show: crest {} rise {}", scores.crest_ratio, scores.rise_ratio);
}

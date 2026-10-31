// Compares the analysis against Matchering 2.0.6 run on the same synthetic audio (see fixtures/generate_stages.py).

use std::f64::consts::PI;
use matchering::analysis::{analyse_reference, apply, match_target, Error};

const SAMPLE_RATE: f64 = 44100.0;

fn fixture(name: &str) -> Vec<f64> {
    let path = format!("{}/tests/fixtures/{name}.bin", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
    bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap())).collect()
}

fn noise(seed: u64, index: u64) -> f64 {
    let mut z = seed.wrapping_add(index.wrapping_mul(0x9E3779B97F4A7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
}

fn signal(seconds: f64, seed: u64, tones: &[(f64, f64)], noise_level: f64) -> (Vec<f64>, Vec<f64>) {
    let count = (seconds * SAMPLE_RATE) as usize;
    let channel = |channel: usize| -> Vec<f64> {
        (0..count).map(|index| {
            let t = index as f64 / SAMPLE_RATE;
            let envelope = 0.5 + 0.4 * (2.0 * PI * 0.07 * t).sin();
            let voice: f64 = tones.iter()
                .map(|(frequency, level)| level * (2.0 * PI * frequency * t + channel as f64 * 0.3).sin()).sum();
            envelope * (voice + noise_level * noise(seed + channel as u64, index as u64))
        }).collect()
    };
    (channel(0), channel(1))
}

fn target() -> (Vec<f64>, Vec<f64>) {signal(40.0, 7, &[(110.0, 0.3), (440.0, 0.2)], 0.15)}

fn reference() -> (Vec<f64>, Vec<f64>) {signal(35.0, 11, &[(80.0, 0.4), (2000.0, 0.25)], 0.1)}

fn assert_close(actual: &[f64], expected: &[f64], tolerance: f64) {
    assert_eq!(actual.len(), expected.len());
    let worst = actual.iter().zip(expected).enumerate()
        .map(|(index, (actual, expected))| (index, (actual - expected).abs() / expected.abs().max(1.0)))
        .max_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    assert!(worst.1 <= tolerance, "index {} deviates by {:e} (actual {}, expected {})",
            worst.0, worst.1, actual[worst.0], expected[worst.0]);
}

#[test]
fn reference_profile() {
    let (left, right) = reference();
    let profile = analyse_reference(&left, &right).unwrap();
    assert_close(&[profile.match_rms, profile.final_amplitude], &fixture("profile_scalars"), 1e-12);
    assert_close(&profile.mid_spectrum, &fixture("profile_mid_spectrum"), 1e-10);
    assert_close(&profile.side_spectrum, &fixture("profile_side_spectrum"), 1e-10);
}

#[test]
fn matching_curves() {
    let (left, right) = reference();
    let profile = analyse_reference(&left, &right).unwrap();
    let (left, right) = target();
    let result = match_target(&left, &right, &profile, None, &mut |_| {}).unwrap();
    assert_close(&result.mid_curve[2..], &fixture("match_mid_curve")[2..], 1e-9);
    assert_close(&result.side_curve[2..], &fixture("match_side_curve")[2..], 1e-9);
}

#[test]
fn unlimited_result_matches_matchering() {
    let (left, right) = reference();
    let profile = analyse_reference(&left, &right).unwrap();
    let (left, right) = target();
    let result = match_target(&left, &right, &profile, None, &mut |_| {}).unwrap();
    let (out_left, out_right) = apply(&left, &right, &result);
    let decimated: Vec<f64> = (0..out_left.len()).step_by(997)
        .flat_map(|index| [out_left[index], out_right[index]]).collect();
    assert_close(&decimated, &fixture("match_result_decimated"), 1e-9);
}

#[test]
fn rejects_invalid_lengths() {
    let short = vec![0.1; 4096];
    assert_eq!(analyse_reference(&short, &short), Err(Error::TooShort));
    assert_eq!(analyse_reference(&short, &short[..100]), Err(Error::LengthMismatch));
}

#[test]
fn quiet_reference_is_normalized_and_keeps_its_loudness_as_final_amplitude() {
    let (left, right) = reference();
    let loud = analyse_reference(&left, &right).unwrap();
    let quiet_left: Vec<f64> = left.iter().map(|value| value * 0.25).collect();
    let quiet_right: Vec<f64> = right.iter().map(|value| value * 0.25).collect();
    let quiet = analyse_reference(&quiet_left, &quiet_right).unwrap();
    assert!((quiet.match_rms - loud.match_rms).abs() < 1e-12);
    assert!((quiet.final_amplitude - loud.final_amplitude * 0.25).abs() < 1e-12);
}

#[test]
fn curve_limit_clamps_a_narrow_mix_and_keeps_the_loudness_match() {
    let (left, right) = reference();
    let profile = analyse_reference(&left, &right).unwrap();
    let (left, _) = target();
    let narrow: Vec<f64> = left.iter().enumerate().map(|(index, value)| value + 1e-4 * noise(99, index as u64)).collect();
    let unlimited = match_target(&left, &narrow, &profile, None, &mut |_| {}).unwrap();
    let limited = match_target(&left, &narrow, &profile, Some(12.0), &mut |_| {}).unwrap();
    let db = |value: f64| 20.0 * value.log10();
    let peak = |curve: &[f64]| curve[1..].iter().fold(f64::MIN, |peak, value| peak.max(db(*value)));
    let floor = |curve: &[f64]| curve[1..].iter().fold(f64::MAX, |floor, value| floor.min(db(*value)));
    assert!(peak(&unlimited.side_curve) > 30.0, "the narrow side is boosted without a limit");
    assert!(peak(&limited.side_curve) <= 12.0 + 1e-9 && floor(&limited.side_curve) >= -12.0 - 1e-9);
    assert!(peak(&limited.mid_curve) <= 12.0 + 1e-9 && floor(&limited.mid_curve) >= -12.0 - 1e-9);
    assert_eq!(limited.mid_curve[0], 0.0);
    let (out_left, out_right) = apply(&left, &narrow, &limited);
    let mid: Vec<f64> = out_left.iter().zip(&out_right).map(|(left, right)| (left + right) * 0.5).collect();
    let rms = |values: &[f64]| (values.iter().map(|value| value * value).sum::<f64>() / values.len() as f64).sqrt();
    assert!((db(rms(&mid)) - db(profile.match_rms)).abs() < 3.0, "the loudness still lands near the reference");
}

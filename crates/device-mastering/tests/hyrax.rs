// Compares the streaming limiter against Matchering 2.0.6's offline Hyrax limiter (see fixtures/generate.py).

use std::f64::consts::PI;
use device_mastering::hyrax::Hyrax;

const SAMPLE_RATE: usize = 44100;
const THRESHOLD: f64 = (32768.0 - 61.0) / 32768.0;
const DECIMATION: usize = 97;

fn fixture(name: &str) -> Vec<f64> {
    let path = format!("{}/tests/fixtures/{name}.bin", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
    bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap())).collect()
}

fn signal() -> (Vec<f64>, Vec<f64>) {
    (0..10 * SAMPLE_RATE).map(|index| {
        let t = index as f64 / SAMPLE_RATE as f64;
        let envelope = 0.6 + 0.9 * (2.0 * PI * 0.3 * t).sin().abs();
        (envelope * (2.0 * PI * 440.0 * t).sin(), envelope * 0.8 * (2.0 * PI * 330.0 * t + 0.5).sin())
    }).unzip()
}

fn limiter() -> Box<Hyrax> {
    let mut hyrax: Box<Hyrax> = unsafe {Box::new_zeroed().assume_init()};
    hyrax.init(SAMPLE_RATE as f32, THRESHOLD);
    hyrax
}

fn run(hyrax: &mut Hyrax, left: &[f64], right: &[f64], block: usize, active: bool) -> (Vec<f32>, Vec<f32>) {
    let latency = hyrax.latency();
    let total = left.len() + latency;
    let mut out_left = Vec::with_capacity(total);
    let mut out_right = Vec::with_capacity(total);
    for start in (0..total).step_by(block) {
        let end = (start + block).min(total);
        let mut block_left: Vec<f32> = (start..end).map(|index| *left.get(index).unwrap_or(&0.0) as f32).collect();
        let mut block_right: Vec<f32> = (start..end).map(|index| *right.get(index).unwrap_or(&0.0) as f32).collect();
        hyrax.process(&mut block_left, &mut block_right, active);
        out_left.extend(block_left);
        out_right.extend(block_right);
    }
    (out_left[latency..].to_vec(), out_right[latency..].to_vec())
}

#[test]
fn matches_matchering_limiter_away_from_the_edges() {
    let (left, right) = signal();
    let (out_left, out_right) = run(&mut limiter(), &left, &right, 128, true);
    let expected = fixture("hyrax_decimated");
    let edge = SAMPLE_RATE / 2;
    let mut worst = 0.0f64;
    for (row, index) in (0..left.len()).step_by(DECIMATION).enumerate() {
        if index < edge || index > left.len() - edge {continue;}
        worst = worst.max((out_left[index] as f64 - expected[row * 2]).abs());
        worst = worst.max((out_right[index] as f64 - expected[row * 2 + 1]).abs());
    }
    assert!(worst < 1e-6, "deviates by {worst:e}");
}

#[test]
fn never_exceeds_the_threshold() {
    let (left, right) = signal();
    let (out_left, out_right) = run(&mut limiter(), &left, &right, 128, true);
    let peak = out_left.iter().chain(&out_right).fold(0.0f32, |peak, value| peak.max(value.abs()));
    assert!(peak as f64 <= THRESHOLD + 1e-6, "peak {peak}");
}

#[test]
fn block_size_does_not_change_the_result() {
    let (left, right) = signal();
    let (reference, _) = run(&mut limiter(), &left[..SAMPLE_RATE], &right[..SAMPLE_RATE], 128, true);
    for block in [1, 7, 64, 100] {
        let (actual, _) = run(&mut limiter(), &left[..SAMPLE_RATE], &right[..SAMPLE_RATE], block, true);
        assert_eq!(actual, reference, "block size {block}");
    }
}

#[test]
fn inactive_only_delays() {
    let (left, right) = signal();
    let (out_left, out_right) = run(&mut limiter(), &left[..SAMPLE_RATE], &right[..SAMPLE_RATE], 128, false);
    for index in 0..SAMPLE_RATE {
        assert_eq!(out_left[index], left[index] as f32);
        assert_eq!(out_right[index], right[index] as f32);
    }
}

#[test]
fn quiet_audio_passes_unchanged() {
    let left: Vec<f64> = (0..SAMPLE_RATE).map(|index| 0.5 * (index as f64 * 0.01).sin()).collect();
    let (out_left, _) = run(&mut limiter(), &left, &left, 128, true);
    for index in 0..SAMPLE_RATE {assert_eq!(out_left[index], left[index] as f32);}
}

#[test]
fn clear_restarts_from_silence() {
    let (left, right) = signal();
    let mut hyrax = limiter();
    let (first, _) = run(&mut hyrax, &left[..SAMPLE_RATE], &right[..SAMPLE_RATE], 128, true);
    hyrax.clear();
    let (second, _) = run(&mut hyrax, &left[..SAMPLE_RATE], &right[..SAMPLE_RATE], 128, true);
    assert_eq!(first, second);
}

#[test]
fn latency_scales_with_the_sample_rate() {
    for (rate, latency) in [(44100.0, 44 + 16 * 44), (48000.0, 48 + 16 * 48), (96000.0, 96 + 16 * 96)] {
        let mut hyrax: Box<Hyrax> = unsafe {Box::new_zeroed().assume_init()};
        hyrax.init(rate, THRESHOLD);
        assert_eq!(hyrax.latency(), latency, "rate {rate}");
    }
}

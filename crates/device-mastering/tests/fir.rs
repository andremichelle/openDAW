// The device rebuilds the matching FIR from the stored curve at the engine rate. At 44.1 kHz it must equal
// Matchering's own FIR (crates/matchering), at other rates keep the same response on the curve's bins.

use device_mastering::{taps_for, FirScratch, CURVE_BINS, MAX_TAPS};
use matchering::frequencies::fir;

fn curve() -> Vec<f64> {
    (0..CURVE_BINS).map(|bin| {
        let x = bin as f64 / (CURVE_BINS - 1) as f64;
        if bin == 0 {0.0} else {1.0 + 0.5 * (x * 12.0).sin() * (-x * 3.0).exp() + 0.2 * x}
    }).collect()
}

fn scratch() -> Box<FirScratch> {unsafe {Box::new_zeroed().assume_init()}}

fn magnitude_at(fir: &[f32], frequency: f64, sample_rate: f64) -> f64 {
    let center = (fir.len() / 2) as f64;
    let (re, im) = fir.iter().enumerate().fold((0.0, 0.0), |(re, im), (index, value)| {
        let phase = -2.0 * std::f64::consts::PI * frequency * (index as f64 - center) / sample_rate;
        (re + *value as f64 * phase.cos(), im + *value as f64 * phase.sin())
    });
    (re * re + im * im).sqrt()
}

#[test]
fn equals_matchering_fir_at_44100() {
    let curve = curve();
    let curve_f32: Vec<f32> = curve.iter().map(|value| *value as f32).collect();
    let mut output = vec![0.0f32; MAX_TAPS];
    scratch().build(&curve_f32, 4096, 44100.0, &mut output);
    let expected = fir(&curve);
    let worst = output[..4096].iter().zip(&expected)
        .fold(0.0f64, |worst, (actual, expected)| worst.max((*actual as f64 - expected).abs()));
    assert!(worst < 1e-6, "deviates by {worst:e}");
}

#[test]
fn keeps_the_response_at_other_rates() {
    let curve: Vec<f32> = curve().iter().map(|value| *value as f32).collect();
    let mut reference = vec![0.0f32; MAX_TAPS];
    scratch().build(&curve, 4096, 44100.0, &mut reference);
    for rate in [48000.0f32, 96000.0] {
        let taps = taps_for(rate);
        let mut output = vec![0.0f32; MAX_TAPS];
        scratch().build(&curve, taps, rate, &mut output);
        for frequency in [100.0, 1000.0, 5000.0, 15000.0] {
            let expected = magnitude_at(&reference[..4096], frequency, 44100.0);
            let actual = magnitude_at(&output[..taps], frequency, rate as f64);
            assert!((actual - expected).abs() < 0.02 * expected, "{rate} Hz at {frequency}: {actual} vs {expected}");
        }
    }
}

#[test]
fn taps_follow_the_sample_rate() {
    assert_eq!(taps_for(44100.0), 4096);
    assert_eq!(taps_for(48000.0), 4096);
    assert_eq!(taps_for(88200.0), 8192);
    assert_eq!(taps_for(96000.0), 8192);
    assert_eq!(taps_for(192000.0), 16384);
}

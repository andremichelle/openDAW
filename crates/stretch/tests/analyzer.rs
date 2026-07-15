//! Phase 2+3 gates on synthetic signals with known answers: the detector finds clicks where they
//! are, YIN reads a sine's period within 1%, noise reads aperiodic, harmonicity orders tonal above
//! noisy, and strength orders drum hits above pad swells.

use stretch::Analyzer;

const RATE: f32 = 48_000.0;

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

fn sine(frequency: f64, duration: f64) -> Vec<f32> {
    let count = (duration * RATE as f64) as usize;
    (0..count).map(|index| (0.5 * (2.0 * std::f64::consts::PI * frequency * index as f64 / RATE as f64).sin()) as f32).collect()
}

fn noise(duration: f64) -> Vec<f32> {
    let count = (duration * RATE as f64) as usize;
    let mut seed = 0x2545F4914F6CDD1Du64;
    (0..count).map(|_| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        ((seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5) as f32 * 0.5
    }).collect()
}

#[test]
fn detector_finds_clicks_where_they_are() {
    let positions = [0.25, 0.75, 1.25, 1.75];
    let samples = click_train(&positions, 2.2);
    let analyzed = Analyzer::default().analyze(&samples, &samples, RATE);
    for &expected in &positions {
        let hit = analyzed.markers.iter().any(|marker| (marker.position - expected).abs() < 0.015);
        assert!(hit, "click at {expected}s detected (markers: {:?})", analyzed.markers.iter().map(|m| m.position).collect::<Vec<_>>());
    }
    assert!(analyzed.markers.len() <= positions.len() + 1, "no spurious storm: {} markers", analyzed.markers.len());
}

#[test]
fn detector_resolves_sixteenth_notes_at_128_bpm() {
    // 16ths at 128 BPM are 117 ms apart — the old 120 ms min-separation missed every other hit
    // and playback smeared them. The detector must resolve realistic percussion grids.
    let positions: Vec<f64> = (0..16).map(|index| 0.25 + index as f64 * 0.1171875).collect();
    let samples = click_train(&positions, 2.5);
    let analyzed = Analyzer::default().analyze(&samples, &samples, RATE);
    for &expected in &positions {
        let hit = analyzed.markers.iter().any(|marker| (marker.position - expected).abs() < 0.02);
        assert!(hit, "16th at {expected:.3}s detected");
    }
}

#[test]
fn yin_reads_1000hz_within_a_tenth_of_a_sample() {
    let count = (1.0 * RATE as f64) as usize;
    let samples: Vec<f32> = (0..count).map(|index| (0.5 * (2.0 * std::f64::consts::PI * 1000.0 * index as f64 / RATE as f64).sin()) as f32).collect();
    let markers = Analyzer::default().describe(&samples, &samples, RATE, &[0.0]);
    let period = markers[0].period as f64;
    assert!((period - 48.0).abs() < 0.1, "1 kHz at 48 kHz is a 48.0-sample period, read {period}");
}

#[test]
fn yin_reads_a_sine_period_within_one_percent() {
    let samples = sine(220.0, 1.0);
    let markers = Analyzer::default().describe(&samples, &samples, RATE, &[0.0]);
    let period = markers[0].period as f64;
    let expected = RATE as f64 / 220.0;
    assert!((period - expected).abs() / expected < 0.01, "period {period} vs expected {expected}");
    assert!(markers[0].harmonicity > 0.6, "a pure sine is harmonic: {}", markers[0].harmonicity);
    assert!(markers[0].has_loop(), "harmonic segment precomputes a loop");
    let loop_length = markers[0].loop_end - markers[0].loop_start;
    let cycles = loop_length / period;
    assert!((cycles - cycles.round()).abs() < 0.25, "loop length ~integer periods: {cycles} cycles");
}

#[test]
fn noise_reads_aperiodic_and_un_harmonic() {
    let samples = noise(1.0);
    let markers = Analyzer::default().describe(&samples, &samples, RATE, &[0.0]);
    assert_eq!(markers[0].period, 0.0, "noise has no fundamental");
    assert!(markers[0].harmonicity <= 0.3, "noise is capped un-harmonic: {}", markers[0].harmonicity);
    assert!(!markers[0].has_loop(), "no pitch-sync loop for noise");
}

#[test]
fn strength_orders_hits_above_swells() {
    let clicks = click_train(&[0.5], 1.5);
    let click_markers = Analyzer::default().describe(&clicks, &clicks, RATE, &[0.5]);
    // A swell: the same sine fading in slowly — a weak "transient" at its marker.
    let count = (1.5 * RATE as f64) as usize;
    let swell: Vec<f32> = (0..count).map(|index| {
        let t = index as f64 / RATE as f64;
        let envelope = ((t - 0.5).max(0.0) / 0.8).min(1.0);
        (0.5 * envelope * (2.0 * std::f64::consts::PI * 220.0 * t).sin()) as f32
    }).collect();
    let swell_markers = Analyzer::default().describe(&swell, &swell, RATE, &[0.5]);
    assert!(click_markers[0].strength > 0.6, "a click is a strong transient: {}", click_markers[0].strength);
    assert!(swell_markers[0].strength < click_markers[0].strength, "swell {} < click {}", swell_markers[0].strength, click_markers[0].strength);
}

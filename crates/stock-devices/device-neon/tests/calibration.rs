//! Regression tests pinning the VirtualCZ-measured calibration (see `plans/neon.md`): the wave maps,
//! the DCA level curve and the envelope rate curve are asserted against the values measured from the
//! headless VirtualCZ probe renders. If a curve change moves these, it must be a NEW measurement.

use device_neon::calibration::{render_tone, ToneDescription};

const SR: f32 = 48_000.0;
const C4: f32 = 261.63;

fn tone(extra: &str) -> ToneDescription {
    let base = "lineSelect 0\nmodulation 0\noctave 0\ndetuneNote 0\ndetuneFine 0\nvibrato 0 0 0 0\n\
        wave 1 0 0\nkeyFollow 0 0 0\nkeyFollow 1 0 0\n\
        env 0 99 99 99 99 99 99 99 99 0 0 0 0 0 0 0 0 1 2\n\
        env 2 99 99 99 99 99 99 99 99 99 0 0 0 0 0 0 0 1 2\n\
        env 3 99 99 99 99 99 99 99 99 0 0 0 0 0 0 0 0 1 2\n\
        env 4 99 99 99 99 99 99 99 99 99 0 0 0 0 0 0 0 1 2\n\
        env 5 99 99 99 99 99 99 99 99 99 0 0 0 0 0 0 0 1 2\n";
    ToneDescription::parse(&format!("{base}{extra}"))
}

fn mono(samples: &[f32]) -> Vec<f32> {
    samples.chunks(2).map(|frame| (frame[0] + frame[1]) * 0.5).collect()
}

fn goertzel(seg: &[f32], frequency: f32) -> f32 {
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (index, sample) in seg.iter().enumerate() {
        let angle = core::f64::consts::TAU * frequency as f64 * index as f64 / SR as f64;
        re += *sample as f64 * angle.cos();
        im += *sample as f64 * angle.sin();
    }
    ((re * re + im * im).sqrt() / (seg.len() as f64 / 2.0)) as f32
}

fn harmonic_db(seg: &[f32], harmonic: u32) -> f32 {
    let h1 = goertzel(seg, C4).max(1.0e-12);
    20.0 * (goertzel(seg, C4 * harmonic as f32) / h1).max(1.0e-9).log10()
}

fn sustain_window(tone: &ToneDescription) -> Vec<f32> {
    let audio = render_tone(tone, &[(60, 0.02, 0.8)], 1.0, SR);
    mono(&audio)[(0.3 * SR) as usize..(0.6 * SR) as usize].to_vec()
}

#[test]
fn square_at_full_dcw_is_an_ideal_odd_square() {
    // Measured: h3 −9.6, h5 −14.1, h7 −17.1 (VirtualCZ square DCW ladder).
    let seg = sustain_window(&tone("wave 0 1 0\nenv 1 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0 1 2\n"));
    assert!((harmonic_db(&seg, 3) - -9.6).abs() < 2.0, "h3 {}", harmonic_db(&seg, 3));
    assert!((harmonic_db(&seg, 5) - -14.1).abs() < 2.0, "h5 {}", harmonic_db(&seg, 5));
    assert!(harmonic_db(&seg, 2) < -30.0, "square has no even harmonics, h2 {}", harmonic_db(&seg, 2));
}

#[test]
fn double_sine_at_full_dcw_is_a_fundamental_with_a_flat_shelf() {
    // Measured: h2 −22.7, h3 −24.7, h4 −25.3, h6 −25.6 — flat ≈ −24dB shelf (NOT an octave sweep).
    let seg = sustain_window(&tone("wave 0 3 0\nenv 1 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0 1 2\n"));
    for harmonic in [2u32, 3, 4, 6] {
        let level = harmonic_db(&seg, harmonic);
        assert!((-29.0..=-19.0).contains(&level), "h{harmonic} {level} outside the measured shelf");
    }
}

#[test]
fn double_sine_at_zero_dcw_is_a_pure_octave() {
    // Measured: at DCW 0 double sine renders TWO equal cycles — the octave, not the fundamental.
    let seg = sustain_window(&tone("wave 0 3 0\nenv 1 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 2\n"));
    let h1 = goertzel(&seg, C4);
    let h2 = goertzel(&seg, C4 * 2.0);
    assert!(h2 > h1 * 10.0, "octave dominates: h1 {h1} h2 {h2}");
}

#[test]
fn saw_pulse_at_full_dcw_is_a_bright_saw_like_spectrum() {
    // Measured: h2 −6.0, h3 −12.0, h5 −16.5 (VirtualCZ sawpulse DCW ladder, knee d = 0.5 − 0.478w).
    let seg = sustain_window(&tone("wave 0 4 0\nenv 1 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0 1 2\n"));
    assert!((harmonic_db(&seg, 2) - -6.0).abs() < 1.5, "h2 {}", harmonic_db(&seg, 2));
    assert!((harmonic_db(&seg, 5) - -16.5).abs() < 2.0, "h5 {}", harmonic_db(&seg, 5));
}

fn subharmonic_ratio_db(tone: &ToneDescription) -> (f32, f32) {
    let audio = render_tone(tone, &[(60, 0.02, 0.8)], 1.0, SR);
    let seg = mono(&audio)[(0.3 * SR) as usize..(0.6 * SR) as usize].to_vec();
    let h1 = goertzel(&seg, C4).max(1.0e-12);
    let sub = goertzel(&seg, C4 * 0.5);
    let h2 = goertzel(&seg, C4 * 2.0);
    (20.0 * (sub / h1).log10(), 20.0 * (h2 / h1).max(1.0e-9).log10())
}

#[test]
fn square_saw_alternation_reverses_the_saw_cycle() {
    // Measured (VirtualCZ pair probe): the f/2 subharmonic sits ≈ +14dB ABOVE the fundamental —
    // only the opposite-orientation (time-reversed saw cycle) pairing produces that.
    let pair = tone("wave 0 1 1\nenv 1 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0 1 2\n");
    let (sub_db, _) = subharmonic_ratio_db(&pair);
    assert!(sub_db > 8.0, "square/saw subharmonic measured {sub_db} dB, expected ≈ +14");
}

#[test]
fn saw_sawpulse_alternation_stays_forward_with_even_nulls() {
    // Measured: same-orientation pairing — subharmonic BELOW the fundamental (−7.3dB) and a deep
    // even-harmonic null (h2 −26dB); the reversed pairing would push the subharmonic to +7dB.
    let pair = tone("wave 0 0 5\nenv 1 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0 1 2\n");
    let (sub_db, h2_db) = subharmonic_ratio_db(&pair);
    assert!(sub_db < -3.0, "saw/sawpulse subharmonic measured {sub_db} dB, expected ≈ −7");
    assert!(h2_db < -18.0, "saw/sawpulse h2 measured {h2_db} dB, expected ≈ −26 (even null)");
}

#[test]
fn dca_level_50_sits_at_the_measured_minus_24_db() {
    let loud = sustain_window(&tone("wave 0 0 0\nenv 1 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 2\n"));
    let quiet = sustain_window(&tone("wave 0 0 0\nenv 1 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 2\n\
        env 2 99 99 99 99 99 99 99 99 50 0 0 0 0 0 0 0 1 2\n"));
    let rms = |seg: &[f32]| (seg.iter().map(|value| value * value).sum::<f32>() / seg.len() as f32).sqrt();
    let ratio_db = 20.0 * (rms(&quiet) / rms(&loud)).max(1.0e-9).log10();
    assert!((ratio_db - -23.7).abs() < 2.5, "level 50 measured {ratio_db} dB, expected ≈ -23.7");
}

#[test]
fn envelope_rate_60_full_swing_is_about_200ms() {
    // Measured: 197ms (staircase probe). Attack 0→99 at rate 60, level sustained.
    let tone = tone("wave 0 0 0\nenv 1 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 2\n\
        env 2 60 99 99 99 99 99 99 99 99 0 0 0 0 0 0 0 1 2\n");
    let audio = render_tone(&tone, &[(60, 0.0, 1.2)], 1.5, SR);
    let samples = mono(&audio);
    let window = (0.01 * SR) as usize;
    let rms_at = |t: f32| {
        let start = (t * SR) as usize;
        (samples[start..start + window].iter().map(|v| v * v).sum::<f32>() / window as f32).sqrt()
    };
    let full = rms_at(0.6);
    let mut reached = 0.0f32;
    let mut t = 0.01;
    while t < 0.6 {
        if rms_at(t) >= full * 0.93 {
            reached = t;
            break;
        }
        t += 0.005;
    }
    assert!((0.13..=0.28).contains(&reached), "rate 60 attack measured {reached}s, expected ≈ 0.197s");
}

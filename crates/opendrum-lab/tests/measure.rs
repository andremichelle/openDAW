// Every measure is checked on synthetic hits whose true values are known analytically.

use math::random::Mulberry32;
use opendrum_lab::measure::{measure, CENTROID_TIMES_MS, PITCH_TIMES_MS};
use std::f64::consts::PI;

const RATE: f64 = 44100.0;

fn render(seconds: f64, mut sample: impl FnMut(f64) -> f64) -> Vec<f64> {
    (0..(seconds * RATE) as usize).map(|index| sample(index as f64 / RATE)).collect()
}

fn decaying_sine(frequency: f64, tau: f64) -> Vec<f64> {
    render(1.0, |time| (2.0 * PI * frequency * time).sin() * (-time / tau).exp())
}

fn noise(seed: u32) -> impl FnMut() -> f64 {
    let mut random = Mulberry32::new(seed);
    move || random.next_double(-1.0, 1.0)
}

fn pitch_at(measures: &opendrum_lab::measure::Measures, ms: f64) -> f64 {
    measures.pitch_hz[PITCH_TIMES_MS.iter().position(|time| *time == ms).unwrap()]
}

#[test]
fn steady_sine_pitch_and_partial() {
    let measures = measure(&decaying_sine(60.0, 0.2), RATE);
    for ms in [20.0, 40.0, 80.0, 160.0] {
        let pitch = pitch_at(&measures, ms);
        assert!((pitch - 60.0).abs() < 0.5, "{ms} ms: {pitch}");
    }
    assert!((measures.partials[0].0 - 60.0).abs() < 1.0, "{:?}", measures.partials);
}

#[test]
fn decay_times_follow_the_time_constant() {
    let tau = 0.1;
    let measures = measure(&decaying_sine(200.0, tau), RATE);
    let expected20 = tau * 10f64.ln() * 1000.0 + 10.0;
    let expected40 = 2.0 * tau * 10f64.ln() * 1000.0 + 10.0;
    assert!((measures.decay20_ms - expected20).abs() < 3.0, "{} vs {expected20}", measures.decay20_ms);
    assert!((measures.decay40_ms - expected40).abs() < 3.0, "{} vs {expected40}", measures.decay40_ms);
    assert!(measures.peak_ms <= 12.0, "{}", measures.peak_ms);
}

#[test]
fn pitch_sweep_is_tracked() {
    let mut phase = 0.0;
    let samples = render(0.5, |time| {
        let frequency = 50.0 + 80.0 * (-time / 0.015).exp();
        phase += 2.0 * PI * frequency / RATE;
        phase.sin() * (-time / 0.2).exp()
    });
    let measures = measure(&samples, RATE);
    let early = pitch_at(&measures, 10.0);
    let expected = 50.0 + 80.0 * (-0.010f64 / 0.015).exp();
    assert!((early - expected).abs() < expected * 0.08, "10 ms: {early} vs {expected}");
    assert!((pitch_at(&measures, 160.0) - 50.0).abs() < 1.0);
    let (first_ms, first_hz) = measures.first_period;
    assert!(first_ms < 8.0 && first_hz > 100.0, "first period {first_ms} ms {first_hz} Hz");
}

#[test]
fn two_partials_are_found() {
    let samples = render(0.5, |time| {
        ((2.0 * PI * 238.0 * time).sin() + 0.5 * (2.0 * PI * 476.0 * time).sin()) * (-time / 0.1).exp()
    });
    let measures = measure(&samples, RATE);
    let found: Vec<f64> = measures.partials.iter().map(|(hz, _)| *hz).collect();
    assert!(found.iter().any(|hz| (hz - 238.0).abs() < 2.0), "{found:?}");
    assert!(found.iter().any(|hz| (hz - 476.0).abs() < 3.0), "{found:?}");
    let second = measures.partials.iter().find(|(hz, _)| (hz - 476.0).abs() < 3.0).unwrap().1;
    assert!((second + 6.0).abs() < 1.5, "476 Hz level {second} dB, expected about -6");
}

#[test]
fn noise_floor_separates_noise_from_tone() {
    let mut next = noise(7);
    let noisy = render(0.3, |time| next() * (-time / 0.05).exp());
    let tonal = decaying_sine(300.0, 0.1);
    let noisy = measure(&noisy, RATE);
    let tonal = measure(&tonal, RATE);
    assert!(noisy.noise_early_db > -4.0, "noise {}", noisy.noise_early_db);
    assert!(tonal.noise_early_db < -60.0, "sine {}", tonal.noise_early_db);
    assert!(noisy.centroid_hz[0] > 5000.0 && tonal.centroid_hz[CENTROID_TIMES_MS.len() - 1] < 1000.0);
}

#[test]
fn bands_sum_to_the_whole() {
    let mut next = noise(3);
    let measures = measure(&render(0.3, |time| next() * (-time / 0.05).exp()), RATE);
    let total: f64 = measures.bands_early_db.iter().map(|db| 10f64.powf(db / 10.0)).sum();
    assert!(total > 0.9 && total <= 1.0001, "{total}");
    assert!(measures.bands_early_db[9] > measures.bands_early_db[2], "white noise rises per octave");
}

#[test]
fn clap_bursts_are_counted() {
    let mut next = noise(11);
    let starts = [0.0, 0.010, 0.020, 0.030];
    let samples = render(0.3, |time| {
        let gain = starts.iter().filter(|start| time >= **start).map(|start| (-(time - start) / 0.002).exp())
            .fold(0.0, f64::max);
        next() * gain
    });
    let measures = measure(&samples, RATE);
    assert_eq!(measures.bursts_ms.len(), 4, "{:?}", measures.bursts_ms);
    for (found, start) in measures.bursts_ms.iter().zip(starts) {
        assert!((found - start * 1000.0).abs() < 2.0, "{:?}", measures.bursts_ms);
    }
}

#[test]
fn silence_measures_nothing() {
    let measures = measure(&vec![0.0; 1000], RATE);
    assert!(measures.pitch_hz.is_empty() && measures.partials.is_empty());
}


#[test]
fn noise_floor_finds_quiet_noise_under_a_loud_tone() {
    let mut next = noise(5);
    let samples = render(0.3, |time| ((2.0 * PI * 90.0 * time).sin() + 0.03 * next()) * (-time / 0.1).exp());
    let measures = measure(&samples, RATE);
    assert!(measures.noise_early_db > -40.0 && measures.noise_early_db < -15.0, "{}", measures.noise_early_db);
}

#[test]
fn a_tone_has_no_bursts() {
    let measures = measure(&decaying_sine(90.0, 0.1), RATE);
    assert!(measures.bursts_ms.len() <= 1, "{:?}", measures.bursts_ms);
}

#[test]
fn two_tones_are_followed_separately_early_and_late() {
    let samples = render(0.5, |time| {
        (2.0 * PI * 149.0 * time).sin() * (-time / 0.08).exp() + 0.8 * (2.0 * PI * 217.0 * time).sin() * (-time / 0.025).exp()
    });
    let measures = measure(&samples, RATE);
    let (early, late) = (&measures.tones_early, &measures.tones_late);
    assert_eq!(early.len(), 2, "{early:?}");
    assert!((early[0].0 - 149.0).abs() < 3.0 && (early[1].0 - 217.0).abs() < 3.0, "{early:?}");
    assert!((late[0].0 - 149.0).abs() < 3.0, "{late:?}");
    let high_late = late.iter().find(|(hz, _)| (hz - 217.0).abs() < 5.0).map(|(_, db)| *db).unwrap_or(-100.0);
    let high_early = early[1].1;
    assert!(high_late < high_early - 10.0, "the faster tone falls behind, early {high_early} late {high_late}");
}

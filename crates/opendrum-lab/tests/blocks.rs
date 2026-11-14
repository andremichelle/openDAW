// The common dsp blocks rendered as hits and read back through the report card measures.

use dsp::drum_oscillator::DrumOscillator;
use dsp::hit_envelope::HitEnvelope;
use dsp::noise::{ShiftRegisterNoise, WhiteNoise};
use dsp::resonator::{Resonator, ResonatorCoefficients};
use dsp::svf::{Svf, SvfCoefficients};
use opendrum_lab::measure::{measure, PITCH_TIMES_MS};

const RATE: f32 = 44100.0;

fn hit(seconds: f32, mut sample: impl FnMut(usize) -> f32) -> Vec<f64> {
    (0..(seconds * RATE) as usize).map(|index| sample(index) as f64).collect()
}

fn pitch_at(pitch: &[f64], ms: f64) -> f64 {pitch[PITCH_TIMES_MS.iter().position(|time| *time == ms).unwrap()]}

#[test]
fn struck_resonator_with_a_pitch_kick_reads_like_a_resonator_kick() {
    let mut resonator = Resonator::default();
    let samples = hit(1.0, |index| {
        let time = index as f32 / RATE;
        let frequency = if time < 0.006 {130.0} else {50.0 + 80.0 * libm::expf(-(time - 0.006) / 0.004)};
        resonator.process(if index == 0 {1.0} else {0.0}, &ResonatorCoefficients::new(frequency, 0.3, RATE))
    });
    let measures = measure(&samples, RATE as f64);
    assert!(measures.first_period.1 > 90.0, "attack pitch {:?}", measures.first_period);
    assert!((pitch_at(&measures.pitch_hz, 80.0) - 50.0).abs() < 1.0);
    assert!((measures.decay40_ms - 210.0).abs() < 10.0, "40 dB of a 300 ms (-60 dB) decay plus half the 20 ms window, {}", measures.decay40_ms);
    assert!(measures.noise_early_db < -50.0, "a pure ring has no noise, {}", measures.noise_early_db);
}

#[test]
fn shaped_triangle_with_a_falling_pitch_tracks_its_sweep() {
    let mut oscillator = DrumOscillator::default();
    let mut envelope = HitEnvelope::default();
    envelope.set(0.0, 0.02, 0.4, RATE);
    envelope.trigger(1.0);
    let samples = hit(0.6, |index| {
        let frequency = 50.0 + 110.0 * libm::expf(-(index as f32 / RATE) / 0.012);
        oscillator.triangle(frequency, RATE, 1.6) * envelope.next()
    });
    let measures = measure(&samples, RATE as f64);
    let expected = 50.0 + 110.0 * (-0.020f64 / 0.012).exp();
    assert!((pitch_at(&measures.pitch_hz, 20.0) - expected).abs() < expected * 0.08, "{:?}", measures.pitch_hz);
    assert!(measures.partials[0].0 > 45.0 && measures.partials[0].0 < 60.0, "{:?}", measures.partials);
}

#[test]
fn dark_noise_shows_in_the_low_band_only() {
    let mut noise = WhiteNoise::default();
    noise.reset(9);
    let mut filter = Svf::default();
    let coefficients = SvfCoefficients::new(600.0, 0.707, RATE);
    let mut envelope = HitEnvelope::default();
    envelope.set(0.0, 0.0, 0.3, RATE);
    envelope.trigger(1.0);
    let samples = hit(0.4, |_| filter.process(noise.next(), &coefficients).low * envelope.next());
    let measures = measure(&samples, RATE as f64);
    assert!(measures.noise_low_early_db > measures.noise_early_db + 20.0,
            "low {} vs full {}", measures.noise_low_early_db, measures.noise_early_db);
}

#[test]
fn shift_register_noise_is_noise_and_renders_identically() {
    let render = || {
        let mut noise = ShiftRegisterNoise::default();
        noise.reset(3);
        let mut envelope = HitEnvelope::default();
        envelope.set(0.0, 0.0, 0.2, RATE);
        envelope.trigger(1.0);
        hit(0.3, |_| noise.next(0.8) * envelope.next())
    };
    let (first, second) = (render(), render());
    assert_eq!(first, second);
    assert!(measure(&first, RATE as f64).noise_early_db > -6.0);
}

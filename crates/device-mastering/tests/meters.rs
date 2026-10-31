// BS.1770 reference behaviour: a 1 kHz sine at -20 dBFS on both channels reads about -20 LUFS (the K-weighting
// adds about +0.7 dB at 1 kHz, the -0.691 offset removes it), gating drops silence, correlation spans -1..+1.

use std::f64::consts::PI;
use device_mastering::meters::{Correlation, Loudness, SILENCE};

const SAMPLE_RATE: f32 = 48000.0;

fn sine(seconds: f64, frequency: f64, amplitude: f64) -> Vec<f32> {
    (0..(seconds * SAMPLE_RATE as f64) as usize)
        .map(|index| (amplitude * (2.0 * PI * frequency * index as f64 / SAMPLE_RATE as f64).sin()) as f32).collect()
}

fn loudness() -> Box<Loudness> {
    let mut meter: Box<Loudness> = unsafe {Box::new_zeroed().assume_init()};
    meter.init(SAMPLE_RATE);
    meter
}

fn feed(meter: &mut Loudness, left: &[f32], right: &[f32]) {
    for (left, right) in left.chunks(128).zip(right.chunks(128)) {meter.process(left, right);}
}

#[test]
fn sine_at_minus_20_reads_minus_20_lufs() {
    let mut meter = loudness();
    let signal = sine(5.0, 1000.0, 0.1);
    feed(&mut meter, &signal, &signal);
    assert!((meter.short_term() - -20.0).abs() < 0.1, "short-term {}", meter.short_term());
    assert!((meter.integrated() - -20.0).abs() < 0.1, "integrated {}", meter.integrated());
}

#[test]
fn silence_is_gated_out_of_the_integrated_loudness() {
    let mut meter = loudness();
    let signal = sine(5.0, 1000.0, 0.1);
    let silence = vec![0.0f32; signal.len()];
    feed(&mut meter, &signal, &signal);
    feed(&mut meter, &silence, &silence);
    // the 400 ms gating blocks straddling the end of the sine pass the gate and pull it down slightly
    assert!((meter.integrated() - -20.0).abs() < 0.2, "integrated {}", meter.integrated());
    assert!(meter.short_term() < -100.0, "short-term {}", meter.short_term());
}

#[test]
fn relative_gate_ignores_much_quieter_passages() {
    let mut meter = loudness();
    let loud = sine(5.0, 1000.0, 0.1);
    let quiet = sine(5.0, 1000.0, 0.001);
    feed(&mut meter, &loud, &loud);
    feed(&mut meter, &quiet, &quiet);
    assert!((meter.integrated() - -20.0).abs() < 0.2, "integrated {}", meter.integrated());
}

#[test]
fn starts_silent_and_clears() {
    let mut meter = loudness();
    assert_eq!(meter.integrated(), SILENCE);
    assert_eq!(meter.short_term(), SILENCE);
    let signal = sine(1.0, 1000.0, 0.1);
    feed(&mut meter, &signal, &signal);
    meter.clear();
    assert_eq!(meter.integrated(), SILENCE);
}

#[test]
fn correlation_spans_mono_to_inverted() {
    let mut correlation: Box<Correlation> = unsafe {Box::new_zeroed().assume_init()};
    correlation.init(SAMPLE_RATE);
    let signal = sine(1.0, 440.0, 0.5);
    let inverted: Vec<f32> = signal.iter().map(|value| -value).collect();
    correlation.process(&signal, &signal);
    assert!((correlation.value() - 1.0).abs() < 1e-3);
    correlation.clear();
    correlation.process(&signal, &inverted);
    assert!((correlation.value() + 1.0).abs() < 1e-3);
    correlation.clear();
    assert_eq!(correlation.value(), 0.0);
}

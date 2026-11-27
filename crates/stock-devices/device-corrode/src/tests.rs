use super::corrode::{Corrode, MAX_DEVIATION_SECONDS, MODE_NOISE, MODE_SINE, MODE_WIDE_NOISE};
use super::{map_parameter, CorrodeDevice, CorrodeState};
use abi::{AudioEffect, ParamValue};
use core::f64::consts::TAU;

const BLOCK: usize = 128;

fn corrode(sample_rate: f32, mode: i32, frequency: f32, width: f32, amount: f32) -> Box<Corrode> {
    let mut dsp: Box<Corrode> = Box::new(unsafe { core::mem::zeroed() });
    dsp.init(sample_rate);
    dsp.set_mode(mode);
    dsp.set_frequency(frequency);
    dsp.set_width(width);
    dsp.set_amount(amount);
    dsp
}

fn render(dsp: &mut Corrode, left: &[f32], right: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let (mut out_left, mut out_right) = (vec![0.0f32; left.len()], vec![0.0f32; left.len()]);
    let mut from = 0;
    while from < left.len() {
        let to = (from + BLOCK).min(left.len());
        dsp.process(left, right, &mut out_left, &mut out_right, from, to);
        from = to;
    }
    (out_left, out_right)
}

fn sine(frequency: f64, sample_rate: f64, amplitude: f64, length: usize) -> Vec<f32> {
    (0..length).map(|index| (amplitude * (TAU * frequency * index as f64 / sample_rate).sin()) as f32).collect()
}

// Amplitude of one frequency over a window holding a whole number of its periods.
fn magnitude(signal: &[f32], frequency: f64, sample_rate: f64) -> f64 {
    let (mut re, mut im) = (0.0, 0.0);
    for (index, value) in signal.iter().enumerate() {
        let phase = TAU * frequency * index as f64 / sample_rate;
        re += *value as f64 * phase.cos();
        im -= *value as f64 * phase.sin();
    }
    2.0 * (re * re + im * im).sqrt() / signal.len() as f64
}

fn bessel(order: i32, x: f64) -> f64 {
    let mut sum = 0.0;
    let mut factorial_k = 1.0;
    for k in 0..30 {
        if k > 0 {factorial_k *= k as f64}
        let factorial_kn: f64 = (1..=(k + order)).map(|value| value as f64).product();
        let sign = if k % 2 == 0 {1.0} else {-1.0};
        sum += sign * (x / 2.0).powi(2 * k + order) / (factorial_k * factorial_kn);
    }
    sum
}

fn correlation(first: &[f64], second: &[f64]) -> f64 {
    let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>();
    dot(first, second) / (dot(first, first) * dot(second, second)).sqrt()
}

#[test]
fn sine_mode_produces_phase_modulation_sidebands() {
    let sample_rate = 48_000.0;
    let (carrier, modulator, amount) = (1_000.0, 6_000.0, 50.0);
    let mut dsp = corrode(sample_rate as f32, MODE_SINE, modulator as f32, 1.0, amount as f32);
    let input = sine(carrier, sample_rate, 0.5, 48_000);
    let (left, right) = render(&mut dsp, &input, &input);
    let window = &left[9_600..14_400];
    let depth = (amount / 100.0) * (amount / 100.0) * MAX_DEVIATION_SECONDS;
    let beta = TAU * carrier * depth;
    let expected = |order: i32| 0.5 * bessel(order, beta).abs();
    for (frequency, order) in [(carrier, 0), (modulator - carrier, 1), (modulator + carrier, 1),
                               (2.0 * modulator - carrier, 2), (2.0 * modulator + carrier, 2)] {
        let measured = magnitude(window, frequency, sample_rate);
        let want = expected(order);
        assert!((measured - want).abs() < 0.08 * want + 2.0e-3,
            "{frequency} Hz: measured {measured}, expected J{order}(β) = {want}");
    }
    assert!(magnitude(window, 3_000.0, sample_rate) < 1.0e-3, "no energy between the sidebands");
    assert_eq!(left, right, "sine modulation is the same on both channels");
}

#[test]
fn wide_noise_decorrelates_the_channels() {
    let sample_rate = 48_000.0;
    let input = sine(2_000.0, sample_rate, 0.5, 48_000);
    let residuals = |mode: i32| {
        let mut dsp = corrode(sample_rate as f32, mode, 3_000.0, 2.0, 10.0);
        let latency = dsp.latency() as usize;
        let (left, right) = render(&mut dsp, &input, &input);
        let residual = |output: &[f32]| -> Vec<f64> {
            (4_800..48_000).map(|index| (output[index] - input[index - latency]) as f64).collect()
        };
        (residual(&left), residual(&right))
    };
    let (mono_left, mono_right) = residuals(MODE_NOISE);
    assert!(mono_left.iter().map(|value| value * value).sum::<f64>() > 1.0e-3, "noise mode modulates");
    assert!(correlation(&mono_left, &mono_right) > 0.999, "noise mode uses one modulator for both channels");
    let (wide_left, wide_right) = residuals(MODE_WIDE_NOISE);
    let wide = correlation(&wide_left, &wide_right);
    assert!(wide.abs() < 0.2, "wide noise modulates each channel independently, correlation {wide}");
}

#[test]
fn zero_amount_is_a_pure_delay_by_the_latency() {
    let mut dsp = corrode(48_000.0, MODE_NOISE, 3_000.0, 1.0, 0.0);
    let latency = dsp.latency() as usize;
    assert!(latency >= 48 && latency < 64, "about one millisecond, got {latency}");
    let input: Vec<f32> = (0..4_096).map(|index| ((index * 7919) % 2001) as f32 / 1000.0 - 1.0).collect();
    let (left, right) = render(&mut dsp, &input, &input);
    for index in latency..input.len() {
        assert_eq!(left[index], input[index - latency]);
        assert_eq!(right[index], input[index - latency]);
    }
}

#[test]
fn extremes_stay_finite_and_bounded() {
    for sample_rate in [44_100.0f32, 192_000.0] {
        for mode in [MODE_NOISE, MODE_WIDE_NOISE, MODE_SINE] {
            for frequency in [50.0f32, 18_000.0] {
                for width in [0.08f32, 10.0] {
                    for amount in [0.0f32, 100.0] {
                        let mut dsp = corrode(sample_rate, mode, frequency, width, amount);
                        let loud: Vec<f32> = (0..8_192).map(|index| if index % 2 == 0 {1.0} else {-1.0}).collect();
                        let (left, right) = render(&mut dsp, &loud, &loud);
                        for value in left.iter().chain(right.iter()) {
                            assert!(value.is_finite() && value.abs() < 2.0,
                                "sr {sample_rate} mode {mode} f {frequency} w {width} a {amount}: {value}");
                        }
                        dsp.reset();
                        let silence = vec![0.0f32; 4_096];
                        let (left, _) = render(&mut dsp, &silence, &silence);
                        assert!(left.iter().all(|value| *value == 0.0), "silence stays silent");
                    }
                }
            }
        }
    }
}

#[test]
fn parameter_jumps_every_block_stay_finite() {
    let mut dsp = corrode(48_000.0, MODE_NOISE, 3_000.0, 1.0, 50.0);
    let input = sine(440.0, 48_000.0, 0.9, BLOCK);
    let (mut left, mut right) = (vec![0.0f32; BLOCK], vec![0.0f32; BLOCK]);
    for round in 0..2_000 {
        dsp.set_mode((round % 3) as i32);
        dsp.set_frequency(if round % 2 == 0 {50.0} else {18_000.0});
        dsp.set_width(if round % 5 < 2 {0.08} else {10.0});
        dsp.set_amount(if round % 7 < 3 {0.0} else {100.0});
        dsp.process(&input, &input, &mut left, &mut right, 0, BLOCK);
        assert!(left.iter().chain(right.iter()).all(|value| value.is_finite() && value.abs() < 2.0));
    }
}

#[test]
fn parameters_route_to_the_dsp_and_report_latency() {
    let mut state: Box<CorrodeState> = Box::new(unsafe { core::mem::zeroed() });
    CorrodeDevice::init(&mut state, 48_000.0);
    assert_eq!(abi::native_latency(), state.dsp.latency());
    state.mode_id = 1;
    state.frequency_id = 2;
    state.width_id = 3;
    state.amount_id = 4;
    CorrodeDevice::parameter_changed(&mut state, 4, ParamValue::Float(0.0));
    let input = sine(1_000.0, 48_000.0, 0.5, 1_024);
    let mut left = vec![0.0f32; 1_024];
    let mut right = vec![0.0f32; 1_024];
    state.dsp.process(&input, &input, &mut left, &mut right, 0, 1_024);
    let latency = state.dsp.latency() as usize;
    assert_eq!(left[latency + 100], input[100], "amount 0 routed");
    assert_eq!(map_parameter(0, 1.0), 2.0);
    assert!((map_parameter(1, 0.0) - 50.0).abs() < 1.0e-3 && (map_parameter(1, 1.0) - 18_000.0).abs() < 0.1);
    assert!((map_parameter(2, 0.0) - 0.08).abs() < 1.0e-6 && (map_parameter(2, 1.0) - 10.0).abs() < 1.0e-4);
    assert_eq!(map_parameter(3, 0.5), 50.0);
}

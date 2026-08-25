// Correctness tests for the partitioned convolver: the oracle is direct time-domain convolution.
// Sparse random IRs (a few hundred taps spread over the full length, with taps pinned to every
// level boundary) keep the oracle O(taps * samples) so the suite stays fast in debug builds,
// while exercising exactly the same partition arithmetic as a dense IR (convolution is linear).

use dsp::convolution::{Convolver, BLOCK, MAX_IR_FRAMES};
use dsp::rfft::FftTables;

struct Rng(u64);

impl Rng {
    fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f32 / (1u64 << 31) as f32) - 1.0
    }
}

// alloc_zeroed, NOT Box::new(zeroed()): the state is megabytes and would blow the debug stack
fn boxed_zeroed<T>() -> Box<T> {
    let layout = std::alloc::Layout::new::<T>();
    unsafe { Box::from_raw(std::alloc::alloc_zeroed(layout) as *mut T) }
}

fn boxed_convolver() -> Box<Convolver> {
    let mut convolver = boxed_zeroed::<Convolver>();
    convolver.init();
    convolver
}

// Direct reference: y[t] = sum taps g * x[t - delay], per channel.
fn reference(taps: &[(usize, f32, f32)], input: &[Vec<f32>; 2], length: usize) -> [Vec<f32>; 2] {
    let mut out = [vec![0.0f32; length], vec![0.0f32; length]];
    for &(delay, left, right) in taps {
        for t in delay..length {
            out[0][t] += left * input[0][t - delay];
            out[1][t] += right * input[1][t - delay];
        }
    }
    out
}

fn sparse_ir(rng: &mut Rng, frames: usize, count: usize) -> (Vec<f32>, Vec<f32>, Vec<(usize, f32, f32)>) {
    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    let mut taps = Vec::new();
    let boundaries = [0usize, 1, 127, 128, 129, 2047, 2048, 2049, 16383, 16384, 16385, frames - 1];
    for &delay in boundaries.iter().filter(|&&delay| delay < frames) {
        taps.push(delay);
    }
    for _ in 0..count {
        taps.push(((rng.next_f32() * 0.5 + 0.5) * (frames - 1) as f32) as usize);
    }
    taps.sort_unstable();
    taps.dedup();
    let mut result = Vec::new();
    for delay in taps {
        let gain_l = rng.next_f32();
        let gain_r = rng.next_f32();
        left[delay] = gain_l;
        right[delay] = gain_r;
        result.push((delay, gain_l, gain_r));
    }
    (left, right, result)
}

fn run_convolver(convolver: &mut Convolver, input: &[Vec<f32>; 2], length: usize) -> [Vec<f32>; 2] {
    let mut out = [vec![0.0f32; length], vec![0.0f32; length]];
    let mut cursor = 0;
    while cursor < length {
        let end = (cursor + BLOCK).min(length);
        let (in_l, in_r) = (&input[0][cursor..end], &input[1][cursor..end]);
        let (head, tail) = out.split_at_mut(1);
        convolver.process(in_l, in_r, &mut head[0][cursor..end], &mut tail[0][cursor..end], 0, end - cursor);
        cursor = end;
    }
    out
}

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

fn assert_close(actual: &[Vec<f32>; 2], expected: &[Vec<f32>; 2], tolerance: f32, label: &str) {
    let peak = expected[0].iter().chain(&expected[1]).fold(0.0f32, |a, &v| a.max(v.abs())).max(1e-6);
    for channel in 0..2 {
        let diff = max_abs_diff(&actual[channel], &expected[channel]);
        assert!(diff <= tolerance * peak, "{label} ch{channel}: max diff {diff} > {} (peak {peak})", tolerance * peak);
        assert!(actual[channel].iter().all(|value| value.is_finite()), "{label} ch{channel}: non-finite output");
    }
}

fn full_load(convolver: &mut Convolver, ir_l: &[f32], ir_r: &[f32], stereo: bool, normalize: bool, reverse: bool) {
    convolver.begin_load(ir_l, ir_r, stereo, normalize, reverse);
    while convolver.load_step(ir_l, ir_r, 64) {}
}

fn noise(rng: &mut Rng, length: usize) -> [Vec<f32>; 2] {
    [(0..length).map(|_| rng.next_f32()).collect(), (0..length).map(|_| rng.next_f32()).collect()]
}

#[test]
fn rfft_forward_matches_dft_and_inverse_roundtrips() {
    for n in [8usize, 256, 2048, 16384] {
        let mut rng = Rng(7 + n as u64);
        let mut tables = boxed_zeroed::<FftTables<8193>>();
        tables.init(n);
        let input: Vec<f32> = (0..n).map(|_| rng.next_f32()).collect();
        let mut spec_re = vec![0.0f32; n / 2 + 1];
        let mut spec_im = vec![0.0f32; n / 2 + 1];
        let mut sc_re = vec![0.0f32; n / 2];
        let mut sc_im = vec![0.0f32; n / 2];
        tables.forward(&input, &mut spec_re, &mut spec_im, &mut sc_re, &mut sc_im);
        // direct DFT on a few bins (full DFT at 16384 would be slow in debug)
        for k in [0usize, 1, n / 4, n / 2 - 1, n / 2] {
            let mut re = 0.0f64;
            let mut im = 0.0f64;
            for (index, &value) in input.iter().enumerate() {
                let angle = -2.0 * std::f64::consts::PI * (k * index) as f64 / n as f64;
                re += value as f64 * angle.cos();
                im += value as f64 * angle.sin();
            }
            assert!((spec_re[k] as f64 - re).abs() < 1e-2 * (n as f64).sqrt(), "n={n} bin {k} re {re} vs {}", spec_re[k]);
            assert!((spec_im[k] as f64 - im).abs() < 1e-2 * (n as f64).sqrt(), "n={n} bin {k} im {im} vs {}", spec_im[k]);
        }
        let mut output = vec![0.0f32; n];
        tables.inverse(&spec_re, &spec_im, &mut output, &mut sc_re, &mut sc_im);
        assert!(max_abs_diff(&input, &output) < 1e-4, "n={n} roundtrip");
    }
}

#[test]
fn matches_reference_full_length_sparse_ir() {
    let mut rng = Rng(42);
    let frames = 100000; // spans head + all three levels
    let (ir_l, ir_r, taps) = sparse_ir(&mut rng, frames, 300);
    let length = 128 * 1200; // > frames + several L3 periods
    let input = noise(&mut rng, length);
    let expected = reference(&taps, &input, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir_l, &ir_r, true, false, false);
    let actual = run_convolver(&mut convolver, &input, length);
    assert_close(&actual, &expected, 2e-3, "full-length");
}

#[test]
fn matches_reference_short_irs() {
    for frames in [1usize, 64, 128, 129, 2048, 2049, 16384, 16385] {
        let mut rng = Rng(100 + frames as u64);
        let (ir_l, ir_r, taps) = sparse_ir(&mut rng, frames, 40);
        let length = 128 * ((frames * 2 / 128) + 16);
        let input = noise(&mut rng, length);
        let expected = reference(&taps, &input, length);
        let mut convolver = boxed_convolver();
        convolver.dry_gain = 0.0;
        full_load(&mut convolver, &ir_l, &ir_r, true, false, false);
        let actual = run_convolver(&mut convolver, &input, length);
        assert_close(&actual, &expected, 2e-3, &format!("short ir {frames}"));
    }
}

#[test]
fn mono_ir_duplicates_left() {
    let mut rng = Rng(9);
    let (ir_l, _, taps) = sparse_ir(&mut rng, 5000, 60);
    let mono_taps: Vec<(usize, f32, f32)> = taps.iter().map(|&(d, l, _)| (d, l, l)).collect();
    let length = 128 * 100;
    let input = noise(&mut rng, length);
    let expected = reference(&mono_taps, &input, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir_l, &[], false, false, false);
    let actual = run_convolver(&mut convolver, &input, length);
    assert_close(&actual, &expected, 2e-3, "mono");
}

#[test]
fn reversed_ir_matches_reversed_reference() {
    let mut rng = Rng(11);
    let frames = 5000;
    let (ir_l, ir_r, taps) = sparse_ir(&mut rng, frames, 60);
    let reversed: Vec<(usize, f32, f32)> = taps.iter().map(|&(d, l, r)| (frames - 1 - d, l, r)).collect();
    let length = 128 * 100;
    let input = noise(&mut rng, length);
    let expected = reference(&reversed, &input, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir_l, &ir_r, true, false, true);
    let actual = run_convolver(&mut convolver, &input, length);
    assert_close(&actual, &expected, 2e-3, "reversed");
}

#[test]
fn dry_wet_and_predelay() {
    let mut rng = Rng(13);
    let ir = {
        let mut ir = vec![0.0f32; 200];
        ir[0] = 1.0;
        ir
    };
    let length = 128 * 20;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.25;
    convolver.wet_gain = 0.5;
    convolver.predelay_samples = 300;
    full_load(&mut convolver, &ir, &[], false, false, false);
    let actual = run_convolver(&mut convolver, &input, length);
    for channel in 0..2 {
        for t in 0..length {
            let wet = if t >= 300 { 0.5 * input[channel][t - 300] } else { 0.0 };
            let expected = 0.25 * input[channel][t] + wet;
            assert!((actual[channel][t] - expected).abs() < 1e-4, "predelay ch{channel} t{t}");
        }
    }
}

#[test]
fn normalize_scales_to_unit_energy() {
    let mut rng = Rng(17);
    let ir = vec![2.0f32; 400]; // energy = 400 * 4 -> gain 1/40
    let length = 128 * 30;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir, &[], false, true, false);
    let actual = run_convolver(&mut convolver, &input, length);
    let taps: Vec<(usize, f32, f32)> = (0..400).map(|d| (d, 2.0 / 40.0, 2.0 / 40.0)).collect();
    let expected = reference(&taps, &input, length);
    assert_close(&actual, &expected, 2e-3, "normalize");
}

#[test]
fn progressive_load_converges_and_stays_finite() {
    let mut rng = Rng(19);
    let frames = 60000;
    let (ir_l, ir_r, taps) = sparse_ir(&mut rng, frames, 150);
    let length = 128 * 1400;
    let input = noise(&mut rng, length);
    let expected = reference(&taps, &input, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    convolver.begin_load(&ir_l, &ir_r, true, false, false);
    let mut actual = [vec![0.0f32; length], vec![0.0f32; length]];
    let mut cursor = 0;
    while cursor < length {
        let end = cursor + BLOCK;
        convolver.load_step(&ir_l, &ir_r, 2); // the device's per-quantum budget
        let (head, tail) = actual.split_at_mut(1);
        convolver.process(&input[0][cursor..end], &input[1][cursor..end], &mut head[0][cursor..end], &mut tail[0][cursor..end], 0, end - cursor);
        cursor = end;
    }
    assert!(!convolver.loading(), "load must finish well within the run");
    for channel in 0..2 {
        assert!(actual[channel].iter().all(|value| value.is_finite()), "progressive ch{channel} finite");
    }
    // after load completion + two full L3 periods the output must equal the reference
    let settled = 128 * 400;
    for channel in 0..2 {
        let diff = max_abs_diff(&actual[channel][settled..], &expected[channel][settled..]);
        let peak = expected[channel][settled..].iter().fold(0.0f32, |a, &v| a.max(v.abs())).max(1e-6);
        assert!(diff <= 2e-3 * peak, "progressive ch{channel}: settled diff {diff} (peak {peak})");
    }
}

#[test]
fn clear_runtime_kills_the_tail_but_keeps_the_ir() {
    let mut rng = Rng(23);
    let (ir_l, ir_r, taps) = sparse_ir(&mut rng, 30000, 80);
    let length = 128 * 300;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir_l, &ir_r, true, false, false);
    let _ = run_convolver(&mut convolver, &input, length);
    convolver.clear_runtime();
    let silence = [vec![0.0f32; 1024], vec![0.0f32; 1024]];
    let out = run_convolver(&mut convolver, &silence, 1024);
    for channel in 0..2 {
        assert!(out[channel].iter().all(|&value| value == 0.0), "tail survived clear ch{channel}");
    }
    // the IR spectra survived: fresh input convolves correctly again
    let expected = reference(&taps, &input, length);
    convolver.clear_runtime();
    let actual = run_convolver(&mut convolver, &input, length);
    assert_close(&actual, &expected, 2e-3, "after clear");
}

#[test]
fn oversize_ir_truncates_at_cap() {
    let mut rng = Rng(29);
    let frames = MAX_IR_FRAMES + 50000;
    let mut ir = vec![0.0f32; frames];
    ir[0] = 1.0;
    ir[MAX_IR_FRAMES - 1] = 0.5;
    ir[MAX_IR_FRAMES + 10000] = 4.0; // beyond the cap: must be ignored
    let length = 128 * 20;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir, &[], false, false, false);
    let actual = run_convolver(&mut convolver, &input, length);
    for channel in 0..2 {
        let diff = max_abs_diff(&actual[channel], &input[channel]);
        assert!(diff < 1e-3, "truncated ir must reduce to the unit tap, diff {diff}");
    }
}

#[test]
fn unload_goes_dry_only() {
    let mut rng = Rng(31);
    let (ir_l, ir_r, _) = sparse_ir(&mut rng, 10000, 50);
    let length = 128 * 40;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 1.0;
    convolver.wet_gain = 1.0;
    full_load(&mut convolver, &ir_l, &ir_r, true, false, false);
    let _ = run_convolver(&mut convolver, &input, length);
    convolver.unload();
    let actual = run_convolver(&mut convolver, &input, length);
    for channel in 0..2 {
        assert!(max_abs_diff(&actual[channel], &input[channel]) < 1e-6, "unloaded must be dry pass-through");
    }
}

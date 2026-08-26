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
    convolver.begin_load(ir_l, ir_r, stereo, normalize, reverse, 1.0);
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
    convolver.clear_runtime(); // transport start snaps the pre-delay glide to its target
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

const MAKEUP: f64 = 1.4125375; // +3 dB

// Peak normalization: MAKEUP / sqrt(max 8-bin mean |H|^2) over both channels on the convolver's 16384-point grid.
fn peak_gain(taps: &[(usize, f32, f32)]) -> f32 {
    let mut power = [vec![0.0f64; 8193], vec![0.0f64; 8193]];
    for bin in 0..=8192usize {
        let (mut l_re, mut l_im, mut r_re, mut r_im) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for &(delay, left, right) in taps {
            let angle = -2.0 * std::f64::consts::PI * (bin * delay) as f64 / 16384.0;
            let (sin, cos) = angle.sin_cos();
            l_re += left as f64 * cos;
            l_im += left as f64 * sin;
            r_re += right as f64 * cos;
            r_im += right as f64 * sin;
        }
        power[0][bin] = l_re * l_re + l_im * l_im;
        power[1][bin] = r_re * r_re + r_im * r_im;
    }
    let mut peak = 0.0f64;
    for channel in 0..2 {
        for bin in 0..=8192usize {
            let lo = bin.saturating_sub(7);
            let mean = power[channel][lo..=bin].iter().sum::<f64>() / (bin + 1 - lo) as f64;
            peak = peak.max(mean);
        }
    }
    (MAKEUP / peak.sqrt()) as f32
}

#[test]
fn normalize_scales_the_peak_response_to_unity() {
    let mut rng = Rng(17);
    let ir = vec![2.0f32; 400]; // |H| peaks at DC: 800 -> gain MAKEUP / 800
    let length = 128 * 30;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir, &[], false, true, false);
    let actual = run_convolver(&mut convolver, &input, length);
    let tap = (2.0 * MAKEUP / 800.0) as f32;
    let taps: Vec<(usize, f32, f32)> = (0..400).map(|d| (d, tap, tap)).collect();
    let expected = reference(&taps, &input, length);
    assert_close(&actual, &expected, 2e-3, "normalize");
}

#[test]
fn normalize_bounds_a_narrow_resonance() {
    // a ringing IR (decaying sine on a grid bin, ~3 bins wide): the 8-bin band mean lets it sit at most ~4 dB
    // above the input, never more
    let bin = 100.0f32;
    let frequency = bin / 16384.0;
    let ir: Vec<f32> = (0..20000).map(|index| (index as f32 * frequency * std::f32::consts::TAU).sin() * 0.9995f32.powi(index as i32)).collect();
    let length = 128 * 400;
    let sine: Vec<f32> = (0..length).map(|index| (index as f32 * frequency * std::f32::consts::TAU).sin()).collect();
    let input = [sine.clone(), sine];
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir, &[], false, true, false);
    let actual = run_convolver(&mut convolver, &input, length);
    let settled = &actual[0][length - 8192..];
    let peak = settled.iter().fold(0.0f32, |a, &v| a.max(v.abs()));
    assert!(peak <= 1.6 * MAKEUP as f32, "resonance peak {peak} more than 4 dB + makeup above the input");
    assert!(peak >= 0.95 * MAKEUP as f32, "resonance peak {peak} below the makeup level");
}

#[test]
fn normalize_lifts_a_quiet_ir_to_unity_peak() {
    let mut rng = Rng(19);
    let ir = vec![1e-5f32; 500]; // |H| peak 5e-3 -> gain MAKEUP * 200
    let length = 128 * 30;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir, &[], false, true, false);
    let actual = run_convolver(&mut convolver, &input, length);
    let tap = (2e-3 * MAKEUP) as f32;
    let taps: Vec<(usize, f32, f32)> = (0..500).map(|d| (d, tap, tap)).collect();
    let expected = reference(&taps, &input, length);
    assert_close(&actual, &expected, 2e-3, "normalize quiet");
}

#[test]
fn normalize_peak_covers_the_l3_partitions() {
    // sparse taps far into the IR: the peak must include the L3 partition spectra (with their sign alternation)
    let mut rng = Rng(20);
    let (ir_l, ir_r, taps) = sparse_ir(&mut rng, 120000, 120);
    let length = 128 * 1200;
    let input = noise(&mut rng, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir_l, &ir_r, true, true, false);
    let actual = run_convolver(&mut convolver, &input, length);
    let gain = peak_gain(&taps);
    let scaled: Vec<(usize, f32, f32)> = taps.iter().map(|&(delay, left, right)| (delay, left * gain, right * gain)).collect();
    let expected = reference(&scaled, &input, length);
    assert_close(&actual, &expected, 2e-3, "normalize l3 peak");
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
    convolver.begin_load(&ir_l, &ir_r, true, false, false, 1.0);
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
fn staggered_period_phase_matches_reference() {
    // spike decorrelation: an offset start phase must not change the convolution result
    for stagger in [1usize, 17, 37, 63] {
        let mut rng = Rng(41 + stagger as u64);
        let (ir_l, ir_r, taps) = sparse_ir(&mut rng, 60000, 120);
        let length = 128 * 800;
        let input = noise(&mut rng, length);
        let expected = reference(&taps, &input, length);
        let mut convolver = boxed_convolver();
        convolver.dry_gain = 0.0;
        full_load(&mut convolver, &ir_l, &ir_r, true, false, false);
        convolver.set_stagger(stagger);
        let actual = run_convolver(&mut convolver, &input, length);
        assert_close(&actual, &expected, 2e-3, &format!("stagger {stagger}"));
    }
}

#[test]
fn resampled_ir_matches_decimated_reference() {
    let mut rng = Rng(37);
    // a 2x-rate IR with taps only at EVEN indices: linear interp at ratio 2.0 lands exactly on them
    let frames_src = 10000;
    let mut ir = vec![0.0f32; frames_src];
    let mut taps = Vec::new();
    for _ in 0..50 {
        let delay = (((rng.next_f32() * 0.5 + 0.5) * ((frames_src / 2) - 1) as f32) as usize).min(frames_src / 2 - 1);
        let gain = rng.next_f32();
        ir[delay * 2] = gain;
        taps.push((delay, gain, gain));
    }
    taps.sort_unstable_by_key(|&(delay, _, _)| delay);
    taps.dedup_by_key(|&mut (delay, _, _)| delay);
    let taps: Vec<(usize, f32, f32)> = taps.iter().map(|&(d, _, _)| (d, ir[d * 2], ir[d * 2])).collect();
    let length = 128 * 120;
    let input = noise(&mut rng, length);
    let expected = reference(&taps, &input, length);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    convolver.begin_load(&ir, &[], false, false, false, 2.0);
    while convolver.load_step(&ir, &[], 64) {}
    let actual = run_convolver(&mut convolver, &input, length);
    assert_close(&actual, &expected, 2e-3, "resampled");
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

// Swapping the IR of a LOADED convolver: the old tail must keep sounding while the new IR loads
// partition by partition (no level hole), and once loaded + flushed the output must equal the new
// IR's reference over the WHOLE input stream (the input history survived the swap, incl. repack).
fn ir_swap_case(frames_a: usize, frames_b: usize, normalize: bool, seed: u64) {
    let mut rng = Rng(seed);
    let (a_l, a_r, _) = sparse_ir(&mut rng, frames_a, 150);
    let (b_l, b_r, taps_b) = sparse_ir(&mut rng, frames_b, 150);
    let pre = 128 * 300;
    let post = 128 * 700;
    let input = noise(&mut rng, pre + post);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &a_l, &a_r, true, normalize, false);
    let mut actual = [vec![0.0f32; pre + post], vec![0.0f32; pre + post]];
    let mut rms = Vec::new();
    let mut cursor = 0;
    while cursor < pre + post {
        let end = cursor + BLOCK;
        if cursor == pre {
            convolver.begin_load(&b_l, &b_r, true, normalize, false, 1.0);
        }
        if cursor >= pre {
            convolver.load_step(&b_l, &b_r, 2);
        }
        let (head, tail) = actual.split_at_mut(1);
        convolver.process(&input[0][cursor..end], &input[1][cursor..end], &mut head[0][cursor..end], &mut tail[0][cursor..end], 0, end - cursor);
        let energy: f32 = actual[0][cursor..end].iter().chain(&actual[1][cursor..end]).map(|value| value * value).sum();
        rms.push((energy / (2 * BLOCK) as f32).sqrt());
        cursor = end;
    }
    assert!(!convolver.loading(), "load must finish within the run");
    let before = rms[pre / BLOCK - 32..pre / BLOCK].iter().sum::<f32>() / 32.0;
    let floor = rms[pre / BLOCK..pre / BLOCK + 64].iter().cloned().fold(f32::MAX, f32::min);
    assert!(floor > before * 0.5, "swap {frames_a}->{frames_b} normalize={normalize}: tail hole, rms floor {floor} vs {before} before");
    let gain = if normalize { peak_gain(&taps_b) } else { 1.0 };
    let scaled: Vec<(usize, f32, f32)> = taps_b.iter().map(|&(delay, left, right)| (delay, left * gain, right * gain)).collect();
    let expected = reference(&scaled, &input, pre + post);
    let settled = pre + 128 * 400;
    for channel in 0..2 {
        assert!(actual[channel].iter().all(|value| value.is_finite()), "swap ch{channel} finite");
        let diff = max_abs_diff(&actual[channel][settled..], &expected[channel][settled..]);
        let peak = expected[channel][settled..].iter().fold(0.0f32, |a, &v| a.max(v.abs())).max(1e-6);
        assert!(diff <= 2e-3 * peak, "swap {frames_a}->{frames_b} normalize={normalize} ch{channel}: settled diff {diff} (peak {peak})");
    }
}

#[test]
fn ir_swap_same_partition_count() {
    ir_swap_case(60000, 61000, false, 31);
}

#[test]
fn ir_swap_grows_partitions() {
    ir_swap_case(60000, 200000, false, 37);
}

#[test]
fn ir_swap_shrinks_partitions() {
    ir_swap_case(200000, 30000, false, 41);
}

#[test]
fn ir_swap_shrinks_below_l3() {
    ir_swap_case(200000, 10000, false, 43);
}

#[test]
fn ir_swap_normalized_glides_to_exact_gain() {
    ir_swap_case(60000, 200000, true, 47);
}

// Swap from a quiet IR (high normalize gain) to a hot one: the hot IR must never play at the old gain.
#[test]
fn ir_swap_never_bursts_when_the_new_ir_is_hotter() {
    let mut rng = Rng(53);
    let quiet = vec![1e-4f32; 500];
    let hot = vec![2.0f32; 400];
    let pre = 128 * 100;
    let post = 128 * 100;
    let input = noise(&mut rng, pre + post);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &quiet, &[], false, true, false);
    let mut actual = [vec![0.0f32; pre + post], vec![0.0f32; pre + post]];
    let mut cursor = 0;
    while cursor < pre + post {
        let end = cursor + BLOCK;
        if cursor == pre {
            convolver.begin_load(&hot, &[], false, true, false, 1.0);
        }
        if cursor >= pre {
            convolver.load_step(&hot, &[], 2);
        }
        let (head, tail) = actual.split_at_mut(1);
        convolver.process(&input[0][cursor..end], &input[1][cursor..end], &mut head[0][cursor..end], &mut tail[0][cursor..end], 0, end - cursor);
        cursor = end;
    }
    // the normalized boxcar's worst case: sum |h| * gain = 800 * MAKEUP / 800
    let bound = MAKEUP as f32 * 1.05;
    let peak = actual[0][pre..].iter().fold(0.0f32, |a, &v| a.max(v.abs()));
    assert!(peak <= bound, "swap burst: peak {peak} after the swap (bound {bound})");
}

// Swap from a hot long IR to a quiet long one: the old partitions still sounding must not be lifted by the
// new gain before they are replaced.
#[test]
fn ir_swap_holds_the_gain_while_old_partitions_sound() {
    let mut rng = Rng(59);
    let (hot_l, hot_r, _) = sparse_ir(&mut rng, 200000, 150);
    let quiet_l: Vec<f32> = hot_l.iter().map(|value| value * 1e-3).collect();
    let quiet_r: Vec<f32> = hot_r.iter().map(|value| value * 1e-3).collect();
    let pre = 128 * 400;
    let post = 128 * 400; // covers the pipeline hold and the rise to the new gain
    let input = noise(&mut rng, pre + post);
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &hot_l, &hot_r, true, true, false);
    let mut actual = [vec![0.0f32; pre + post], vec![0.0f32; pre + post]];
    let mut cursor = 0;
    while cursor < pre + post {
        let end = cursor + BLOCK;
        if cursor == pre {
            convolver.begin_load(&quiet_l, &quiet_r, true, true, false, 1.0);
        }
        if cursor >= pre {
            convolver.load_step(&quiet_l, &quiet_r, 2);
        }
        let (head, tail) = actual.split_at_mut(1);
        convolver.process(&input[0][cursor..end], &input[1][cursor..end], &mut head[0][cursor..end], &mut tail[0][cursor..end], 0, end - cursor);
        cursor = end;
    }
    let before = actual[0][pre - 128 * 100..pre].iter().fold(0.0f32, |a, &v| a.max(v.abs()));
    let after = actual[0][pre..].iter().fold(0.0f32, |a, &v| a.max(v.abs()));
    assert!(after <= before * 1.5, "swap lifted the old tail: peak {after} after vs {before} before");
}

// Automating the pre-delay: steps must glide with a fractional read, no discontinuity in the wet output.
#[test]
fn predelay_automation_does_not_click() {
    let ir = {
        let mut ir = vec![0.0f32; 200];
        ir[0] = 1.0;
        ir
    };
    let length = 128 * 200;
    let frequency = 220.0 / 48000.0;
    let sine: Vec<f32> = (0..length).map(|index| (index as f32 * frequency * std::f32::consts::TAU).sin()).collect();
    let input = [sine.clone(), sine];
    let mut convolver = boxed_convolver();
    convolver.dry_gain = 0.0;
    full_load(&mut convolver, &ir, &[], false, false, false);
    let mut actual = [vec![0.0f32; length], vec![0.0f32; length]];
    let steps = [0usize, 960, 0, 4800, 24000, 100, 0];
    let mut cursor = 0;
    while cursor < length {
        let end = cursor + BLOCK;
        let quantum = cursor / BLOCK;
        if quantum % 25 == 0 {
            convolver.predelay_samples = steps[(quantum / 25) % steps.len()];
        }
        let (head, tail) = actual.split_at_mut(1);
        convolver.process(&input[0][cursor..end], &input[1][cursor..end], &mut head[0][cursor..end], &mut tail[0][cursor..end], 0, end - cursor);
        cursor = end;
    }
    // a 220 Hz sine steps at most 2*pi*220/48000 ~ 0.029 per sample; glide pitch-shifts it, never jumps it
    let max_step = actual[0].windows(2).map(|pair| (pair[1] - pair[0]).abs()).fold(0.0f32, f32::max);
    assert!(max_step < 0.08, "pre-delay automation click: max sample step {max_step}");
}

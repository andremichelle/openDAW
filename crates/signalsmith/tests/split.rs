// The original's `splitComputation`: a frame's work is spread over the interval before it is due. It must render
// exactly what whole frames render, and it must keep a voice from spending a whole frame in one render quantum.
use std::time::Instant;
use signalsmith::SignalsmithStretch;

const RATE: f32 = 48000.0;
const QUANTUM: usize = 128;

fn source(len: usize) -> (Vec<f32>, Vec<f32>) {
    let mut state = 7u32;
    let mut noise = || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        (state >> 8) as f32 / 16777216.0 - 0.5
    };
    let left = (0..len).map(|index| {
        let time = index as f32 / RATE;
        0.3 * libm::sinf(6.2831853 * 220.0 * time) + if index % 12000 < 200 { noise() } else { 0.0 }
    }).collect();
    let right = (0..len).map(|index| {
        let time = index as f32 / RATE;
        0.2 * libm::sinf(6.2831853 * 330.0 * time) + 0.05 * noise()
    }).collect();
    (left, right)
}

struct Scenario { chunks: &'static [usize], time_factor: f64, pitch: f32, resample: f64, start: f64, wrap_every: usize }

fn render(split: bool, scenario: &Scenario) -> Vec<f32> {
    let (left, right) = source(400_000);
    let mut player = SignalsmithStretch::preset_default(2, RATE);
    player.set_split_computation(split);
    let Scenario {chunks, time_factor, pitch, resample, start, wrap_every} = *scenario;
    player.reset_stream(start);
    player.arm_capture(time_factor, pitch, resample, start);
    let mut out = Vec::new();
    let (mut out_l, mut out_r) = (vec![0.0f32; QUANTUM], vec![0.0f32; QUANTUM]);
    for (call, &count) in chunks.iter().cycle().take(600).enumerate() {
        if wrap_every > 0 && call % wrap_every == wrap_every - 1 {
            if !player.try_restore(time_factor, pitch, resample, start) {player.reset_stream(start);}
        }
        player.process_stream_stereo(&left, &right, &mut out_l[..count], &mut out_r[..count], time_factor, pitch, resample);
        out.extend_from_slice(&out_l[..count]);
        out.extend_from_slice(&out_r[..count]);
    }
    out
}

#[test]
fn split_frames_render_exactly_what_whole_frames_render() {
    let scenarios = [
        Scenario {chunks: &[128], time_factor: 1.0, pitch: 1.0, resample: 1.0, start: 0.0, wrap_every: 0},
        Scenario {chunks: &[128], time_factor: 1.37, pitch: 1.0, resample: 1.0, start: 1234.5, wrap_every: 0},
        Scenario {chunks: &[37, 91, 128, 5], time_factor: 0.8, pitch: 1.12, resample: 44100.0 / 48000.0, start: 2048.0, wrap_every: 0},
        Scenario {chunks: &[1, 128, 64], time_factor: 2.5, pitch: 0.7, resample: 1.0, start: 99.0, wrap_every: 0},
        // loop wraps through the primed-state cache, at several distances from a frame boundary
        Scenario {chunks: &[128], time_factor: 1.0, pitch: 0.9, resample: 1.0, start: 500.0, wrap_every: 150},
        Scenario {chunks: &[100, 28], time_factor: 1.1, pitch: 1.0, resample: 1.0, start: 0.0, wrap_every: 13},
    ];
    for (index, scenario) in scenarios.iter().enumerate() {
        let whole = render(false, scenario);
        let split = render(true, scenario);
        assert_eq!(whole.len(), split.len());
        let first = whole.iter().zip(split.iter()).position(|(a, b)| a.to_bits() != b.to_bits());
        assert!(first.is_none(), "scenario {index} differs first at {first:?}");
    }
}

#[test]
fn switching_the_split_off_mid_frame_renders_what_whole_frames_render() {
    let (left, right) = source(400_000);
    let render = |switch_at: Option<usize>| {
        let mut player = SignalsmithStretch::preset_default(2, RATE);
        player.set_split_computation(switch_at.is_some());
        player.reset_stream(300.0);
        let (mut out_l, mut out_r) = (vec![0.0f32; QUANTUM], vec![0.0f32; QUANTUM]);
        let mut out = Vec::new();
        for call in 0..200 {
            if switch_at == Some(call) {player.set_split_computation(false);}
            player.process_stream_stereo(&left, &right, &mut out_l, &mut out_r, 1.0, 1.0, 1.0);
            out.extend_from_slice(&out_l);
        }
        out
    };
    let whole = render(None);
    for switch_at in [3, 37, 101] {
        let switched = render(Some(switch_at));
        let first = whole.iter().zip(switched.iter()).position(|(a, b)| a.to_bits() != b.to_bits());
        assert!(first.is_none(), "switched at call {switch_at}, differs first at {first:?}");
    }
}

#[test]
fn split_frames_follow_a_tempo_change_like_whole_frames() {
    // a frame takes its tempo when it starts, one interval early: the output stays within a few ULPs of a hop
    let (left, right) = source(400_000);
    let render = |split: bool| {
        let mut player = SignalsmithStretch::preset_default(2, RATE);
        player.set_split_computation(split);
        player.reset_stream(0.0);
        let (mut out_l, mut out_r) = (vec![0.0f32; QUANTUM], vec![0.0f32; QUANTUM]);
        let mut energy = 0.0f64;
        for call in 0..400 {
            let time_factor = if call < 200 { 1.0 } else { 1.25 };
            player.process_stream_stereo(&left, &right, &mut out_l, &mut out_r, time_factor, 1.0, 1.0);
            energy += out_l.iter().map(|value| (*value as f64).powi(2)).sum::<f64>();
        }
        energy
    };
    let (whole, split) = (render(false), render(true));
    assert!((whole - split).abs() / whole < 0.01, "energy whole {whole} split {split}");
}

fn peak_cost(split: bool, voices: usize) -> f64 {
    let (left, right) = source(400_000);
    let mut players: Vec<SignalsmithStretch> = (0..voices).map(|_| {
        let mut player = SignalsmithStretch::preset_default(2, RATE);
        player.set_split_computation(split);
        player.reset_stream(2048.0);
        player
    }).collect();
    let (mut out_l, mut out_r) = (vec![0.0f32; QUANTUM], vec![0.0f32; QUANTUM]);
    for player in players.iter_mut() {
        for _ in 0..16 {player.process_stream_stereo(&left, &right, &mut out_l, &mut out_r, 1.0, 1.0, 1.0);}
    }
    let mut per_quantum = Vec::with_capacity(800);
    for _ in 0..800 {
        let start = Instant::now();
        for player in players.iter_mut() {
            player.process_stream_stereo(&left, &right, &mut out_l, &mut out_r, 1.0, 1.0, 1.0);
        }
        per_quantum.push(start.elapsed().as_nanos() as f64);
    }
    per_quantum.sort_by(|a, b| b.partial_cmp(a).unwrap());
    per_quantum[..16].iter().sum::<f64>() / 16.0
}

#[test]
#[ignore = "wall-clock benchmark, not a correctness gate: noisy on a busy machine. Run with --ignored."]
fn split_frames_flatten_the_peak_cost() {
    let budget = QUANTUM as f64 / RATE as f64 * 1e9;
    for voices in [1, 3, 5] {
        let whole = peak_cost(false, voices);
        let split = peak_cost(true, voices);
        println!("{voices} voices: whole {:.1}% split {:.1}% of a quantum", whole / budget * 100.0, split / budget * 100.0);
        assert!(split < whole * 0.6, "splitting must cut the peak substantially");
    }
}

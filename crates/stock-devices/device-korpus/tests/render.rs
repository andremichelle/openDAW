use device_korpus::engine::pluck::build_body;
use device_korpus::voice::{Exciter, KorpusShared, KorpusVoice, CHUNK_MAX};
use voicing::Voice;

const SAMPLE_RATE: f32 = 48_000.0;

// A named patch: the ear-approved preset families, distilled to device parameters.
struct Config {
    name: &'static str,
    exciter: Exciter,
    intensity: f32,
    position: f32,
    vibrato: f32,
    object_a: i32,
    damping_a: f32,
    width_a: f32,
    object_b: i32,
    damping_b: f32,
    tune_b: i32,
    detune_b: f32,
    level_b: f32,
    routing: i32,
    couple: f32,
    sustained: bool,
}

const BASE: Config = Config {name: "", exciter: Exciter::Strike, intensity: 0.5, position: 0.35,
    vibrato: 0.0, object_a: 0, damping_a: 0.5, width_a: 0.6, object_b: 6, damping_b: 0.5,
    tune_b: 0, detune_b: 0.0, level_b: 0.5, routing: 0, couple: 0.0, sustained: false};

fn configs() -> Vec<Config> {
    vec![
        Config {name: "strike_marimba", ..BASE},
        Config {name: "strike_plate_hard", intensity: 0.9, object_a: 4, damping_a: 0.25, ..BASE},
        Config {name: "gamelan_pair", object_a: 0, damping_a: 0.55, object_b: 1, damping_b: 0.75,
            detune_b: 7.0, couple: 0.25, ..BASE},
        Config {name: "bar_into_skin", damping_a: 0.3, object_b: 3, damping_b: 0.45, tune_b: -12,
            routing: 1, level_b: 0.8, ..BASE},
        Config {name: "bell_into_wire", intensity: 0.7, object_a: 2, damping_a: 0.8, object_b: 5,
            damping_b: 0.9, tune_b: 12, routing: 1, level_b: 0.75, ..BASE},
        Config {name: "breath_bar", exciter: Exciter::Breath, intensity: 0.45, object_a: 0,
            damping_a: 0.5, sustained: true, ..BASE},
        Config {name: "breath_vibe_pair", exciter: Exciter::Breath, intensity: 0.6, object_a: 1,
            damping_a: 0.8, object_b: 1, damping_b: 0.68, detune_b: 5.0, couple: 0.12,
            level_b: 0.4, sustained: true, ..BASE},
        Config {name: "bow_vibe", exciter: Exciter::Bow, intensity: 0.3, position: 0.25,
            object_a: 1, damping_a: 0.85, vibrato: 0.15, sustained: true, ..BASE},
        Config {name: "bow_wire", exciter: Exciter::Bow, intensity: 0.55, position: 0.12,
            object_a: 5, damping_a: 0.7, vibrato: 0.25, sustained: true, ..BASE},
        Config {name: "bow_membrane", exciter: Exciter::Bow, intensity: 0.45, position: 0.6,
            object_a: 3, damping_a: 0.6, vibrato: 0.2, sustained: true, ..BASE},
        Config {name: "pick_nylon", exciter: Exciter::Pick, intensity: 0.68, position: 0.18,
            object_a: 0, damping_a: 0.6, ..BASE},
        Config {name: "pick_wire", exciter: Exciter::Pick, intensity: 0.6, position: 0.12,
            object_a: 5, damping_a: 0.8, ..BASE},
        Config {name: "wind_bamboo", exciter: Exciter::Wind, intensity: 0.55, position: 0.3,
            vibrato: 0.15, object_a: 0, damping_a: 0.5, sustained: true, ..BASE},
        Config {name: "wind_husky", exciter: Exciter::Wind, intensity: 0.75, position: 0.55,
            vibrato: 0.3, object_a: 3, damping_a: 0.55, sustained: true, ..BASE},
    ]
}

fn shared_for(config: &Config) -> KorpusShared {
    let mut shared = KorpusShared {
        exciter: config.exciter,
        intensity: config.intensity,
        position: config.position,
        vibrato: config.vibrato,
        object_a: config.object_a,
        damping_a: config.damping_a,
        width_a: config.width_a,
        object_b: config.object_b,
        damping_b: config.damping_b,
        tune_b: config.tune_b,
        detune_b: config.detune_b,
        level_b: config.level_b,
        routing: config.routing,
        couple: config.couple,
        sample_rate: SAMPLE_RATE,
        ..KorpusShared::silent()
    };
    build_body(&mut shared.body, SAMPLE_RATE);
    shared
}

fn note_on(pitch: u32, velocity: f32) -> abi::EventRecord {
    abi::EventRecord {position: 0.0, offset: 0, kind: abi::EVENT_NOTE_ON, id: 1, pitch,
        velocity, cent: 0.0, duration: 0.0}
}

// `tweak(seconds, &mut shared)` runs before every chunk — the live-knob path under test.
fn render_with(config: &Config, pitch: u32, velocity: f32, seconds: f32, held_seconds: f32,
               mut tweak: impl FnMut(f32, &mut KorpusShared)) -> (Vec<f32>, Vec<f32>) {
    let mut shared = shared_for(config);
    let mut voice = KorpusVoice::default();
    let frequency = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
    voice.start(&note_on(pitch, velocity), frequency, 1.0, 0.0, 1, &shared);
    let block = abi::Block {index: 0, flags: abi::BlockFlags(0), bpm: 120.0, p0: 0.0, p1: 0.0,
        s0: 0, s1: 0};
    let total = (seconds * SAMPLE_RATE) as usize;
    let held = (held_seconds * SAMPLE_RATE) as usize;
    let mut output_l = Vec::with_capacity(total);
    let mut output_r = Vec::with_capacity(total);
    let mut done = false;
    let mut position = 0;
    while position < total {
        let len = CHUNK_MAX.min(total - position);
        let mut left = [0.0f32; CHUNK_MAX];
        let mut right = [0.0f32; CHUNK_MAX];
        tweak(position as f32 / SAMPLE_RATE, &mut shared);
        if position >= held && voice.gate() {
            voice.stop();
        }
        if !done {
            let mut slices: [&mut [f32]; 2] = [&mut left[..len], &mut right[..len]];
            let [l, r] = &mut slices;
            done = voice.process([l, r], &block, &shared);
        }
        output_l.extend_from_slice(&left[..len]);
        output_r.extend_from_slice(&right[..len]);
        position += len;
    }
    (output_l, output_r)
}

fn render(config: &Config, pitch: u32, velocity: f32, seconds: f32, held_seconds: f32)
    -> (Vec<f32>, Vec<f32>) {
    render_with(config, pitch, velocity, seconds, held_seconds, |_, _| {})
}

fn window_energy(samples: &[f32], from: f32, to: f32) -> f32 {
    let range = (from * SAMPLE_RATE) as usize..(to * SAMPLE_RATE) as usize;
    samples[range].iter().map(|sample| sample * sample).sum()
}

fn goertzel_power(samples: &[f32], frequency: f32) -> f32 {
    let omega = 2.0 * core::f32::consts::PI * frequency / SAMPLE_RATE;
    let coefficient = 2.0 * libm::cosf(omega);
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for sample in samples {
        let s0 = sample + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    s1 * s1 + s2 * s2 - coefficient * s1 * s2
}

fn momentary_rms(left: &[f32], right: &[f32]) -> f32 {
    let window = (0.25 * SAMPLE_RATE) as usize;
    let energy: Vec<f64> = left.iter().zip(right)
        .map(|(l, r)| (l * l + r * r) as f64 * 0.5).collect();
    let mut sum: f64 = energy[..window].iter().sum();
    let mut max_mean = sum;
    for index in window..energy.len() {
        sum += energy[index] - energy[index - window];
        if sum > max_mean {max_mean = sum;}
    }
    (max_mean / window as f64).sqrt() as f32
}

#[test]
fn every_config_renders_finite_stereo_audible_output() {
    for config in configs() {
        let held = if config.sustained {2.6} else {1.2};
        let (left, right) = render(&config, 57, 0.9, 4.2, held);
        let name = config.name;
        let peak = left.iter().chain(right.iter()).fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(left.iter().chain(right.iter()).all(|s| s.is_finite()), "{name}: non-finite");
        assert!(peak > 0.05, "{name}: too quiet (peak {peak})");
        assert!(peak < 2.5, "{name}: too hot (peak {peak})");
        let difference = left.iter().zip(&right)
            .fold(0.0f32, |acc, (l, r)| acc.max((l - r).abs()));
        assert!(difference > 1.0e-4, "{name}: output is mono");
        let tail = &left[left.len() - 2400..];
        let tail_peak = tail.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(tail_peak < 0.6, "{name}: tail not decaying (peak {tail_peak})");
        let speaks_at = left.iter().position(|s| s.abs() > 0.02)
            .map(|index| index as f32 / SAMPLE_RATE)
            .unwrap_or(f32::INFINITY);
        let onset_limit = if config.sustained {0.6} else {0.05};
        assert!(speaks_at < onset_limit, "{name}: slow onset ({speaks_at:.3}s)");
        if let Ok(dir) = std::env::var("KORPUS_RENDER_DIR") {
            let spec = hound::WavSpec {channels: 2, sample_rate: SAMPLE_RATE as u32,
                bits_per_sample: 16, sample_format: hound::SampleFormat::Int};
            let mut writer = hound::WavWriter::create(
                format!("{dir}/korpus_v2_{name}.wav"), spec).unwrap();
            // Fixed gain so the dumps preserve relative loudness.
            for index in 0..left.len() {
                writer.write_sample((left[index] * 0.7 * 32767.0) as i16).unwrap();
                writer.write_sample((right[index] * 0.7 * 32767.0) as i16).unwrap();
            }
            writer.finalize().unwrap();
        }
        println!("{name}: peak {peak:.3}, speaks at {speaks_at:.4}s");
    }
}

#[test]
fn configs_are_level_matched() {
    let list = configs();
    let loudness: Vec<f32> = list.iter().map(|config| {
        let held = if config.sustained {1.5} else {1.2};
        let (left, right) = render(config, 57, 0.9, 2.0, held);
        momentary_rms(&left, &right)
    }).collect();
    let mut sorted = loudness.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    for (config, rms) in list.iter().zip(&loudness) {
        let db = 20.0 * libm::log10f(rms / median);
        println!("{}: {rms:.4} rms ({db:+.2}dB from median)", config.name);
    }
    for (config, rms) in list.iter().zip(&loudness) {
        let db = 20.0 * libm::log10f(rms / median);
        assert!(db.abs() <= 3.0, "{}: {db:+.2}dB from the config median", config.name);
    }
}

#[test]
fn sustained_configs_speak_across_the_range() {
    let list = configs();
    for config in list.iter().filter(|config| config.sustained) {
        let (low, high) = match config.exciter {
            Exciter::Bow if config.object_a == 3 => (45u32, 76u32), // membrane sings from ~45
            Exciter::Bow => (40, 84),
            Exciter::Wind => (45, 84),
            _ => (48, 84),
        };
        for pitch in (low..=high).step_by(6) {
            for velocity in [0.5f32, 0.9] {
                let (left, right) = render(config, pitch, velocity, 1.6, 1.2);
                let peak = left.iter().chain(right.iter())
                    .fold(0.0f32, |acc, s| acc.max(s.abs()));
                assert!(peak.is_finite() && peak > 0.015 && peak < 3.0,
                    "{} pitch {pitch} vel {velocity}: peak {peak}", config.name);
            }
        }
    }
}

#[test]
fn damping_knob_is_live_on_a_ringing_strike() {
    let config = Config {name: "vibe", object_a: 1, damping_a: 0.5, ..BASE};
    let (control, _) = render(&config, 57, 0.9, 2.0, 1.9);
    let (choked, _) = render_with(&config, 57, 0.9, 2.0, 1.9, |time, shared| {
        if time >= 0.4 {shared.damping_a = 0.02;}
    });
    let (opened, _) = render_with(&config, 57, 0.9, 2.0, 1.9, |time, shared| {
        if time >= 0.4 {shared.damping_a = 0.95;}
    });
    let control_energy = window_energy(&control, 1.0, 1.6);
    let choked_energy = window_energy(&choked, 1.0, 1.6);
    let opened_energy = window_energy(&opened, 1.0, 1.6);
    println!("damping live: control {control_energy:.6}, choked {choked_energy:.6}, opened {opened_energy:.6}");
    assert!(choked_energy < control_energy * 0.1, "damping down must choke the ring");
    assert!(opened_energy > control_energy * 1.3, "damping up must extend the ring");
}

#[test]
fn tune_knob_glides_a_sounding_note() {
    let config = Config {name: "vibe", object_a: 1, damping_a: 0.75, ..BASE};
    let (control, _) = render(&config, 57, 0.9, 1.8, 1.7);
    let (shifted, _) = render_with(&config, 57, 0.9, 1.8, 1.7, |time, shared| {
        if time >= 0.3 {shared.tune_a = 12;}
    });
    let window = (0.8 * SAMPLE_RATE) as usize..(1.6 * SAMPLE_RATE) as usize;
    let control_low = goertzel_power(&control[window.clone()], 220.0);
    let control_high = goertzel_power(&control[window.clone()], 440.0);
    let shifted_low = goertzel_power(&shifted[window.clone()], 220.0);
    let shifted_high = goertzel_power(&shifted[window], 440.0);
    println!("tune live: control 220/440 {control_low:.4}/{control_high:.4}, \
        shifted {shifted_low:.4}/{shifted_high:.4}");
    assert!(control_low > control_high * 4.0, "control must sit at the played pitch");
    assert!(shifted_high > shifted_low * 4.0, "tune +12 must move the sounding note up an octave");
}

#[test]
fn level_knob_is_live_on_a_serial_pair() {
    // Serial bar→membrane: after the mute the bar keeps ringing but the membrane goes silent.
    let config = configs().into_iter().find(|config| config.name == "bar_into_skin").unwrap();
    let (control, _) = render(&config, 57, 0.9, 1.4, 1.3);
    let (muted, _) = render_with(&config, 57, 0.9, 1.4, 1.3, |time, shared| {
        if time >= 0.35 {shared.level_b = 0.0;}
    });
    let control_energy = window_energy(&control, 0.5, 0.9);
    let muted_energy = window_energy(&muted, 0.5, 0.9);
    println!("serial level live: control {control_energy:.6}, muted {muted_energy:.6}");
    assert!(muted_energy < control_energy * 0.3, "serial Level must duck object B live");
}

// The first-difference share of energy — a broadband HF proxy that tracks the bow's rosin grit.
fn hf_share(samples: &[f32], from: f32, to: f32) -> f32 {
    let window = &samples[(from * SAMPLE_RATE) as usize..(to * SAMPLE_RATE) as usize];
    let diff_energy: f32 = window.windows(2).map(|pair| {
        let d = pair[1] - pair[0];
        d * d
    }).sum();
    diff_energy / window.iter().map(|sample| sample * sample).sum::<f32>().max(1.0e-9)
}

#[test]
fn pressure_knob_is_live_on_a_sounding_bow() {
    // A lighter bow is mostly a timbre change (the string stays velocity-locked): the rosin
    // grit and noise halo collapse, and the level eases off a little.
    let config = configs().into_iter().find(|config| config.name == "bow_wire").unwrap();
    let (control, _) = render(&config, 57, 0.9, 2.6, 2.5);
    let (lightened, lightened_r) = render_with(&config, 57, 0.9, 2.6, 2.5, |time, shared| {
        if time >= 1.4 {shared.intensity = 0.1;}
    });
    assert!(lightened.iter().chain(lightened_r.iter()).all(|sample| sample.is_finite()));
    let control_grit = hf_share(&control, 1.9, 2.5);
    let light_grit = hf_share(&lightened, 1.9, 2.5);
    let control_energy = window_energy(&control, 1.9, 2.5);
    let light_energy = window_energy(&lightened, 1.9, 2.5);
    println!("bow pressure live: grit {control_grit:.5} -> {light_grit:.5}, \
        energy {control_energy:.2} -> {light_energy:.2}");
    assert!(light_grit < control_grit * 0.6, "lighter bow must lose its rosin grit live");
    assert!(light_energy < control_energy * 0.95, "lighter bow must ease the level live");
}

#[test]
fn breath_brightness_is_live() {
    let config = configs().into_iter().find(|config| config.name == "breath_bar").unwrap();
    let (control, _) = render(&config, 57, 0.9, 2.4, 2.3);
    let (brightened, _) = render_with(&config, 57, 0.9, 2.4, 2.3, |time, shared| {
        if time >= 1.2 {shared.intensity = 1.0;}
    });
    // Broadband HF share instead of a single table-mode bin — robust against table retunes.
    let control_share = hf_share(&control, 1.6, 2.3);
    let bright_share = hf_share(&brightened, 1.6, 2.3);
    println!("breath brightness live: hf-share {control_share:.5} -> {bright_share:.5}");
    assert!(bright_share > control_share * 1.5, "brightness must open the breath live");
}

#[test]
fn pluck_tune_and_damping_are_live() {
    let config = configs().into_iter().find(|config| config.name == "pick_wire").unwrap();
    let (control, _) = render(&config, 57, 0.9, 1.8, 1.7);
    let (shifted, _) = render_with(&config, 57, 0.9, 1.8, 1.7, |time, shared| {
        if time >= 0.3 {shared.tune_a = 12;}
    });
    let window = (0.9 * SAMPLE_RATE) as usize..(1.6 * SAMPLE_RATE) as usize;
    let control_low = goertzel_power(&control[window.clone()], 220.0);
    let shifted_low = goertzel_power(&shifted[window.clone()], 220.0);
    let shifted_high = goertzel_power(&shifted[window], 440.0);
    println!("pluck tune live: control 220 {control_low:.4}, shifted 220/440 {shifted_low:.4}/{shifted_high:.4}");
    assert!(shifted_high > shifted_low * 4.0, "tune +12 must glide the string up an octave");
    let (choked, _) = render_with(&config, 57, 0.9, 1.8, 1.7, |time, shared| {
        if time >= 0.3 {shared.damping_a = 0.02;}
    });
    let control_energy = window_energy(&control, 0.9, 1.6);
    let choked_energy = window_energy(&choked, 0.9, 1.6);
    println!("pluck damping live: control {control_energy:.6}, choked {choked_energy:.6}");
    assert!(choked_energy < control_energy * 0.1, "damping down must choke the string live");
}

#[test]
fn parallel_level_and_tune_b_are_live() {
    // A marimba against a vibe a fifth up: the B partial is spectrally separable from A.
    let config = Config {name: "breath_pair", exciter: Exciter::Breath, intensity: 0.5,
        object_a: 0, damping_a: 0.5, object_b: 1, damping_b: 0.6, tune_b: 7, level_b: 0.6,
        sustained: true, ..BASE};
    let b_partial = 220.0 * libm::powf(2.0, 7.0 / 12.0);
    let window = (1.6 * SAMPLE_RATE) as usize..(2.3 * SAMPLE_RATE) as usize;
    let (control, _) = render(&config, 57, 0.9, 2.4, 2.3);
    let (muted, _) = render_with(&config, 57, 0.9, 2.4, 2.3, |time, shared| {
        if time >= 1.0 {shared.level_b = 0.0;}
    });
    let control_a = goertzel_power(&control[window.clone()], 220.0);
    let control_b = goertzel_power(&control[window.clone()], b_partial);
    let muted_a = goertzel_power(&muted[window.clone()], 220.0);
    let muted_b = goertzel_power(&muted[window.clone()], b_partial);
    println!("parallel level live: A {control_a:.4} -> {muted_a:.4}, B {control_b:.4} -> {muted_b:.4}");
    assert!(muted_b < control_b * 0.55, "parallel Level must duck object B's drive live");
    assert!(muted_a > control_a * 0.6, "object A must keep sounding");
    let (shifted, _) = render_with(&config, 57, 0.9, 2.4, 2.3, |time, shared| {
        if time >= 1.0 {shared.tune_b = 9;}
    });
    let target = 220.0 * libm::powf(2.0, 9.0 / 12.0);
    let shifted_old = goertzel_power(&shifted[window.clone()], b_partial);
    let shifted_new = goertzel_power(&shifted[window.clone()], target);
    let control_new = goertzel_power(&control[window], target);
    println!("tune B live: old bin {control_b:.4} -> {shifted_old:.4}, new bin {control_new:.4} -> {shifted_new:.4}");
    assert!(shifted_new > shifted_old * 2.0, "tune B +2 st must move the sounding B partial");
    assert!(shifted_new > control_new * 2.0, "the B partial must appear at the new pitch");
}

#[test]
fn width_knob_respreads_live() {
    let side_energy = |left: &[f32], right: &[f32], from: f32, to: f32| {
        let range = (from * SAMPLE_RATE) as usize..(to * SAMPLE_RATE) as usize;
        left[range.clone()].iter().zip(&right[range]).map(|(sample_l, sample_r)| {
            let side = sample_l - sample_r;
            side * side
        }).sum::<f32>()
    };
    let config = Config {name: "vibe", object_a: 1, damping_a: 0.75, ..BASE};
    let (control_l, control_r) = render(&config, 57, 0.9, 1.6, 1.5);
    let (narrow_l, narrow_r) = render_with(&config, 57, 0.9, 1.6, 1.5, |time, shared| {
        if time >= 0.4 {shared.width_a = 0.0;}
    });
    let control_side = side_energy(&control_l, &control_r, 0.9, 1.5);
    let narrow_side = side_energy(&narrow_l, &narrow_r, 0.9, 1.5);
    println!("width live: control side {control_side:.6}, narrowed {narrow_side:.6}");
    assert!(narrow_side < control_side * 0.05, "width down must collapse the stereo image live");
    // Width is absolute against note-on unit offsets: a note STARTED at width 0 must still
    // spread when the knob opens — the regression the ratio law had.
    let mono_start = Config {name: "vibe_mono", width_a: 0.0, ..config};
    let (zero_l, zero_r) = render(&mono_start, 57, 0.9, 1.6, 1.5);
    let (opened_l, opened_r) = render_with(&mono_start, 57, 0.9, 1.6, 1.5, |time, shared| {
        if time >= 0.4 {shared.width_a = 1.0;}
    });
    let zero_side = side_energy(&zero_l, &zero_r, 0.9, 1.5);
    let opened_side = side_energy(&opened_l, &opened_r, 0.9, 1.5);
    println!("width from zero: stayed {zero_side:.8}, opened {opened_side:.6}");
    assert!(opened_side > control_side * 0.5, "width up must respread a note started mono");
    assert!(zero_side < control_side * 1.0e-3, "a width-0 note stays mono without the knob");
}

// Per-sweep bounds sized ~2x the observed maxima, so a real click cannot hide under a shared
// loose threshold (the breath attack chiff legitimately steps ~0.31).
fn assert_smooth(name: &str, left: &[f32], right: &[f32], bound: f32) {
    let mut max_step = 0.0f32;
    for channel in [left, right] {
        assert!(channel.iter().all(|sample| sample.is_finite()), "{name}: non-finite output");
        for pair in channel.windows(2) {
            max_step = max_step.max((pair[1] - pair[0]).abs());
        }
    }
    println!("{name}: max sample step {max_step:.4}");
    assert!(max_step < bound, "{name}: click-sized discontinuity ({max_step:.3})");
}

#[test]
fn knob_sweeps_stay_click_free_and_finite() {
    let strike = Config {name: "sweep_strike", object_a: 1, damping_a: 0.75, ..BASE};
    let (left, right) = render_with(&strike, 57, 0.9, 2.4, 2.3, |time, shared| {
        shared.tune_a = (libm::sinf(time * 3.0) * 24.0) as i32;
        shared.damping_a = 0.5 + 0.45 * libm::sinf(time * 5.0);
        shared.width_a = 0.5 + 0.5 * libm::sinf(time * 4.0);
    });
    assert_smooth("strike sweep", &left, &right, 0.08);
    let breath = configs().into_iter().find(|config| config.name == "breath_vibe_pair").unwrap();
    let (left, right) = render_with(&breath, 57, 0.9, 2.4, 2.0, |time, shared| {
        shared.damping_a = 0.5 + 0.45 * libm::sinf(time * 4.0);
        shared.intensity = 0.5 + 0.5 * libm::sinf(time * 2.5);
        shared.detune_b = 25.0 * libm::sinf(time * 2.0);
        shared.level_b = 0.5 + 0.5 * libm::sinf(time * 3.0);
    });
    assert_smooth("breath sweep", &left, &right, 0.6);
    let bow = configs().into_iter().find(|config| config.name == "bow_vibe").unwrap();
    let (left, right) = render_with(&bow, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.intensity = 0.4 + 0.35 * libm::sinf(time * 3.0);
        shared.damping_a = 0.6 + 0.35 * libm::sinf(time * 2.0);
        shared.width_a = 0.5 + 0.5 * libm::sinf(time * 5.0);
        shared.tune_a = (libm::sinf(time * 1.5) * 5.0) as i32;
    });
    assert_smooth("bow sweep", &left, &right, 0.12);
    let pick = configs().into_iter().find(|config| config.name == "pick_wire").unwrap();
    let (left, right) = render_with(&pick, 57, 0.9, 2.2, 1.8, |time, shared| {
        shared.tune_a = (libm::sinf(time * 2.0) * 12.0) as i32;
        shared.damping_a = 0.6 + 0.35 * libm::sinf(time * 3.0);
    });
    assert_smooth("pick sweep", &left, &right, 0.12);
    // Snap tunes are the click stressor for the waveguide: the delay must glide, not step.
    let (left, right) = render_with(&pick, 45, 0.9, 1.6, 1.4, |time, shared| {
        shared.tune_a = if time >= 0.4 && time < 0.9 {24} else {-24};
    });
    assert_smooth("pick snap", &left, &right, 0.12);
    let wind = configs().into_iter().find(|config| config.name == "wind_bamboo").unwrap();
    let (left, right) = render_with(&wind, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.intensity = 0.5 + 0.45 * libm::sinf(time * 3.0);
        shared.damping_a = 0.5 + 0.4 * libm::sinf(time * 2.0);
        shared.width_a = 0.5 + 0.5 * libm::sinf(time * 4.0);
        shared.tune_a = (libm::sinf(time * 1.2) * 4.0) as i32;
    });
    assert_smooth("wind sweep", &left, &right, 0.3);
}

// Scan goertzel around the expected fundamental — immune to strong harmonics.
fn dominant_cents(samples: &[f32], expected: f32) -> f32 {
    let mut best_cents = 0.0f32;
    let mut best = f32::MIN;
    let mut cents = -150.0f32;
    while cents <= 150.0 {
        let power = goertzel_power(samples, expected * libm::powf(2.0, cents / 1200.0));
        if power > best {
            best = power;
            best_cents = cents;
        }
        cents += 3.0;
    }
    best_cents
}

#[test]
fn pick_is_in_tune_across_the_range() {
    // The waveguide loop's allpass + damping filters carry real phase delay; uncompensated it
    // reads as flatness growing with pitch (was −59c nylon / −94c wire at p69).
    for (name, object) in [("nylon", 0), ("wire", 5)] {
        for pitch in [45u32, 57, 69, 81, 84] {
            let config = Config {name: "tune_probe", exciter: Exciter::Pick, intensity: 0.68,
                position: 0.15, object_a: object, damping_a: 0.7, ..BASE};
            let (left, right) = render(&config, pitch, 0.9, 1.4, 1.3);
            let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
            let window = &mono[(0.3 * SAMPLE_RATE) as usize..(1.1 * SAMPLE_RATE) as usize];
            let expected = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
            let cents = dominant_cents(window, expected);
            println!("pick {name} p{pitch}: {cents:+.1} cents");
            assert!(cents.abs() <= 6.0, "pick {name} p{pitch} out of tune ({cents:+.1}c)");
        }
    }
}

#[test]
fn pick_color_is_tone_not_volume() {
    // Intensity was inverted (bright = heavy loop damping) and rode the level by 13dB.
    let mut shares = [0.0f32; 2];
    let mut peaks = [0.0f32; 2];
    for (slot, intensity) in [0.0f32, 1.0].iter().enumerate() {
        let config = Config {name: "color_probe", exciter: Exciter::Pick, intensity: *intensity,
            position: 0.15, object_a: 0, damping_a: 0.7, ..BASE};
        let (left, _) = render(&config, 57, 0.9, 1.0, 0.9);
        peaks[slot] = left.iter().fold(0.0f32, |acc, sample| acc.max(sample.abs()));
        shares[slot] = hf_share(&left, 0.05, 0.9);
    }
    println!("pick color: peaks {:.3}/{:.3}, hf-shares {:.5}/{:.5}",
        peaks[0], peaks[1], shares[0], shares[1]);
    assert!(shares[1] > shares[0] * 2.0, "bright pick must carry more HF than dark");
    assert!(peaks[1] < peaks[0] * 2.0 && peaks[0] < peaks[1] * 2.0,
        "pick color must not swing the attack level (peaks {:.3} vs {:.3})", peaks[0], peaks[1]);
}

#[test]
fn pick_width_spreads_the_polarizations() {
    let side_mid = |left: &[f32], right: &[f32]| {
        let side: f32 = left.iter().zip(right)
            .map(|(sample_l, sample_r)| (sample_l - sample_r) * (sample_l - sample_r)).sum();
        let mid: f32 = left.iter().zip(right)
            .map(|(sample_l, sample_r)| (sample_l + sample_r) * (sample_l + sample_r)).sum();
        side / mid.max(1.0e-9)
    };
    let mut ratios = [0.0f32; 3];
    for (slot, width) in [0.0f32, 0.6, 1.0].iter().enumerate() {
        let config = Config {name: "width_probe", exciter: Exciter::Pick, intensity: 0.68,
            position: 0.15, object_a: 0, damping_a: 0.7, width_a: *width, ..BASE};
        let (left, right) = render(&config, 57, 0.9, 1.0, 0.9);
        ratios[slot] = side_mid(&left, &right);
    }
    println!("pick width side/mid: {:.5} / {:.5} / {:.5}", ratios[0], ratios[1], ratios[2]);
    assert!(ratios[0] < 1.0e-6, "width 0 must be mono");
    assert!(ratios[2] > ratios[1] * 1.8, "width must keep spreading past the default");
    // And live: opening the knob mid-note must spread a note started narrow.
    let config = Config {name: "width_live_probe", exciter: Exciter::Pick, intensity: 0.68,
        position: 0.15, object_a: 0, damping_a: 0.7, width_a: 0.0, ..BASE};
    let (left, right) = render_with(&config, 57, 0.9, 1.2, 1.1, |time, shared| {
        if time >= 0.3 {shared.width_a = 1.0;}
    });
    let late_l = &left[(0.6 * SAMPLE_RATE) as usize..];
    let late_r = &right[(0.6 * SAMPLE_RATE) as usize..];
    let live_ratio = side_mid(late_l, late_r);
    println!("pick width live from zero: {live_ratio:.5}");
    assert!(live_ratio > ratios[1] * 0.5, "width must open live on a sounding pick");
}

#[test]
fn wind_pipe_is_in_tune_across_the_range() {
    // The jet loop blows sharp of the bore resonance by a pitch/loss-dependent amount; the
    // zero-crossing servo (with sub-period crossings merged) must land every pipe on the note.
    for (name, object, intensity, position) in
        [("bamboo", 0, 0.55, 0.3f32), ("husky", 3, 0.75, 0.55), ("metal", 2, 0.6, 0.4)] {
        for pitch in [45u32, 57, 69, 81] {
            let config = Config {name: "wind_tune", exciter: Exciter::Wind, intensity,
                position, vibrato: 0.0, object_a: object, damping_a: 0.6, ..BASE};
            let (left, right) = render(&config, pitch, 0.8, 2.0, 1.9);
            let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
            let window = &mono[(0.8 * SAMPLE_RATE) as usize..(1.8 * SAMPLE_RATE) as usize];
            let expected = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
            let cents = dominant_cents(window, expected);
            println!("wind {name} p{pitch}: {cents:+.1} cents");
            assert!(cents.abs() <= 9.0, "wind {name} p{pitch} out of tune ({cents:+.1}c)");
        }
    }
}

#[test]
fn wind_chromatic_runs_land_each_semitone() {
    // Regression: cold jet+bore onsets picked regimes chaotically and the servo re-learned the
    // pipe per note — fast semitone runs missed by over a semitone. Seeded onsets + persistent
    // trim + steady-breath-only measurements keep every note recognizably on its pitch.
    let cases = [(0.15f32, 0.12f32, 0.9f32, 45.0f32), (0.3, 0.25, 0.8, 30.0), (0.6, 0.5, 0.6, 15.0)];
    for (spacing, held, velocity, bound) in cases {
        let mut shared = shared_for(&Config {name: "chromatic", exciter: Exciter::Wind,
            intensity: 0.6, position: 0.3, vibrato: 0.15, object_a: 0, damping_a: 0.5,
            width_a: 0.4, ..BASE});
        shared.sample_rate = SAMPLE_RATE;
        let mut voice = KorpusVoice::default();
        let block = abi::Block {index: 0, flags: abi::BlockFlags(0), bpm: 120.0, p0: 0.0,
            p1: 0.0, s0: 0, s1: 0};
        let pitches: Vec<u32> = (57..=69).collect();
        let total = ((pitches.len() as f32 * spacing + 1.0) * SAMPLE_RATE) as usize;
        let mut left_all = vec![0.0f32; total];
        let mut position = 0;
        let mut next = 0;
        while position < total {
            let len = CHUNK_MAX.min(total - position);
            let time = position as f32 / SAMPLE_RATE;
            if next < pitches.len() && time >= next as f32 * spacing {
                let pitch = pitches[next];
                let frequency = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
                voice.start(&note_on(pitch, velocity), frequency, 1.0, 0.0, 1, &shared);
                next += 1;
            }
            if next > 0 && voice.gate() && time >= (next - 1) as f32 * spacing + held {
                voice.stop();
            }
            let mut left = [0.0f32; CHUNK_MAX];
            let mut right = [0.0f32; CHUNK_MAX];
            let mut slices: [&mut [f32]; 2] = [&mut left[..len], &mut right[..len]];
            let [l, r] = &mut slices;
            voice.process([l, r], &block, &shared);
            left_all[position..position + len].copy_from_slice(&left[..len]);
            position += len;
        }
        let mut worst = 0.0f32;
        for (index, pitch) in pitches.iter().enumerate() {
            let on = index as f32 * spacing;
            let from = ((on + 0.05) * SAMPLE_RATE) as usize;
            let to = ((on + held.min(spacing - 0.02)) * SAMPLE_RATE) as usize;
            let expected = 440.0 * libm::powf(2.0, (*pitch as f32 - 69.0) / 12.0);
            let cents = dominant_cents(&left_all[from..to], expected);
            if cents.abs() > worst.abs() {
                worst = cents;
            }
        }
        println!("chromatic {spacing}s notes: worst {worst:+.0}c (bound {bound})");
        assert!(worst.abs() <= bound,
            "chromatic run at {spacing}s spacing misses pitch ({worst:+.0}c)");
    }
}

#[test]
fn release_damps_sustained_tails() {
    let config = configs().into_iter().find(|config| config.name == "bow_vibe").unwrap();
    let (held_l, _) = render(&config, 57, 0.9, 3.0, 2.8);
    let (released_l, _) = render(&config, 57, 0.9, 3.0, 0.8);
    let window = (2.2 * SAMPLE_RATE) as usize..(2.8 * SAMPLE_RATE) as usize;
    let held_energy: f32 = held_l[window.clone()].iter().map(|s| s * s).sum();
    let released_energy: f32 = released_l[window].iter().map(|s| s * s).sum();
    assert!(released_energy < held_energy * 0.5,
        "release must damp the bow (held {held_energy:.6}, released {released_energy:.6})");
}

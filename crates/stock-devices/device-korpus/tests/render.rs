use device_korpus::engine::exciter::Strike;
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
    air: f32,
    stroke: f32,
    object_a: i32,
    damping_a: f32,
    width_a: f32,
    level_a: f32,
    object_b: i32,
    damping_b: f32,
    tune_b: f32,
    level_b: f32,
    routing: i32,
    couple: f32,
    sustained: bool,
}

const BASE: Config = Config {name: "", exciter: Exciter::Strike, intensity: 0.5, position: 0.35,
    vibrato: 0.0, air: 0.5, stroke: 0.5, object_a: 0, damping_a: 0.5, width_a: 0.6, level_a: 0.5, object_b: 6,
    damping_b: 0.5, tune_b: 0.0, level_b: 0.5, routing: 0, couple: 0.0, sustained: false};

fn configs() -> Vec<Config> {
    vec![
        Config {name: "strike_marimba", ..BASE},
        Config {name: "strike_plate_hard", intensity: 0.9, object_a: 4, damping_a: 0.25, ..BASE},
        Config {name: "gamelan_pair", object_a: 0, damping_a: 0.55, object_b: 1, damping_b: 0.75,
            tune_b: 0.07, couple: 0.25, ..BASE},
        Config {name: "bar_into_skin", damping_a: 0.3, object_b: 3, damping_b: 0.45, tune_b: -12.0,
            routing: 1, level_b: 0.8, ..BASE},
        Config {name: "bell_into_wire", intensity: 0.7, object_a: 2, damping_a: 0.8, object_b: 5,
            damping_b: 0.9, tune_b: 12.0, routing: 1, level_b: 0.75, ..BASE},
        Config {name: "breath_bar", exciter: Exciter::Breath, intensity: 0.45, object_a: 0,
            damping_a: 0.5, sustained: true, ..BASE},
        Config {name: "breath_vibe_pair", exciter: Exciter::Breath, intensity: 0.6, object_a: 1,
            damping_a: 0.8, object_b: 1, damping_b: 0.68, tune_b: 0.05, couple: 0.12,
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

// Bow, pick and wind playing object B, plus the vibrato and air paths they gained.
fn object_b_configs() -> Vec<Config> {
    vec![
        Config {name: "bow_glass_octave", exciter: Exciter::Bow, intensity: 0.3, position: 0.25,
            object_a: 1, damping_a: 0.85, vibrato: 0.15, object_b: 1, damping_b: 0.7, tune_b: 12.0,
            sustained: true, ..BASE},
        Config {name: "bow_wire_into_plate", exciter: Exciter::Bow, intensity: 0.55, position: 0.12,
            object_a: 5, damping_a: 0.7, vibrato: 0.25, air: 0.7, object_b: 4, routing: 1,
            sustained: true, ..BASE},
        Config {name: "pick_into_plate", exciter: Exciter::Pick, intensity: 0.68, position: 0.18,
            object_a: 1, damping_a: 0.6, object_b: 4, damping_b: 0.2, routing: 1, level_b: 0.6,
            air: 0.7, vibrato: 0.3, ..BASE},
        Config {name: "pick_banjo_pair", exciter: Exciter::Pick, intensity: 0.6, position: 0.2,
            object_a: 3, damping_a: 0.6, object_b: 0, tune_b: -12.0, couple: 0.5, ..BASE},
        Config {name: "wind_over_bell", exciter: Exciter::Wind, intensity: 0.55, position: 0.3,
            vibrato: 0.15, object_b: 2, tune_b: 12.0, damping_b: 0.6, sustained: true, ..BASE},
        Config {name: "wind_into_skin", exciter: Exciter::Wind, intensity: 0.75, position: 0.55,
            vibrato: 0.3, object_a: 3, damping_a: 0.55, object_b: 3, routing: 1, couple: 0.3,
            sustained: true, ..BASE},
    ]
}

fn shared_for(config: &Config) -> KorpusShared {
    let mut shared = KorpusShared {
        exciter: config.exciter,
        intensity: config.intensity,
        position: config.position,
        vibrato: config.vibrato,
        air: config.air,
        stroke: config.stroke,
        object_a: config.object_a,
        damping_a: config.damping_a,
        width_a: config.width_a,
        level_a: config.level_a,
        object_b: config.object_b,
        damping_b: config.damping_b,
        tune_b: config.tune_b,
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
        shared.advance_motor(len);
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
    for config in configs().into_iter().chain(object_b_configs()) {
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
    let list: Vec<Config> = configs().into_iter().chain(object_b_configs()).collect();
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
        object_a: 0, damping_a: 0.5, object_b: 1, damping_b: 0.6, tune_b: 7.0, level_b: 0.6,
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
        if time >= 1.0 {shared.tune_b = 9.0;}
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
        shared.tune_b = 0.25 * libm::sinf(time * 2.0);
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
    let (left, right) = render_with(&bow, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.level_a = if time >= 0.8 && time < 1.6 {0.0} else {1.0};
    });
    assert_smooth("level A snap", &left, &right, 0.12);
    let pick =configs().into_iter().find(|config| config.name == "pick_wire").unwrap();
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
        shared.air = 0.5 + 0.45 * libm::sinf(time * 2.5);
    });
    assert_smooth("wind sweep", &left, &right, 0.3);
    let tremolo = Config {name: "sweep_tremolo", object_a: 1, damping_a: 0.85, ..BASE};
    let (left, right) = render_with(&tremolo, 57, 0.9, 2.4, 2.3, |time, shared| {
        shared.vibrato = 0.5 + 0.5 * libm::sinf(time * 3.0);
    });
    assert_smooth("tremolo sweep", &left, &right, 0.08);
    // Air stays neutral here: pick noise is a deliberate attack transient, not a knob click.
    let pick_pair = object_b_configs().into_iter().find(|config| config.name == "pick_into_plate").unwrap();
    let (left, right) = render_with(&Config {air: 0.5, ..pick_pair}, 57, 0.9, 2.2, 1.8, |time, shared| {
        shared.vibrato = 0.5 + 0.5 * libm::sinf(time * 2.0);
        shared.level_b = 0.5 + 0.5 * libm::sinf(time * 3.0);
        shared.damping_b = 0.4 + 0.35 * libm::sinf(time * 2.5);
    });
    assert_smooth("pick pair sweep", &left, &right, 0.12);
    let wind_pair = object_b_configs().into_iter().find(|config| config.name == "wind_over_bell").unwrap();
    let (left, right) = render_with(&wind_pair, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.level_b = 0.5 + 0.5 * libm::sinf(time * 3.0);
        shared.tune_b = (12 + (libm::sinf(time * 1.3) * 5.0) as i32) as f32 + 0.2 * libm::sinf(time * 2.0);
        shared.width_b = 0.5 + 0.5 * libm::sinf(time * 4.0);
    });
    assert_smooth("wind pair sweep", &left, &right, 0.3);
    let bow_pair = object_b_configs().into_iter().find(|config| config.name == "bow_wire_into_plate").unwrap();
    let (left, right) = render_with(&Config {air: 0.5, ..bow_pair}, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.level_b = 0.5 + 0.5 * libm::sinf(time * 3.0);
        shared.tune_b = 0.2 * libm::sinf(time * 2.0);
    });
    assert_smooth("bow pair sweep", &left, &right, 0.25);
    // Heavy Air is broadband hiss by design; the bound only rules out a click on top of it.
    let (left, right) = render_with(&bow_pair, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.air = 0.5 + 0.45 * libm::sinf(time * 2.5);
    });
    assert_smooth("bow air sweep", &left, &right, 0.3);
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
            for stroke in [0.5f32, 0.0, 1.0] {
                let config = Config {name: "tune_probe", exciter: Exciter::Pick, intensity: 0.68,
                    position: 0.15, object_a: object, damping_a: 0.7, stroke, ..BASE};
                let (left, right) = render(&config, pitch, 0.9, 1.4, 1.3);
                let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
                let window = &mono[(0.3 * SAMPLE_RATE) as usize..(1.1 * SAMPLE_RATE) as usize];
                let expected = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
                let cents = dominant_cents(window, expected);
                println!("pick {name} p{pitch} stroke {stroke}: {cents:+.1} cents");
                assert!(cents.abs() <= 6.0, "pick {name} p{pitch} stroke {stroke} out of tune ({cents:+.1}c)");
            }
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

// Normalized autocorrelation at the pitch period (best lag within ±4 samples): 1.0 is a perfectly
// periodic tone; breath noise pulls it down. The standard breathiness measure for voices.
fn periodicity(samples: &[f32], frequency: f32) -> f32 {
    let period = (SAMPLE_RATE / frequency).round() as usize;
    let mut best = 0.0f32;
    for lag in period - 4..=period + 4 {
        let (mut cross, mut head, mut tail) = (0.0f64, 0.0f64, 0.0f64);
        for index in 0..samples.len() - lag {
            let (now, later) = (samples[index] as f64, samples[index + lag] as f64);
            cross += now * later;
            head += now * now;
            tail += later * later;
        }
        best = best.max((cross / (head * tail).sqrt().max(1.0e-12)) as f32);
    }
    best
}

#[test]
fn air_knob_sets_breathiness() {
    // Shakuhachi-like husky pipe: more Air must mean a less periodic, breathier signal, while the
    // pipe still plays in tune even at heavy air.
    let pipe = Config {name: "air_pipe", exciter: Exciter::Wind, intensity: 0.8, position: 0.6,
        object_a: 3, damping_a: 0.6, width_a: 0.3, sustained: true, ..BASE};
    let mut scores = [0.0f32; 3];
    for (slot, air) in [0.1f32, 0.5, 0.9].iter().enumerate() {
        let (left, right) = render(&Config {air: *air, ..pipe}, 62, 0.8, 1.8, 1.7);
        let mono: Vec<f32> = left.iter().zip(&right)
            .map(|(sample_l, sample_r)| sample_l + sample_r).collect();
        let window = &mono[(0.8 * SAMPLE_RATE) as usize..(1.6 * SAMPLE_RATE) as usize];
        let frequency = 440.0 * libm::powf(2.0, (62.0 - 69.0) / 12.0);
        scores[slot] = periodicity(window, frequency);
    }
    println!("air periodicity: 0.1 -> {:.4}, 0.5 -> {:.4}, 0.9 -> {:.4}", scores[0], scores[1], scores[2]);
    assert!(scores[0] > scores[1] && scores[1] > scores[2], "air must add breath noise monotonically");
    assert!(1.0 - scores[2] > (1.0 - scores[0]) * 3.0, "heavy air must be clearly breathier than light");
    for pitch in [45u32, 57, 69, 81] {
        let (left, right) = render(&Config {air: 0.9, vibrato: 0.0, ..pipe}, pitch, 0.8, 2.0, 1.9);
        let mono: Vec<f32> = left.iter().zip(&right)
            .map(|(sample_l, sample_r)| sample_l + sample_r).collect();
        let window = &mono[(0.8 * SAMPLE_RATE) as usize..(1.8 * SAMPLE_RATE) as usize];
        let expected = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
        let cents = dominant_cents(window, expected);
        println!("heavy air p{pitch}: {cents:+.1} cents");
        assert!(cents.abs() <= 9.0, "heavy air p{pitch} out of tune ({cents:+.1}c)");
    }
    // Live: opening Air on a sounding pipe breathes it up without a new note.
    let (light, _) = render(&Config {air: 0.1, ..pipe}, 62, 0.8, 1.8, 1.7);
    let (opened, _) = render_with(&Config {air: 0.1, ..pipe}, 62, 0.8, 1.8, 1.7, |time, shared| {
        if time >= 0.4 {shared.air = 0.9;}
    });
    let frequency = 440.0 * libm::powf(2.0, (62.0 - 69.0) / 12.0);
    let window = (0.9 * SAMPLE_RATE) as usize..(1.6 * SAMPLE_RATE) as usize;
    let light_score = periodicity(&light[window.clone()], frequency);
    let opened_score = periodicity(&opened[window], frequency);
    println!("air live: {light_score:.4} -> {opened_score:.4}");
    assert!(1.0 - opened_score > (1.0 - light_score) * 2.0, "air must breathe a sounding pipe live");
    // Breath exciter: Air is the direct air over the resonance.
    let breath = configs().into_iter().find(|config| config.name == "breath_bar").unwrap();
    let (dry, _) = render(&Config {air: 0.1, ..breath}, 57, 0.9, 1.6, 1.5);
    let (airy, _) = render(&Config {air: 0.9, ..breath}, 57, 0.9, 1.6, 1.5);
    let (dry_share, airy_share) = (hf_share(&dry, 0.6, 1.4), hf_share(&airy, 0.6, 1.4));
    println!("breath air hf-share: {dry_share:.5} -> {airy_share:.5}");
    assert!(airy_share > dry_share * 2.0, "air must add direct breath to the Breath exciter");
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

// A's render is deterministic and B never feeds back into it, so B alone = pair − make-up·(A alone).
fn isolate_b(pair: &[f32], alone: &[f32], make_up: f32) -> Vec<f32> {
    pair.iter().zip(alone).map(|(with, solo)| with - make_up * solo).collect()
}

// The voice's make-up gain on A when object B is on, relative to A playing alone.
fn make_up(config: &Config) -> f32 {
    match (config.exciter, config.routing) {
        (Exciter::Strike, 1) => 0.5 / 0.62,
        (Exciter::Strike, _) => 0.38 / 0.62,
        (Exciter::Breath, _) => 1.0,
        (_, 1) => 0.8,
        (Exciter::Bow, _) => 0.72,
        _ => 0.62,
    }
}

#[test]
fn object_b_rings_for_bow_pick_and_wind() {
    for config in object_b_configs() {
        let held = if config.sustained {1.5} else {1.2};
        let alone = Config {object_b: 6, ..config};
        let (pair_l, pair_r) = render(&config, 57, 0.9, 2.0, held);
        let (solo_l, solo_r) = render(&alone, 57, 0.9, 2.0, held);
        let gain = make_up(&config);
        let b_energy = window_energy(&isolate_b(&pair_l, &solo_l, gain), 0.2, 1.2);
        let a_energy = window_energy(&solo_l, 0.2, 1.2) * gain * gain;
        let b_db = 10.0 * libm::log10f(b_energy / a_energy);
        let level_db = 20.0 * libm::log10f(momentary_rms(&pair_l, &pair_r) / momentary_rms(&solo_l, &solo_r));
        println!("{}: object B {b_db:+.1}dB against A, pair {level_db:+.1}dB against A alone", config.name);
        assert!(b_db > -16.0, "{}: object B is inaudible ({b_db:+.1}dB against A)", config.name);
        assert!(level_db.abs() < 4.5, "{}: object B jumps the level ({level_db:+.1}dB)", config.name);
    }
}

#[test]
fn object_b_knobs_are_live_for_engines() {
    // A pipe over a vibraphone a fifth up: B's partial is separable, and the note is held throughout.
    let config = Config {name: "wind_pair", exciter: Exciter::Wind, intensity: 0.55, position: 0.3,
        object_b: 1, tune_b: 7.0, damping_b: 0.6, level_b: 0.8, sustained: true, ..BASE};
    let (solo, _) = render(&Config {object_b: 6, ..config}, 57, 0.9, 2.4, 2.3);
    let (control, _) = render(&config, 57, 0.9, 2.4, 2.3);
    let (muted, _) = render_with(&config, 57, 0.9, 2.4, 2.3, |time, shared| {
        if time >= 1.0 {shared.level_b = 0.0;}
    });
    let control_b = isolate_b(&control, &solo, 0.62);
    let muted_b = isolate_b(&muted, &solo, 0.62);
    let (control_energy, muted_energy) = (window_energy(&control_b, 1.6, 2.3), window_energy(&muted_b, 1.6, 2.3));
    println!("engine level B live: {control_energy:.5} -> {muted_energy:.5}");
    assert!(muted_energy < control_energy * 0.4, "Level B must duck object B on a held pipe");
    let (shifted, _) = render_with(&config, 57, 0.9, 2.4, 2.3, |time, shared| {
        if time >= 1.0 {shared.tune_b = 9.0;}
    });
    let shifted_b = isolate_b(&shifted, &solo, 0.62);
    let window = (1.6 * SAMPLE_RATE) as usize..(2.3 * SAMPLE_RATE) as usize;
    let (old, new) = (220.0 * libm::powf(2.0, 7.0 / 12.0), 220.0 * libm::powf(2.0, 9.0 / 12.0));
    let shifted_old = goertzel_power(&shifted_b[window.clone()], old);
    let shifted_new = goertzel_power(&shifted_b[window.clone()], new);
    let control_new = goertzel_power(&control_b[window], new);
    println!("engine tune B live: old bin {shifted_old:.4}, new bin {control_new:.4} -> {shifted_new:.4}");
    assert!(shifted_new > shifted_old * 2.0, "Tune B must move object B's partial on a held pipe");
    assert!(shifted_new > control_new * 2.0, "object B's partial must appear at the new pitch");
}

#[test]
fn level_a_scales_object_a_and_leaves_b_ringing() {
    // Unity at 0.5, double at 1.0; a live mute leaves exactly B alone, even when B rings from A (serial).
    // Coupled parallel pairs share their modes, so pair − A alone is not B there; they have their own test.
    let residual = |rendered: &[f32], expected: &[f32], from: f32, to: f32| {
        let difference: Vec<f32> = rendered.iter().zip(expected).map(|(value, target)| value - target).collect();
        window_energy(&difference, from, to) / window_energy(expected, from, to)
    };
    let breath_pair = configs().into_iter().find(|config| config.name == "breath_vibe_pair").unwrap();
    let pairs = configs().into_iter().chain(object_b_configs())
        .chain([Config {name: "breath_vibe_uncoupled", couple: 0.0, ..breath_pair}])
        .filter(|config| config.object_b < 6 && !(matches!(config.exciter, Exciter::Strike | Exciter::Breath)
            && config.routing == 0 && config.couple > 0.0));
    let mut checked = 0;
    for config in pairs {
        let held = if config.sustained {1.5} else {1.2};
        let (pair, _) = render(&config, 57, 0.9, 2.0, held);
        let (alone, _) = render(&Config {object_b: 6, ..config}, 57, 0.9, 2.0, held);
        let gain = make_up(&config);
        let b_only = isolate_b(&pair, &alone, gain);
        let (loud, _) = render(&Config {level_a: 1.0, ..config}, 57, 0.9, 2.0, held);
        let doubled_a: Vec<f32> = alone.iter().map(|sample| 2.0 * gain * sample).collect();
        let loud_error = residual(&isolate_b(&loud, &b_only, 1.0), &doubled_a, 0.0, held);
        let (muted, _) = render_with(&config, 57, 0.9, 2.0, held, |time, shared| {
            if time >= 0.3 {shared.level_a = 0.0;}
        });
        let muted_error = residual(&muted, &b_only, 0.6, held);
        println!("{}: level A 1.0 error {loud_error:.2e}, live mute error {muted_error:.2e}", config.name);
        assert!(loud_error < 1.0e-6, "{}: Level A 1.0 must double object A alone", config.name);
        assert!(muted_error < 1.0e-4, "{}: a live Level A 0 must leave object B alone", config.name);
        checked += 1;
    }
    assert_eq!(checked, 9);
}

#[test]
fn level_a_keeps_object_b_through_couple() {
    // Couple mixes A and B into shared modes; Level A must scale only A's share, so a muted A still leaves B.
    // Scaling the shared modes whole silenced the unison pair outright and left gamelan A +3.8 dB over B.
    let muted_energy = |config: &Config| {
        let (left, _) = render(&Config {level_a: 0.0, ..*config}, 57, 0.9, 1.4, 1.2);
        window_energy(&left, 0.05, 1.2)
    };
    let unison = Config {name: "vibe_unison", object_a: 1, damping_a: 0.7, object_b: 1, damping_b: 0.7,
        couple: 0.25, ..BASE};
    let gamelan = configs().into_iter().find(|config| config.name == "gamelan_pair").unwrap();
    let breath = configs().into_iter().find(|config| config.name == "breath_vibe_pair").unwrap();
    for (config, bound) in [(unison, 7.0), (gamelan, 2.0), (breath, 2.0)] {
        let db = 10.0 * libm::log10f(muted_energy(&config) / muted_energy(&Config {couple: 0.0, ..config}));
        println!("{}: muted A, coupled against uncoupled {db:+.2} dB", config.name);
        assert!(db.abs() < bound, "{}: a muted A must leave object B's share ({db:+.1} dB)", config.name);
    }
}

#[test]
fn couple_detunes_object_b_against_a() {
    // A unison vibraphone B sits on A's fundamental; Couple pushes it to the coupled gap (16Hz either side at full).
    let cases = [("pick serial", Exciter::Pick, 1), ("wind parallel", Exciter::Wind, 0),
        ("bow parallel", Exciter::Bow, 0), ("strike serial", Exciter::Strike, 1)];
    for (name, exciter, routing) in cases {
        let config = Config {name, exciter, intensity: 0.6, position: 0.25, object_a: 5, damping_a: 0.6,
            object_b: 1, routing, sustained: true, ..BASE};
        let (solo, _) = render(&Config {object_b: 6, ..config}, 57, 0.9, 2.4, 2.3);
        let window = (0.5 * SAMPLE_RATE) as usize..(2.3 * SAMPLE_RATE) as usize;
        let mut powers = [(0.0f32, 0.0f32); 2];
        for (slot, couple) in [0.0f32, 1.0].iter().enumerate() {
            let (pair, _) = render(&Config {couple: *couple, ..config}, 57, 0.9, 2.4, 2.3);
            let b = isolate_b(&pair, &solo, make_up(&config));
            let gap = goertzel_power(&b[window.clone()], 204.0).max(goertzel_power(&b[window.clone()], 236.0));
            powers[slot] = (goertzel_power(&b[window.clone()], 220.0), gap);
        }
        println!("{name}: B at 220Hz / 220±16Hz uncoupled {:.3e}/{:.3e}, coupled {:.3e}/{:.3e}",
            powers[0].0, powers[0].1, powers[1].0, powers[1].1);
        assert!(powers[1].0 < powers[0].0 * 0.25, "{name}: Couple must move B off A's fundamental");
        // In Serial B only hears A, so off A's partials it rings less; in Parallel the exciter rings it at the gap.
        if routing == 0 {
            assert!(powers[1].1 > powers[0].1 * 2.0, "{name}: Couple must land B at the coupled gap");
        }
    }
}

// Envelope modulation depth: 10ms RMS frames, (max − min)/(max + min) over 200ms spans, averaged.
fn am_depth(samples: &[f32], from: f32, to: f32) -> f32 {
    let window = &samples[(from * SAMPLE_RATE) as usize..(to * SAMPLE_RATE) as usize];
    let envelope: Vec<f32> = window.chunks(480)
        .map(|frame| libm::sqrtf(frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32))
        .collect();
    let spans: Vec<f32> = envelope.chunks(20).map(|span| {
        let max = span.iter().cloned().fold(0.0f32, f32::max);
        let min = span.iter().cloned().fold(f32::MAX, f32::min);
        (max - min) / (max + min).max(1.0e-9)
    }).collect();
    spans.iter().sum::<f32>() / spans.len() as f32
}

#[test]
fn vibrato_moves_strike_breath_and_pick() {
    let strike = Config {name: "tremolo", object_a: 1, damping_a: 0.85, ..BASE};
    let (still_l, still_r) = render(&strike, 60, 0.9, 2.5, 2.4);
    let (pulsing_l, pulsing_r) = render(&Config {vibrato: 0.5, ..strike}, 60, 0.9, 2.5, 2.4);
    let (still_depth, pulsing_depth) = (am_depth(&still_l, 0.3, 2.3), am_depth(&pulsing_l, 0.3, 2.3));
    let level_db = 20.0 * libm::log10f(momentary_rms(&pulsing_l, &pulsing_r) / momentary_rms(&still_l, &still_r));
    println!("strike tremolo depth {still_depth:.3} -> {pulsing_depth:.3}, level {level_db:+.1}dB");
    assert!(still_depth < 0.15 && pulsing_depth > 0.4, "Vibrato must pulse a struck vibraphone");
    assert!(level_db.abs() < 2.0, "the tremolo must not jump the level ({level_db:+.1}dB)");
    let breath = Config {name: "pulse", exciter: Exciter::Breath, intensity: 0.6, object_a: 1, damping_a: 0.8,
        sustained: true, ..BASE};
    let (still, _) = render(&breath, 60, 0.9, 3.0, 2.9);
    let (pulsing, _) = render(&Config {vibrato: 0.5, ..breath}, 60, 0.9, 3.0, 2.9);
    let (still_late, pulsing_late) = (am_depth(&still, 1.2, 2.8), am_depth(&pulsing, 1.2, 2.8));
    let (still_early, pulsing_early) = (am_depth(&still, 0.1, 0.3), am_depth(&pulsing, 0.1, 0.3));
    println!("breath pulse depth early {still_early:.3} -> {pulsing_early:.3}, late {still_late:.3} -> {pulsing_late:.3}");
    assert!(pulsing_late > still_late * 2.0, "Vibrato must pulse the breath once the note has spoken");
    assert!((pulsing_early - still_early).abs() < 0.03, "the breath pulse must wait for the attack");
    let pick = Config {name: "finger", exciter: Exciter::Pick, intensity: 0.68, position: 0.18, damping_a: 0.8, ..BASE};
    let spreads = |vibrato: f32| {
        let (left, right) = render(&Config {vibrato, ..pick}, 57, 0.9, 2.0, 1.9);
        let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
        let cents: Vec<f32> = (0..72).map(|step| {
            let from = (0.05 + step as f32 * 0.025) * SAMPLE_RATE;
            dominant_cents(&mono[from as usize..(from + 0.05 * SAMPLE_RATE) as usize], 220.0)
        }).collect();
        let spread = |values: &[f32]| values.iter().cloned().fold(f32::MIN, f32::max)
            - values.iter().cloned().fold(f32::MAX, f32::min);
        (spread(&cents[..6]), spread(&cents[24..]))
    };
    let (still_early, still_late) = spreads(0.0);
    let (bent_early, bent_late) = spreads(0.5);
    println!("pick vibrato spread early {still_early:.0}c -> {bent_early:.0}c, late {still_late:.0}c -> {bent_late:.0}c");
    assert!(bent_late >= still_late + 10.0, "Vibrato must bend a ringing string");
    assert!(bent_early <= still_early + 3.0, "the string vibrato must come in after the pluck");
}

#[test]
fn tremolo_follows_the_shared_motor() {
    // Two strikes half a motor turn apart pulse in opposition: the motor is shared, not restarted per note.
    let strike = Config {name: "motor", object_a: 1, damping_a: 0.85, vibrato: 0.5, ..BASE};
    let (on_beat, _) = render(&strike, 60, 0.9, 2.0, 1.9);
    let (off_beat, _) = render_with(&strike, 60, 0.9, 2.0, 1.9, |time, shared| {
        if time == 0.0 {shared.motor_phase = 0.5;}
    });
    // 10ms frames over a ~one-turn (190ms) moving average leave only the tremolo.
    let pulse = |samples: &[f32]| {
        let envelope: Vec<f32> = samples[(0.3 * SAMPLE_RATE) as usize..(1.8 * SAMPLE_RATE) as usize].chunks(480)
            .map(|frame| libm::sqrtf(frame.iter().map(|sample| sample * sample).sum::<f32>() / 480.0)).collect();
        (9..envelope.len() - 9).map(|index| {
            envelope[index] / (envelope[index - 9..=index + 9].iter().sum::<f32>() / 19.0) - 1.0
        }).collect::<Vec<f32>>()
    };
    let (first, second) = (pulse(&on_beat), pulse(&off_beat));
    let cross: f32 = first.iter().zip(&second).map(|(one, two)| one * two).sum();
    let norm = libm::sqrtf(first.iter().map(|one| one * one).sum::<f32>() * second.iter().map(|two| two * two).sum::<f32>());
    let correlation = cross / norm.max(1.0e-9);
    println!("tremolo correlation half a turn apart: {correlation:.3}");
    assert!(correlation < -0.5, "the tremolo must follow the shared motor phase");
}

#[test]
fn air_adds_contact_rosin_and_pick_noise() {
    let strike = Config {name: "mallet", ..BASE};
    let (natural_l, natural_r) = render(&strike, 57, 0.9, 1.0, 0.9);
    let (airy_l, airy_r) = render(&Config {air: 1.0, ..strike}, 57, 0.9, 1.0, 0.9);
    let (natural_hf, airy_hf) = (hf_share(&natural_l, 0.0, 0.03), hf_share(&airy_l, 0.0, 0.03));
    let strike_db = 20.0 * libm::log10f(momentary_rms(&airy_l, &airy_r) / momentary_rms(&natural_l, &natural_r));
    println!("strike contact hf {natural_hf:.4} -> {airy_hf:.4}, level {strike_db:+.1}dB");
    assert!(airy_hf > natural_hf * 5.0, "Air must add mallet contact noise");
    assert!(strike_db.abs() < 1.5, "contact noise must not jump the level ({strike_db:+.1}dB)");
    let pick = configs().into_iter().find(|config| config.name == "pick_nylon").unwrap();
    let (natural_l, natural_r) = render(&pick, 57, 0.9, 1.2, 1.1);
    let (airy_l, airy_r) = render(&Config {air: 1.0, ..pick}, 57, 0.9, 1.2, 1.1);
    let (natural_hf, airy_hf) = (hf_share(&natural_l, 0.0, 0.04), hf_share(&airy_l, 0.0, 0.04));
    let pick_db = 20.0 * libm::log10f(momentary_rms(&airy_l, &airy_r) / momentary_rms(&natural_l, &natural_r));
    println!("pick noise hf {natural_hf:.4} -> {airy_hf:.4}, level {pick_db:+.1}dB");
    assert!(airy_hf > natural_hf * 5.0, "Air must add pick noise");
    assert!(pick_db.abs() < 1.5, "pick noise must not jump the level ({pick_db:+.1}dB)");
    let bow = configs().into_iter().find(|config| config.name == "bow_wire").unwrap();
    let rosin: Vec<f32> = [0.0f32, 0.5, 1.0].iter().map(|air| {
        let (left, _) = render(&Config {air: *air, ..bow}, 57, 0.9, 2.0, 1.9);
        hf_share(&left, 1.0, 1.8)
    }).collect();
    println!("bow rosin hf at air 0 / 0.5 / 1: {:.4} / {:.4} / {:.4}", rosin[0], rosin[1], rosin[2]);
    assert!(rosin[0] < rosin[1] * 0.5, "less Air must quiet the rosin");
    assert!(rosin[2] > rosin[1] * 5.0, "more Air must add rosin hiss");
}

#[test]
fn pick_objects_are_distinct_strings() {
    // Object A picks the string: nylon, steel, chime, banjo, steel-string acoustic guitar, stiff wire.
    let decay_db = |object: i32, pitch: u32| {
        let config = Config {name: "string", exciter: Exciter::Pick, intensity: 0.6, position: 0.18,
            object_a: object, damping_a: 0.6, ..BASE};
        let (left, right) = render(&config, pitch, 0.9, 2.5, 2.4);
        let decay = 10.0 * libm::log10f(window_energy(&left, 1.5, 2.0) / window_energy(&left, 0.05, 0.3));
        let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
        let expected = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
        let cents = dominant_cents(&mono[(0.3 * SAMPLE_RATE) as usize..(1.2 * SAMPLE_RATE) as usize], expected);
        (decay, momentary_rms(&left, &right), cents)
    };
    for pitch in [45u32, 57, 69, 81] {
        let (nylon_decay, nylon_rms, _) = decay_db(0, pitch);
        let strings: Vec<(f32, f32, f32)> = (0..6).map(|object| decay_db(object, pitch)).collect();
        println!("p{pitch} decay dB: {:?}", strings.iter().map(|string| libm::roundf(string.0)).collect::<Vec<f32>>());
        for (object, (_, rms, cents)) in strings.iter().enumerate() {
            let level_db = 20.0 * libm::log10f(rms / nylon_rms);
            assert!(level_db.abs() < 3.0, "string {object} p{pitch}: {level_db:+.1}dB against nylon");
            assert!(cents.abs() <= 6.0, "string {object} p{pitch} out of tune ({cents:+.0}c)");
        }
        if pitch <= 69 {
            assert!(strings[1].0 > nylon_decay + 8.0, "p{pitch}: steel must ring longer than nylon");
            assert!(strings[2].0 > nylon_decay + 4.0, "p{pitch}: the chime must ring longer than nylon");
            assert!(strings[3].0 < nylon_decay - 20.0, "p{pitch}: the banjo must die away fast");
        }
    }
}

#[test]
fn guitar_string_rings_in_two_stages() {
    // The guitar's horizontal polarization outlives its vertical one (a real guitar's vertical motion drains
    // into the top; here only the T60 ratio models it), so it falls fast, then rings on in a quiet tail.
    // Nylon decays at one steady rate. Rates are dB per second, in the low register the loop-gain cap spares.
    let rates = |object: i32, pitch: u32| {
        let config = Config {name: "two_stage", exciter: Exciter::Pick, intensity: 0.6, position: 0.2,
            object_a: object, damping_a: 0.6, ..BASE};
        let (left, _) = render(&config, pitch, 0.8, 4.2, 4.1);
        let level = |from: f32, to: f32| 10.0 * libm::log10f(window_energy(&left, from, to) / (to - from));
        ((level(0.6, 0.9) - level(0.05, 0.25)) / 0.6, (level(3.5, 3.9) - level(1.8, 2.2)) / 1.7)
    };
    for pitch in [45u32, 57] {
        let (nylon_early, nylon_late) = rates(0, pitch);
        let (guitar_early, guitar_late) = rates(4, pitch);
        println!("p{pitch}: nylon {nylon_early:.1} then {nylon_late:.1} dB/s, \
            guitar {guitar_early:.1} then {guitar_late:.1} dB/s");
        assert!(guitar_early < guitar_late * 1.6, "p{pitch}: the guitar must fall fast, then settle into its tail");
        assert!(guitar_late > nylon_late + 6.0, "p{pitch}: the guitar's tail must outlast nylon's");
        assert!(guitar_late < nylon_late + 15.0, "p{pitch}: the guitar's tail must still decay");
    }
}

#[test]
fn a_melody_over_a_held_chord_leaves_the_chord_ringing() {
    // The 16-voice pool: a held 6-note chord plus an overlapping melody must not steal chord voices.
    // The pool is ~900KB (the device keeps it in its pre-allocated state), so the test needs its own stack.
    std::thread::Builder::new().stack_size(8 * 1024 * 1024)
        .spawn(melody_over_held_chord).unwrap().join().unwrap();
}

fn melody_over_held_chord() {
    use voicing::{Voicing, VoicingMode};
    let config = Config {name: "pool", exciter: Exciter::Pick, intensity: 0.65, position: 0.16,
        air: 0.55, stroke: 0.66, object_a: 4, damping_a: 0.8, ..BASE};
    let shared = shared_for(&config);
    let mut voicing: Voicing<KorpusVoice, 16, 16> = Voicing::new();
    voicing.set_mode(VoicingMode::Polyphonic);
    let block = abi::Block {index: 0, flags: abi::BlockFlags(0), bpm: 120.0, p0: 0.0, p1: 0.0, s0: 0, s1: 0};
    let chord: [u32; 6] = [40, 47, 52, 56, 59, 64];
    let melody: [u32; 8] = [76, 74, 72, 71, 69, 67, 66, 68];
    let total = (6.0 * SAMPLE_RATE) as usize;
    let mut out = vec![0.0f32; total];
    let mut position = 0;
    while position < total {
        let len = CHUNK_MAX.min(total - position);
        let time = position as f32 / SAMPLE_RATE;
        let starts = |pitch: u32, id: u32, at: f32| {
            (abi::EventRecord {position: 0.0, offset: 0, kind: abi::EVENT_NOTE_ON, id, pitch,
                velocity: 0.85, cent: 0.0, duration: 0.0}, at)
        };
        let mut events: Vec<(abi::EventRecord, f32)> = chord.iter().enumerate()
            .map(|(index, pitch)| starts(*pitch, index as u32, 0.0)).collect();
        events.extend(melody.iter().enumerate()
            .map(|(index, pitch)| starts(*pitch, 10 + index as u32, 1.0 + index as f32 * 0.4)));
        for (event, at) in events {
            if at >= time && at < time + len as f32 / SAMPLE_RATE {
                let frequency = 440.0 * libm::powf(2.0, (event.pitch as f32 - 69.0) / 12.0);
                voicing.start(&event, frequency, 1.0, 0.0, 1, &shared);
            }
        }
        for (index, _) in melody.iter().enumerate() {
            let off_at = 1.45 + index as f32 * 0.4;
            if off_at >= time && off_at < time + len as f32 / SAMPLE_RATE {
                voicing.stop(10 + index as i32, 0.0);
            }
        }
        let (mut left, mut right) = ([0.0f32; CHUNK_MAX], [0.0f32; CHUNK_MAX]);
        voicing.process([&mut left[..len], &mut right[..len]], &block, &shared);
        for index in 0..len {
            out[position + index] = 0.5 * (left[index] + right[index]);
        }
        position += len;
    }
    let window = (0.18 * SAMPLE_RATE) as usize;
    for (index, pitch) in melody.iter().enumerate() {
        let at = ((1.0 + index as f32 * 0.4) * SAMPLE_RATE) as usize + 480;
        let frequency = 440.0 * libm::powf(2.0, (*pitch as f32 - 69.0) / 12.0);
        let onset = goertzel_power(&out[at..at + window], frequency) / window as f32;
        assert!(onset > 1.0e-4, "melody {index} p{pitch} must trigger ({onset:.6})");
    }
    // The chord bass keeps its natural ring through the whole melody: no steal ever cuts it.
    let early = goertzel_power(&out[(3.0 * SAMPLE_RATE) as usize..(3.0 * SAMPLE_RATE) as usize + window], 82.407);
    let late = goertzel_power(&out[(5.5 * SAMPLE_RATE) as usize..(5.5 * SAMPLE_RATE) as usize + window], 82.407);
    // Natural decay leaves ~1% here; an 8-voice steal cut left ~2e-6.
    assert!(late > early * 1.0e-3, "the held chord bass must never be cut ({early:.5} -> {late:.5})");
}

#[test]
fn full_damping_opens_the_string() {
    // Above 70% the knob opens toward a free string: the late tail grows, into flat-top territory.
    // Monotonicity uses late-window energy — the polarizations beat at ~3s, wobbling a -60dB crossing.
    let rendered = |object_a: i32, damping: f32, pitch: u32| {
        let config = Config {name: "ring", exciter: Exciter::Pick, intensity: 0.68, position: 0.18,
            object_a, damping_a: damping, ..BASE};
        render(&config, pitch, 0.9, 20.0, 19.9).0
    };
    let ring = |left: &Vec<f32>| {
        let window = (0.25 * SAMPLE_RATE) as usize;
        let mut peak_db = f32::MIN;
        let mut crossing = 20.0f32;
        for (slot, chunk) in left.chunks(window).enumerate() {
            let energy: f32 = chunk.iter().map(|sample| sample * sample).sum();
            let db = 10.0 * libm::log10f(energy.max(1.0e-30) / window as f32);
            if db > peak_db {peak_db = db; crossing = 20.0;}
            if crossing == 20.0 && db < peak_db - 60.0 {crossing = slot as f32 * 0.25;}
        }
        crossing
    };
    let cases = [(4, 40, 14.0, 20.0), (4, 64, 8.0, 15.0), (0, 40, 11.0, 18.0), (1, 64, 8.0, 15.0)];
    for (object, pitch, at_least, at_most) in cases {
        let (mid, high, full) = (rendered(object, 0.7, pitch), rendered(object, 0.85, pitch),
            rendered(object, 1.0, pitch));
        let late = |left: &Vec<f32>| window_energy(left, 8.0, 10.0);
        let (late_mid, late_high, late_full) = (late(&mid), late(&high), late(&full));
        let full_ring = ring(&full);
        println!("object {object} p{pitch}: late tail {late_mid:.2e} -> {late_high:.2e} -> {late_full:.2e}, \
            100% rings {full_ring:.2}s");
        assert!(late_high > late_mid * 2.0, "object {object} p{pitch}: 85% must outring 70% late");
        assert!(late_full > late_high * 2.0, "object {object} p{pitch}: 100% must outring 85% late");
        assert!(full_ring > at_least && full_ring < at_most,
            "object {object} p{pitch}: full damping must ring {at_least}..{at_most}s ({full_ring:.1})");
    }
}

#[test]
fn pick_strings_keep_their_tail_through_a_live_damping_move() {
    // refresh() must re-apply each string's own T60 scale and horizontal ratio, not the nylon defaults.
    for object in 0..6 {
        let config = Config {name: "string", exciter: Exciter::Pick, intensity: 0.6, position: 0.2,
            object_a: object, damping_a: 0.6, ..BASE};
        let (still, _) = render(&config, 45, 0.8, 3.0, 2.9);
        let (moved, _) = render_with(&Config {damping_a: 0.5, ..config}, 45, 0.8, 3.0, 2.9,
            |_, shared| shared.damping_a = 0.6);
        let tail_db = 10.0 * libm::log10f(window_energy(&moved, 2.5, 2.9) / window_energy(&still, 2.5, 2.9));
        println!("string {object}: tail after a live Damping move {tail_db:+.2} dB");
        assert!(tail_db.abs() < 3.0, "string {object}: a live Damping move must keep the string's decay");
    }
}

fn checksum(left: &[f32], right: &[f32]) -> u64 {
    left.iter().chain(right).fold(0xcbf2_9ce4_8422_2325u64, |hash, sample| {
        (hash ^ sample.to_bits() as u64).wrapping_mul(0x0100_0000_01b3)
    })
}

#[test]
fn pick_stroke_default_is_bit_identical() {
    // Checksums rendered before Stroke existed: the default 0.5 must reproduce the pick bit for bit.
    // The damping-0.8 and damping-1.0 sums were re-rendered when Damping past 70% began opening the string.
    let wire = Config {name: "wire_snap", exciter: Exciter::Pick, intensity: 0.6, position: 0.12, object_a: 5,
        damping_a: 0.8, ..BASE};
    let (left, right) = render_with(&wire, 45, 0.9, 1.6, 1.4, |time, shared| {
        shared.tune_a = if time >= 0.4 && time < 0.9 {24} else {-24};
        shared.vibrato = 0.5 + 0.5 * libm::sinf(time * 2.0);
    });
    let mut sums = vec![checksum(&left, &right)];
    let steel = Config {name: "steel_air", exciter: Exciter::Pick, intensity: 0.7, position: 0.3, vibrato: 0.3,
        air: 0.7, object_a: 1, damping_a: 0.6, ..BASE};
    let (left, right) = render(&steel, 57, 0.9, 1.2, 1.0);
    sums.push(checksum(&left, &right));
    let banjo = Config {name: "soft_banjo", exciter: Exciter::Pick, intensity: 0.4, position: 0.5, object_a: 3,
        damping_a: 0.3, width_a: 0.2, ..BASE};
    let (left, right) = render(&banjo, 64, 0.4, 1.0, 0.6);
    sums.push(checksum(&left, &right));
    let bright = Config {name: "bright_guitar", exciter: Exciter::Pick, intensity: 1.0, position: 0.9, object_a: 4,
        damping_a: 1.0, width_a: 1.0, air: 1.0, ..BASE};
    let (left, right) = render(&bright, 84, 1.0, 1.2, 1.0);
    sums.push(checksum(&left, &right));
    println!("pick checksums: {sums:#018x?}");
    assert_eq!(sums, [0xb7c2_dc42_12c5_e07d_u64, 0x6391_49f7_9f35_fe05, 0xf4cd_2503_101e_296e, 0x420b_9685_cfd3_9ee0],
        "Stroke 0.5 must render today's pick bit for bit");
}

fn pick_string(object: i32, stroke: f32) -> Config {
    Config {name: "stroke", exciter: Exciter::Pick, intensity: 0.6, position: 0.2, object_a: object, damping_a: 0.6,
        stroke, ..BASE}
}

// The first 30ms against the ring at 300-600ms, per second of each, in dB.
fn attack_over_ring(left: &[f32], right: &[f32]) -> f32 {
    let mono: Vec<f32> = left.iter().zip(right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
    10.0 * libm::log10f(window_energy(&mono, 0.0, 0.03) / 0.03 * 0.3 / window_energy(&mono, 0.3, 0.6))
}

#[test]
fn pick_stroke_shallow_softens_the_first_stage() {
    // Velocity scales the whole pluck; only a shallower stroke also softens its attack against the ring.
    for object in 0..6 {
        for pitch in [45u32, 57, 69, 81] {
            let shape = |stroke: f32, velocity: f32| {
                let (left, right) = render(&pick_string(object, stroke), pitch, velocity, 0.7, 0.65);
                attack_over_ring(&left, &right)
            };
            let default = shape(0.5, 0.9);
            let shallow = shape(0.0, 0.9) - default;
            let halfway = shape(0.25, 0.9) - default;
            let deep = shape(1.0, 0.9) - default;
            let soft = shape(0.5, 0.4) - default;
            println!("string {object} p{pitch} attack over ring against the default: shallow {shallow:+.2} dB, \
                halfway {halfway:+.2}, deep {deep:+.2}, soft velocity {soft:+.2}");
            assert!(shallow < -1.8 && shallow > -8.0, "string {object} p{pitch}: shallow attack {shallow:+.2}dB");
            assert!(halfway < -0.6 && halfway > shallow, "string {object} p{pitch}: halfway attack {halfway:+.2}dB");
            assert!(deep > -0.2, "string {object} p{pitch}: a deep stroke must not soften the attack ({deep:+.2}dB)");
            assert!(soft.abs() < 0.3, "string {object} p{pitch}: velocity must keep the attack shape ({soft:+.2}dB)");
        }
    }
}

// Mean pitch between two instants from the phase the fundamental gains in 5ms hops, blind to the envelope.
fn glide_cents(samples: &[f32], expected: f32, from: f32, to: f32) -> f32 {
    let half = (2.0 * SAMPLE_RATE / expected) as usize;
    let phase_at = |center: usize| {
        let (mut real, mut imag) = (0.0f32, 0.0f32);
        for index in center - half..center + half {
            let weight = 1.0 - libm::fabsf((index as f32 - center as f32) / half as f32);
            let angle = 2.0 * core::f32::consts::PI * expected * index as f32 / SAMPLE_RATE;
            real += samples[index] * weight * libm::cosf(angle);
            imag -= samples[index] * weight * libm::sinf(angle);
        }
        libm::atan2f(imag, real)
    };
    let hop = (0.005 * SAMPLE_RATE) as usize;
    let (start, end) = ((from * SAMPLE_RATE) as usize, (to * SAMPLE_RATE) as usize);
    let mut turns = 0.0f32;
    let mut last = phase_at(start);
    for center in (start + hop..=end).step_by(hop) {
        let phase = phase_at(center);
        turns += libm::remainderf(phase - last, 2.0 * core::f32::consts::PI) / (2.0 * core::f32::consts::PI);
        last = phase;
    }
    let seconds = ((end - start) / hop * hop) as f32 / SAMPLE_RATE;
    1200.0 * libm::log2f(1.0 + turns / seconds / expected)
}

#[test]
fn pick_stroke_deep_twangs_then_settles() {
    let cents_at = |config: &Config, pitch: u32, velocity: f32, from: f32, to: f32| {
        let (left, right) = render(config, pitch, velocity, to + 0.05, to);
        let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
        glide_cents(&mono, 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0), from, to)
    };
    for pitch in [45u32, 57, 69] {
        let mut twangs = [0.0f32; 6];
        for object in 0..6 {
            let default = cents_at(&pick_string(object, 0.5), pitch, 0.9, 0.02, 0.06);
            twangs[object as usize] = cents_at(&pick_string(object, 1.0), pitch, 0.9, 0.02, 0.06) - default;
            let shallow = cents_at(&pick_string(object, 0.0), pitch, 0.9, 0.02, 0.06) - default;
            let soft = cents_at(&pick_string(object, 0.5), pitch, 0.4, 0.02, 0.06) - default;
            let later = cents_at(&pick_string(object, 1.0), pitch, 0.9, 0.25, 0.45)
                - cents_at(&pick_string(object, 0.5), pitch, 0.9, 0.25, 0.45);
            println!("string {object} p{pitch} cents against the default: deep 20-60ms {:+.1}, deep 250-450ms \
                {later:+.1}, shallow {shallow:+.1}, soft velocity {soft:+.1}", twangs[object as usize]);
            assert!(shallow.abs() < 1.5 && soft.abs() < 1.5, "string {object} p{pitch}: only a deep stroke may bend");
            assert!(later.abs() < 1.5, "string {object} p{pitch}: the twang must be gone by 250ms ({later:+.1}c)");
        }
        for object in [1usize, 3, 4] {
            assert!(twangs[object] > 4.0 && twangs[object] < 60.0,
                "string {object} p{pitch}: deep twang {:+.1}c", twangs[object]);
        }
        assert!(twangs[0] > 1.5 && twangs[0] < twangs[1], "p{pitch}: nylon must twang, less than steel");
    }
    for object in 0..6 {
        for pitch in [45u32, 69] {
            let config = Config {name: "deep_tune", exciter: Exciter::Pick, intensity: 0.68, position: 0.15,
                object_a: object, damping_a: 0.7, stroke: 1.0, ..BASE};
            let (left, right) = render(&config, pitch, 1.0, 1.2, 1.1);
            let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
            let expected = 440.0 * libm::powf(2.0, (pitch as f32 - 69.0) / 12.0);
            let cents = dominant_cents(&mono[(0.3 * SAMPLE_RATE) as usize..(1.1 * SAMPLE_RATE) as usize], expected);
            assert!(cents.abs() <= 6.0, "string {object} p{pitch}: a deep stroke must settle in tune ({cents:+.0}c)");
        }
    }
}

#[test]
fn pick_stroke_depth_sets_the_level() {
    let level = |config: &Config, pitch: u32| {
        let (left, right) = render(config, pitch, 0.9, 1.2, 1.1);
        momentary_rms(&left, &right)
    };
    let strokes = [0.0f32, 0.25, 0.5, 0.75, 1.0];
    for object in 0..6 {
        for pitch in [45u32, 57, 69, 81] {
            let reference = level(&pick_string(object, 0.5), pitch);
            let levels: Vec<f32> = strokes.iter()
                .map(|stroke| 20.0 * libm::log10f(level(&pick_string(object, *stroke), pitch) / reference)).collect();
            println!("string {object} p{pitch} stroke level dB: {levels:+.2?}");
            let louder = levels.windows(2).all(|pair| pair[1] > pair[0] + 0.05);
            assert!(louder, "string {object} p{pitch}: deeper must be louder");
            assert!(levels[0] > -6.5 && levels[0] < -2.5, "string {object} p{pitch}: shallow {:+.2}dB", levels[0]);
            assert!(levels[4] > 0.6 && levels[4] < 3.0, "string {object} p{pitch}: deep level {:+.2}dB", levels[4]);
        }
    }
    // A twang against a unison object B: parallel it beats, serial it rings less; deeper must stay louder.
    for object in [1, 3, 4] {
        for (object_b, routing) in [(0, 0), (0, 1), (5, 0), (5, 1)] {
            for pitch in [57u32, 64, 69] {
                let pair = |stroke: f32| Config {object_b, routing, ..pick_string(object, stroke)};
                let reference = level(&pair(0.5), pitch);
                let shallow = 20.0 * libm::log10f(level(&pair(0.0), pitch) / reference);
                let deep = 20.0 * libm::log10f(level(&pair(1.0), pitch) / reference);
                println!("string {object} into B {object_b} routing {routing} p{pitch}: shallow {shallow:+.2} dB, \
                    deep {deep:+.2} dB");
                assert!(deep > 0.45, "string {object} B {object_b} routing {routing} p{pitch}: deep {deep:+.2}dB");
                assert!(shallow < -1.5 && shallow > -6.5,
                    "string {object} B {object_b} routing {routing} p{pitch}: shallow {shallow:+.2}dB");
            }
        }
    }
}

#[test]
fn pick_stroke_applies_from_the_next_note() {
    // Pluck depth is a note-on decision like Air's pick noise: moving it over a ringing string changes nothing.
    let steel = Config {damping_a: 0.8, ..pick_string(1, 1.0)};
    let (still_l, still_r) = render(&steel, 57, 0.9, 1.5, 1.4);
    let (swept_l, swept_r) = render_with(&steel, 57, 0.9, 1.5, 1.4, |time, shared| {
        shared.stroke = 0.5 + 0.5 * libm::sinf(time * 7.0);
    });
    assert!(still_l == swept_l && still_r == swept_r, "a live Stroke move must wait for the next note");
    let wire = Config {stroke: 1.0, ..configs().into_iter().find(|config| config.name == "pick_wire").unwrap()};
    let (left, right) = render_with(&wire, 57, 0.9, 2.2, 1.8, |time, shared| {
        shared.tune_a = (libm::sinf(time * 2.0) * 12.0) as i32;
        shared.damping_a = 0.6 + 0.35 * libm::sinf(time * 3.0);
    });
    assert_smooth("deep pick sweep", &left, &right, 0.12);
    let (left, right) = render_with(&wire, 45, 0.9, 1.6, 1.4, |time, shared| {
        shared.tune_a = if time >= 0.4 && time < 0.9 {24} else {-24};
    });
    assert_smooth("deep pick snap", &left, &right, 0.08);
    // The twang and the softened stage move the string's read and gain per sample: steps grow only with level.
    let max_step = |left: &[f32], right: &[f32]| left.windows(2).chain(right.windows(2))
        .fold(0.0f32, |acc, pair| acc.max((pair[1] - pair[0]).abs()));
    for object in [1, 3] {
        let (left, right) = render(&Config {object_a: object, ..wire}, 57, 0.9, 1.0, 0.9);
        let deep_step = max_step(&left, &right);
        let (left, right) = render(&Config {object_a: object, stroke: 0.5, ..wire}, 57, 0.9, 1.0, 0.9);
        let default_step = max_step(&left, &right);
        let (left, right) = render(&Config {object_a: object, stroke: 0.0, ..wire}, 57, 0.9, 1.0, 0.9);
        let shallow_step = max_step(&left, &right);
        println!("string {object} largest step: shallow {shallow_step:.4}, default {default_step:.4}, \
            deep {deep_step:.4}");
        assert!(deep_step < 1.45 * default_step, "string {object}: a deep stroke's largest step grew past its level");
        assert!(shallow_step < default_step, "string {object}: a shallow stroke must not step harder");
    }
}

#[test]
fn pick_stroke_extremes_stay_bounded() {
    let corners: Vec<(f32, f32, f32, f32)> = (0..16).map(|bits| {
        let corner = |bit: i32| ((bits >> bit) & 1) as f32;
        (0.1 + 0.9 * corner(0), corner(1), corner(2), corner(3))
    }).collect();
    let mut worst = 0.0f32;
    for object in 0..6 {
        for pitch in (24u32..=96).step_by(12) {
            for (velocity, intensity, damping, stroke) in &corners {
                for (object_b, routing) in [(6, 0), (1, 0), (2, 1)] {
                    let config = Config {name: "extreme", exciter: Exciter::Pick, intensity: *intensity,
                        object_a: object, damping_a: *damping, stroke: *stroke, object_b, routing, couple: 1.0,
                        level_b: 1.0, damping_b: 1.0, ..BASE};
                    let (left, right) = render(&config, pitch, *velocity, 1.0, 0.6);
                    let peak = left.iter().chain(right.iter()).fold(0.0f32, |acc, sample| acc.max(sample.abs()));
                    assert!(peak.is_finite() && peak < 3.0, "string {object} p{pitch} v{velocity} i{intensity} \
                        d{damping} stroke {stroke} B {object_b}: peak {peak}");
                    worst = worst.max(peak);
                }
            }
        }
    }
    println!("pick stroke extremes: worst peak {worst:.3}");
}

// Momentary level of a held A3 bow note at each Stroke setting.
fn stroke_levels(config: &Config, strokes: &[f32]) -> Vec<f32> {
    strokes.iter().map(|stroke| {
        let (left, right) = render(&Config {stroke: *stroke, ..*config}, 57, 0.9, 2.4, 2.3);
        momentary_rms(&left, &right)
    }).collect()
}

fn gain_db(level: f32, reference: f32) -> f32 {
    20.0 * libm::log10f(level / reference)
}

// Deepest 50ms level in a span, in dB against the held note's 1.0-3.8s mean.
fn deepest_db(samples: &[f32], from: f32, to: f32) -> f32 {
    let mean = window_energy(samples, 1.0, 3.8) / (2.8 * SAMPLE_RATE);
    let mut deepest = f32::INFINITY;
    let mut start = from;
    while start + 0.05 <= to {
        deepest = deepest.min(window_energy(samples, start, start + 0.05) / (0.05 * SAMPLE_RATE));
        start += 0.01;
    }
    10.0 * libm::log10f(deepest / mean)
}

#[test]
fn stroke_is_bow_speed() {
    // At fixed pressure a faster bow is louder and hissier, a slower one quieter and grittier.
    for object in 0..6 {
        let config = Config {name: "speed", exciter: Exciter::Bow, object_a: object, sustained: true, ..BASE};
        let takes: Vec<(f32, f32)> = [0.0f32, 0.5, 1.0].iter().map(|stroke| {
            let (left, right) = render(&Config {stroke: *stroke, ..config}, 57, 0.9, 2.4, 2.3);
            (momentary_rms(&left, &right), hf_share(&left, 1.2, 2.2))
        }).collect();
        let (slow_db, fast_db) = (gain_db(takes[0].0, takes[1].0), gain_db(takes[2].0, takes[1].0));
        let (slow_hiss, fast_hiss) = (takes[0].1 / takes[1].1, takes[2].1 / takes[1].1);
        println!("object {object}: slow {slow_db:+.1}dB x{slow_hiss:.2} hiss, fast {fast_db:+.1}dB x{fast_hiss:.2}");
        assert!((-6.0..-1.3).contains(&slow_db), "object {object}: a slow bow must ease the level ({slow_db:+.1}dB)");
        assert!((1.2..4.0).contains(&fast_db), "object {object}: a fast bow must lift the level ({fast_db:+.1}dB)");
        assert!(fast_hiss > 1.4, "object {object}: a fast bow must add hair hiss (x{fast_hiss:.2})");
        assert!(slow_hiss < 0.88, "object {object}: a slow bow must lose hair hiss (x{slow_hiss:.2})");
    }
    // Air 0 mutes the hiss, leaving the slow bow's grit to roughen the stick-slip period.
    for object in [3, 4] {
        let config = Config {name: "grit", exciter: Exciter::Bow, object_a: object, air: 0.0, sustained: true, ..BASE};
        let roughness: Vec<f32> = [0.0f32, 0.5].iter().map(|stroke| {
            let (left, right) = render(&Config {stroke: *stroke, ..config}, 57, 0.9, 2.4, 2.3);
            let mono: Vec<f32> = left.iter().zip(&right).map(|(sample_l, sample_r)| sample_l + sample_r).collect();
            1.0 - periodicity(&mono[(1.2 * SAMPLE_RATE) as usize..(2.2 * SAMPLE_RATE) as usize], 220.0)
        }).collect();
        println!("object {object}: roughness slow {:.5}, default {:.5}", roughness[0], roughness[1]);
        assert!(roughness[0] > roughness[1] * 1.6, "object {object}: a slow bow must press into grit");
    }
}

#[test]
fn stroke_keeps_a_pressed_bow_speaking() {
    // At full pressure a slow bow must crunch, not choke into a quieter lock.
    for object in 0..6 {
        let config = Config {name: "pressed", exciter: Exciter::Bow, object_a: object, intensity: 1.0,
            sustained: true, ..BASE};
        let levels = stroke_levels(&config, &[0.0, 0.5, 1.0]);
        let (slow_db, fast_db) = (gain_db(levels[0], levels[1]), gain_db(levels[2], levels[1]));
        println!("pressed object {object}: slow {slow_db:+.1}dB, fast {fast_db:+.1}dB");
        assert!((-8.0..0.0).contains(&slow_db), "object {object}: a slow pressed bow choked ({slow_db:+.1}dB)");
        assert!((1.0..4.0).contains(&fast_db), "object {object}: a fast pressed bow must lift ({fast_db:+.1}dB)");
    }
}

#[test]
fn stroke_keeps_bow_pairs_in_step() {
    // A slow bow's crunch must not swell object B, nor a fast bow run it away.
    let serial = object_b_configs().into_iter().find(|config| config.name == "bow_wire_into_plate").unwrap();
    let coupled = Config {name: "coupled", exciter: Exciter::Bow, object_a: 5, object_b: 5, couple: 0.3,
        sustained: true, ..BASE};
    for (pair, fast_range) in [(serial, 1.4f32..4.0), (coupled, 0.3..2.1)] {
        let levels = stroke_levels(&pair, &[0.0, 0.5, 1.0]);
        let (slow_db, fast_db) = (gain_db(levels[0], levels[1]), gain_db(levels[2], levels[1]));
        println!("{}: slow {slow_db:+.1}dB, fast {fast_db:+.1}dB", pair.name);
        assert!((-6.0..-1.2).contains(&slow_db), "{}: a slow bow must ease the pair ({slow_db:+.1}dB)", pair.name);
        assert!(fast_range.contains(&fast_db), "{}: a fast bow must lift the pair ({fast_db:+.1}dB)", pair.name);
    }
}

#[test]
fn stroke_fast_light_bow_still_speaks() {
    // A fixed slip scale left these silent, or seconds late, on a fast bow.
    let mut quietest = f32::INFINITY;
    for object in [3, 5] {
        for intensity in [0.0f32, 0.1] {
            for damping_a in [0.0f32, 0.2] {
                for position in [0.05f32, 0.2, 0.9] {
                    let config = Config {name: "light", exciter: Exciter::Bow, object_a: object, intensity, damping_a,
                        position, sustained: true, ..BASE};
                    let levels = stroke_levels(&config, &[0.5, 0.75, 1.0]);
                    for level in &levels[1..] {
                        let fast_db = gain_db(*level, levels[0]);
                        quietest = quietest.min(fast_db);
                        assert!(fast_db > -1.5, "object {object} intensity {intensity} damping {damping_a} \
                            position {position}: a faster light bow lost its grip ({fast_db:+.1}dB)");
                    }
                }
            }
        }
    }
    println!("light bow: quietest faster take {quietest:+.1}dB");
}

#[test]
fn stroke_is_live_on_a_sounding_bow() {
    let config = configs().into_iter().find(|config| config.name == "bow_vibe").unwrap();
    let (control, _) = render(&config, 57, 0.9, 2.6, 2.5);
    let (slowed, _) = render_with(&config, 57, 0.9, 2.6, 2.5, |time, shared| {
        if time >= 1.2 {shared.stroke = 0.0;}
    });
    let (hurried, _) = render_with(&config, 57, 0.9, 2.6, 2.5, |time, shared| {
        if time >= 1.2 {shared.stroke = 1.0;}
    });
    let control_energy = window_energy(&control, 1.8, 2.5);
    let slow_energy = window_energy(&slowed, 1.8, 2.5);
    let fast_energy = window_energy(&hurried, 1.8, 2.5);
    let hiss = hf_share(&hurried, 1.8, 2.5) / hf_share(&control, 1.8, 2.5);
    println!("bow speed live: control {control_energy:.2}, slowed {slow_energy:.2}, hurried {fast_energy:.2}, \
        hiss x{hiss:.2}");
    assert!(slow_energy < control_energy * 0.8, "slowing the bow must ease a sounding note");
    assert!(fast_energy > control_energy * 1.4, "hurrying the bow must lift a sounding note");
    assert!(hiss > 1.3, "hurrying the bow must add hair hiss live");
    let light = Config {name: "light", exciter: Exciter::Bow, object_a: 3, intensity: 0.0, damping_a: 0.0,
        position: 0.9, sustained: true, ..BASE};
    let (steady, _) = render(&light, 57, 0.9, 3.0, 2.9);
    let (drawn, _) = render_with(&light, 57, 0.9, 3.0, 2.9, |time, shared| {
        if time >= 1.2 {shared.stroke = 1.0;}
    });
    let grip = window_energy(&drawn, 2.2, 2.9) / window_energy(&steady, 2.2, 2.9);
    println!("light bow hurried live: energy x{grip:.2}");
    assert!(grip > 1.3, "a light bow hurried live must keep its grip");
    // Air 0 mutes the hair hiss, whose broadband steps would hide a click.
    let dry = Config {air: 0.0, ..config};
    let (left, right) = render_with(&dry, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.stroke = 0.5 + 0.5 * libm::sinf(time * 3.0);
    });
    assert_smooth("bow stroke sweep", &left, &right, 0.04);
    let (left, right) = render_with(&dry, 57, 0.9, 2.6, 2.2, |time, shared| {
        shared.stroke = if (time * 2.0) as u32 % 2 == 1 {1.0} else {0.0};
    });
    assert_smooth("bow stroke snap", &left, &right, 0.05);
}

#[test]
fn stroke_sets_the_bow_change_rate() {
    // The first bow change lands at 2.4s / speed: 3.2s slow, 1.6s fast.
    let config = Config {name: "changes", exciter: Exciter::Bow, object_a: 3, air: 0.0, sustained: true, ..BASE};
    let (slow, _) = render(&Config {stroke: 0.0, ..config}, 57, 0.9, 4.0, 3.9);
    let (fast, _) = render(&Config {stroke: 1.0, ..config}, 57, 0.9, 4.0, 3.9);
    let (slow_early, slow_late) = (deepest_db(&slow, 2.4, 2.65), deepest_db(&slow, 3.2, 3.45));
    let (fast_early, fast_default) = (deepest_db(&fast, 1.6, 1.85), deepest_db(&fast, 2.4, 2.65));
    println!("bow changes: slow {slow_early:+.1}dB at 2.4s, {slow_late:+.1}dB at 3.2s; \
        fast {fast_early:+.1}dB at 1.6s, {fast_default:+.1}dB at 2.4s");
    assert!(slow_late < -2.0 && slow_late < slow_early - 2.0, "a slow bow must change later");
    assert!(fast_early < fast_default - 0.7, "a fast bow must change sooner");
}

#[test]
fn bow_stroke_extremes_stay_finite_and_bounded() {
    let knobs = [(0.0f32, 0.0f32, 0.0f32), (1.0, 1.0, 1.0), (1.0, 0.0, 0.0), (0.0, 1.0, 1.0)];
    let pairs = object_b_configs().into_iter().filter(|config| config.exciter == Exciter::Bow);
    let mut patches: Vec<Config> = pairs.map(|pair| Config {intensity: 1.0, air: 1.0, ..pair}).collect();
    for object in 0..6 {
        for (intensity, air, damping_a) in knobs {
            patches.push(Config {name: "extreme", exciter: Exciter::Bow, object_a: object, intensity, air,
                damping_a, sustained: true, ..BASE});
        }
    }
    let mut loudest = 0.0f32;
    for patch in patches.iter() {
        for pitch in [24u32, 60, 96] {
            for velocity in [0.1f32, 1.0] {
                for stroke in [0.0f32, 1.0] {
                    let (left, right) = render(&Config {stroke, ..*patch}, pitch, velocity, 1.2, 1.0);
                    let peak = left.iter().chain(right.iter()).fold(0.0f32, |acc, sample| acc.max(sample.abs()));
                    let finite = left.iter().chain(right.iter()).all(|sample| sample.is_finite());
                    let label = format!("{} object {} p{pitch} vel {velocity} intensity {} stroke {stroke}",
                        patch.name, patch.object_a, patch.intensity);
                    assert!(finite && peak < 3.0, "{label}: peak {peak}, finite {finite}");
                    loudest = loudest.max(peak);
                }
            }
        }
    }
    println!("stroke extremes: loudest peak {loudest:.3}");
}

#[test]
fn stroke_half_keeps_the_bow_bit_for_bit() {
    // FNV-1a over every sample's bits, pinned from the engine before Stroke existed.
    let mut takes = Vec::new();
    for object in 0..6 {
        let config = Config {name: "golden", exciter: Exciter::Bow, object_a: object, sustained: true, ..BASE};
        takes.push(render(&config, 45 + 5 * object as u32, 0.8, 3.0, 2.7));
    }
    for config in object_b_configs().into_iter().filter(|config| config.exciter == Exciter::Bow) {
        takes.push(render(&config, 57, 0.9, 2.0, 1.6));
    }
    let coupled = Config {name: "golden", exciter: Exciter::Bow, object_a: 2, object_b: 1, couple: 0.5,
        sustained: true, ..BASE};
    takes.push(render(&coupled, 57, 0.9, 1.5, 1.2));
    let membrane = configs().into_iter().find(|config| config.name == "bow_membrane").unwrap();
    takes.push(render_with(&membrane, 52, 0.9, 2.0, 1.6, |time, shared| {
        shared.intensity = 0.5 + 0.5 * libm::sinf(time * 3.0);
        shared.air = 0.5 + 0.5 * libm::sinf(time * 2.0);
        shared.damping_a = 0.5 + 0.4 * libm::sinf(time * 5.0);
    }));
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for (left, right) in takes.iter() {
        for sample in left.iter().chain(right.iter()) {
            for byte in sample.to_bits().to_le_bytes() {
                hash = (hash ^ byte as u64).wrapping_mul(0x0100_0000_01b3);
            }
        }
    }
    println!("bow golden hash {hash:#018x}");
    assert_eq!(hash, 0xf166_a145_23d7_15d8, "Stroke 0.5 must render today's bow bit for bit");
}

#[test]
fn stroke_leaves_breath_and_wind_untouched() {
    for name in ["breath_vibe_pair", "wind_bamboo"] {
        let config = configs().into_iter().find(|config| config.name == name).unwrap();
        let (left, right) = render(&config, 57, 0.9, 1.6, 1.2);
        let (moved_l, moved_r) = render_with(&Config {stroke: 0.0, ..config}, 57, 0.9, 1.6, 1.2, |time, shared| {
            shared.stroke = 0.5 + 0.5 * libm::sinf(time * 6.0);
        });
        assert!(moved_l == left && moved_r == right, "{name}: Stroke must not touch this exciter");
    }
}

// One Strike hit's drive, long enough to hold the heaviest head's push.
#[test]
fn a_reused_strike_starts_with_no_leftover_push() {
    // A default-stroke hit parks the push low-pass mid-value; the next hit on that voice must not replay it.
    let soft_peak = |strike: &mut Strike| {
        strike.strike(0.1, 0.0, 1.0, 0.5, SAMPLE_RATE);
        let mut peak = 0.0f32;
        for _ in 0..(SAMPLE_RATE * 0.1) as usize {
            peak = peak.max(libm::fabsf(strike.tick()));
        }
        peak
    };
    let mut reused = Strike::silent();
    reused.strike(1.0, 0.68, 0.5, 0.5, SAMPLE_RATE);
    for _ in 0..(SAMPLE_RATE * 0.1) as usize {
        reused.tick();
    }
    let reused_peak = soft_peak(&mut reused);
    let fresh_peak = soft_peak(&mut Strike::silent());
    println!("reused soft strike peak {reused_peak:.4} against fresh {fresh_peak:.4}");
    assert!(reused_peak < fresh_peak * 1.3, "a stale push must not thump the next note");
    assert!(reused_peak > fresh_peak * 0.7, "the reused strike must still speak");
}

fn strike_drive(velocity: f32, hardness_knob: f32, stroke: f32) -> Vec<f32> {
    let mut strike = Strike::silent();
    strike.strike(velocity, hardness_knob, stroke, 0.5, SAMPLE_RATE);
    (0..2048).map(|_| strike.tick()).collect()
}

// What is left of `target` after the best-gain copy of `candidate` is taken out, in dB of `target`.
fn residual_db(target: &[f32], candidate: &[f32]) -> f64 {
    let square = |samples: &[f32]| samples.iter().map(|sample| *sample as f64 * *sample as f64).sum::<f64>();
    let cross: f64 = target.iter().zip(candidate).map(|(want, have)| *want as f64 * *have as f64).sum();
    let gain = cross / square(candidate).max(1.0e-30);
    let left: f64 = target.iter().zip(candidate)
        .map(|(want, have)| (*want as f64 - gain * *have as f64).powi(2)).sum();
    10.0 * (left / square(target)).log10()
}

#[test]
fn default_stroke_keeps_the_contact_pulse_bit_identical() {
    // The pre-Stroke pulse written out: a unit-area raised cosine gated with the same LCG crack noise.
    assert_eq!(KorpusShared::silent().stroke, 0.5);
    let hits = [(0.915f32, 0.5f32, 48_000.0f32), (0.15, 0.0, 44_100.0), (1.0, 1.0, 96_000.0), (0.6, 0.3, 22_050.0),
        (0.4, 0.9, 192_000.0)];
    let mut strike = Strike::silent();
    let mut noise_state = 0x1234567u32;
    for round in 0..20 {
        let (velocity, hardness_knob, sample_rate) = hits[round % hits.len()];
        strike.strike(velocity, hardness_knob, 0.5, 0.5, sample_rate);
        let hardness = (hardness_knob * 0.75 + velocity * 0.35).clamp(0.0, 1.1);
        let len = ((0.009 * libm::powf(0.028, hardness) * sample_rate) as usize).max(4);
        let gain = 2.0 / len as f32 * velocity;
        let noise_gain = gain * 0.35 * (0.3 + hardness_knob);
        // Some hits are cut short by the next one, the rest ring on past their end.
        for step in 0..[len + 9, len / 3, 1, 2 * len][round % 4] {
            let expected = if step < len {
                let t = 1.0 - (len - step) as f32 / len as f32;
                let window = 0.5 * (1.0 - libm::cosf(2.0 * core::f32::consts::PI * t));
                noise_state = noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
                gain * window + ((noise_state >> 8) as f32 / 8388608.0 - 1.0) * noise_gain * window
            } else {
                0.0
            };
            assert_eq!(strike.tick().to_bits(), expected.to_bits(), "hit {round}, sample {step}");
        }
    }
}

#[test]
fn stroke_weighs_the_momentum_and_keeps_the_click() {
    // The felt meets the bar with the same onset slope whatever the head weighs, so weight moves the body and
    // leaves the click; its drive spectrum never crosses the default's, so level cannot flip with pitch.
    for (velocity, hardness_knob) in [(0.915f32, 0.5f32), (0.235, 0.0), (1.0, 1.0), (0.575, 0.8)] {
        let default = strike_drive(velocity, hardness_knob, 0.5);
        let (light, heavy) = (strike_drive(velocity, hardness_knob, 0.0), strike_drive(velocity, hardness_knob, 1.0));
        let change = |drive: &[f32], frequency: f32| {
            10.0 * libm::log10f(goertzel_power(drive, frequency) / goertzel_power(&default, frequency))
        };
        let (mut light_most, mut heavy_least, mut click) = (f32::MIN, f32::MAX, 0.0f32);
        for step in 0..64 {
            let frequency = 40.0 * libm::powf(2.0, step as f32 / 8.0);
            let (light_db, heavy_db) = (change(&light, frequency), change(&heavy, frequency));
            light_most = light_most.max(light_db);
            heavy_least = heavy_least.min(heavy_db);
            if frequency > 3000.0 {
                click = click.max(light_db.abs()).max(heavy_db.abs());
            }
        }
        let (light_body, heavy_body) = (change(&light, 40.0), change(&heavy, 40.0));
        println!("v{velocity} i{hardness_knob}: body {light_body:+.2} / {heavy_body:+.2} dB, click within \
            {click:.3} dB, light never above {light_most:+.3} dB, heavy never below {heavy_least:+.3} dB");
        assert!(light_body < -3.4 && heavy_body > 2.2, "weight must move the momentum below the click");
        assert!(heavy_body < 6.0, "the struck object's own mass must cap what a heavy head hands over");
        assert!(click < 0.5, "weight must leave the click above 3 kHz alone");
        assert!(light_most < 0.05 && heavy_least > -0.05, "a weight's drive must not cross the default's");
    }
}

#[test]
fn stroke_is_not_a_harder_or_louder_hit() {
    // The best-gain default pulse over every Intensity and velocity, matched to a light or heavy drive, still
    // leaves a residual, and so do the rendered notes: no other knob setting makes a weighted head's drive.
    let voice_velocity = |raw: f32| (0.15 + 0.85 * raw).clamp(0.0, 1.0);
    for stroke in [0.0f32, 1.0] {
        let target = strike_drive(voice_velocity(0.9), 0.5, stroke);
        let mut best = (f64::MAX, 0.0f32, 0.0f32);
        for step_intensity in 0..=100 {
            for step_velocity in 0..=100 {
                let (intensity, raw) = (step_intensity as f32 * 0.01, step_velocity as f32 * 0.01);
                let residual = residual_db(&target, &strike_drive(voice_velocity(raw), intensity, 0.5));
                if residual < best.0 {
                    best = (residual, intensity, raw);
                }
            }
        }
        for object in [0, 1, 4] {
            let config = Config {name: "weight", object_a: object, ..BASE};
            let (left, right) = render(&Config {stroke, ..config}, 57, 0.9, 1.0, 0.9);
            let (matched_left, matched_right) = render(&Config {intensity: best.1, ..config}, 57, best.2, 1.0, 0.9);
            let output = residual_db(&[left, right].concat(), &[matched_left, matched_right].concat());
            println!("stroke {stroke} object {object}: best match Intensity {:.2} velocity {:.2}, drive residual \
                {:.1} dB, output residual {output:.1} dB", best.1, best.2, best.0);
            assert!(best.0 > -17.0 && output > -17.0, "stroke {stroke} object {object}: a weight is a new drive");
        }
    }
}

#[test]
fn stroke_level_follows_the_head_within_budget() {
    // A3 at velocity 0.9: heavier is louder and lighter quieter on every object, Intensity and Damping, within
    // the -6..+4 dB budget, and object B follows in both routings.
    let level = |config: &Config| {
        let (left, right) = render(config, 57, 0.9, 1.3, 1.2);
        20.0 * libm::log10f(momentary_rms(&left, &right))
    };
    let mut pairs: Vec<Config> = configs().into_iter()
        .filter(|config| ["gamelan_pair", "bar_into_skin", "bell_into_wire"].contains(&config.name)).collect();
    for object in 0..6 {
        for intensity in [0.0f32, 0.5, 1.0] {
            for damping_a in [0.0f32, 0.5, 1.0] {
                pairs.push(Config {name: "weight", object_a: object, intensity, damping_a, ..BASE});
            }
        }
    }
    for config in &pairs {
        let default = level(config);
        let light = level(&Config {stroke: 0.0, ..*config}) - default;
        let heavy = level(&Config {stroke: 1.0, ..*config}) - default;
        let name = format!("{} object {} i{} d{}", config.name, config.object_a, config.intensity, config.damping_a);
        println!("{name}: light {light:+.2} dB, heavy {heavy:+.2} dB");
        assert!(light > -6.0 && light < -1.2, "{name}: a light head must be quieter, within -6 dB");
        assert!(heavy < 4.0 && heavy > 0.6, "{name}: a heavy head must be louder, within +4 dB");
    }
    // Weight is a note-on choice: turning it while a strike rings leaves that note untouched.
    let ringing = Config {name: "ringing", object_a: 1, damping_a: 0.8, ..BASE};
    let (still, _) = render(&ringing, 57, 0.9, 0.6, 0.5);
    let (turned, _) = render_with(&ringing, 57, 0.9, 0.6, 0.5, |time, shared| {
        if time >= 0.001 {shared.stroke = 1.0;}
    });
    assert!(still == turned, "a Stroke move must wait for the next strike");
}

#[test]
fn a_lighter_head_is_never_louder_at_any_pitch() {
    // Intensity and velocity sweep the pulse's spectral nulls across the partials; weight must not flip level.
    let mut worst = (f32::MIN, f32::MAX);
    for object in 0..6 {
        for pitch in [45u32, 57, 64, 69, 76, 84, 90, 96] {
            for velocity in [0.1f32, 0.9] {
                for intensity in [0.0f32, 0.5] {
                    let config = Config {name: "pitch", object_a: object, intensity, ..BASE};
                    let level = |stroke: f32| {
                        let (left, right) = render(&Config {stroke, ..config}, pitch, velocity, 0.5, 0.4);
                        20.0 * libm::log10f(momentary_rms(&left, &right))
                    };
                    let default = level(0.5);
                    let (light, heavy) = (level(0.0) - default, level(1.0) - default);
                    worst = (worst.0.max(light), worst.1.min(heavy));
                    assert!(light < 1.0 && heavy > -1.0, "object {object} p{pitch} v{velocity} i{intensity}: \
                        light {light:+.2} dB, heavy {heavy:+.2} dB");
                }
            }
        }
    }
    println!("lightest head at most {:+.2} dB, heaviest at least {:+.2} dB against the default", worst.0, worst.1);
}

#[test]
fn strike_stroke_extremes_stay_finite_and_bounded() {
    let corners = [(0.1f32, 0.0f32, 0.0f32), (0.1, 0.0, 1.0), (0.1, 1.0, 0.0), (0.1, 1.0, 1.0),
        (1.0, 0.0, 0.0), (1.0, 0.0, 1.0), (1.0, 1.0, 0.0), (1.0, 1.0, 1.0)];
    let mut worst = (0.0f32, 0.0f32, 0.0f32);
    for object in 0..6 {
        let objects_b = [(6, 0, 1.0f32), ((object + 1) % 6, 0, 0.5), ((object + 3) % 6, 1, 0.5)];
        for pitch in [24u32, 60, 96] {
            for (velocity, intensity, damping) in corners {
                for (object_b, routing, air) in objects_b {
                    let config = Config {name: "extreme", object_a: object, intensity, damping_a: damping, air,
                        object_b, damping_b: damping, routing, couple: 0.5, ..BASE};
                    let peaks: Vec<f32> = [0.5f32, 0.0, 1.0].iter().map(|stroke| {
                        let (left, right) = render(&Config {stroke: *stroke, ..config}, pitch, velocity, 0.25, 0.2);
                        assert!(left.iter().chain(right.iter()).all(|sample| sample.is_finite()),
                            "object {object} p{pitch} stroke {stroke}: non-finite output");
                        left.iter().chain(right.iter()).fold(0.0f32, |acc, sample| acc.max(sample.abs()))
                    }).collect();
                    let name = format!("object {object} B {object_b} p{pitch} v{velocity} i{intensity} d{damping}");
                    if object_b == 6 {
                        worst.0 = worst.0.max(peaks[2]);
                        assert!(peaks[1] < 3.0 && peaks[2] < 3.0, "{name}: peaks {:.3} / {:.3}", peaks[1], peaks[2]);
                    }
                    if peaks[0] > 0.05 {
                        worst.1 = worst.1.max(peaks[1] / peaks[0]);
                        worst.2 = worst.2.max(peaks[2] / peaks[0]);
                        // B's own hot corners already pass 3; a weight may only scale them, heavy by under +5 dB.
                        assert!(peaks[1] < peaks[0] * 1.05 && peaks[2] < peaks[0] * 1.75, "{name}: peaks \
                            {:.3} / {:.3} / {:.3}", peaks[0], peaks[1], peaks[2]);
                    }
                }
            }
        }
    }
    println!("heaviest peak alone {:.3}; peak ratio light x{:.3}, heavy x{:.3}", worst.0, worst.1, worst.2);
}

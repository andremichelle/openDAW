// Expected values were measured on Kilohearts Compactor (AU, 48 kHz) with the same signals and settings.
use super::*;
use ducker::{floor_sidechain, sidechain_gain, soft_clip, MODE_ISP, MODE_PEAK, MODE_RMS};

const SR: f32 = 48_000.0;

fn ducker() -> Box<Ducker> {
    let mut ducker: Box<Ducker> = Box::new(unsafe { core::mem::zeroed() });
    ducker.init(SR);
    ducker
}

// A deterministic noise source, so the tests need no rand crate.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
    }
}

// Runs the ducker over whole signals in render-quantum sized calls, like the engine does.
fn run(ducker: &mut Ducker, left: &[f32], right: &[f32], side: Option<(&[f32], &[f32])>) -> (Vec<f32>, Vec<f32>) {
    let frames = left.len();
    let (mut out_left, mut out_right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    let mut from = 0;
    while from < frames {
        let to = (from + 128).min(frames);
        ducker.process(left, right, side, &mut out_left, &mut out_right, from, to);
        from = to;
    }
    (out_left, out_right)
}

// The ducking amount at each output frame for a DC carrier of 1.0, aligned to the sidechain.
fn ducking(ducker: &mut Ducker, side: &[f32]) -> Vec<f32> {
    let carrier = vec![1.0f32; side.len()];
    let (out_left, _) = run(ducker, &carrier, &carrier, Some((side, side)));
    out_left[ducker.latency()..].iter().map(|gain| 1.0 - gain).collect()
}

fn near(actual: f32, expected: f32, tolerance: f32, label: &str) {
    assert!((actual - expected).abs() <= tolerance, "{label}: {actual} != {expected}");
}

#[test]
fn reports_ten_milliseconds_plus_nine_frames_as_latency() {
    let mut state: Box<DuckerState> = Box::new(unsafe { core::mem::zeroed() });
    LinearMatrixDucker::init(&mut state, SR);
    assert_eq!(state.ducker.latency(), 489);
    assert_eq!(abi::native_latency(), 489);
    for (rate, latency) in [(44_100.0, 450), (96_000.0, 969), (192_000.0, 1929)] {
        let mut ducker: Box<Ducker> = Box::new(unsafe { core::mem::zeroed() });
        ducker.init(rate);
        assert_eq!(ducker.latency(), latency);
    }
}

#[test]
fn a_sidechain_ducks_by_its_own_level_whatever_the_carrier() {
    for carrier in [0.1f32, 0.5, 2.0] {
        for (side, gain) in [(0.0f32, 1.0f32), (0.25, 0.75), (0.5, 0.5), (0.9, 0.1), (1.2, 0.0)] {
            let mut ducker = ducker();
            let frames = 4_800;
            let main = vec![carrier; frames];
            let level = vec![side; frames];
            let (out_left, _) = run(&mut ducker, &main, &main, Some((&level, &level)));
            near(out_left[frames - 1] / carrier, gain, 1e-5, "gain");
        }
    }
}

#[test]
fn range_curves() {
    let gain = |level: f32, range: f32| sidechain_gain(floor_sidechain(level, range), range);
    near(gain(0.99, 0.0), 1.0, 1e-6, "range 0 below the threshold");
    assert_eq!(gain(1.0, 0.0), 0.0);
    near(gain(0.7, 0.25), 1.0, 1e-6, "range 25 % ignores quiet levels");
    near(gain(0.8, 0.25), 0.8, 1e-4, "range 25 %");
    near(gain(0.9, 0.5), 0.2, 1e-4, "range 50 %");
    near(gain(0.3, 0.75), 0.9333, 1e-4, "range 75 %");
    near(gain(0.5, 1.0), 0.5, 1e-6, "range 100 %");
    near(gain(0.1, 1.25), 0.8857, 1e-4, "range 125 % linear part");
    near(gain(0.8, 1.25), 0.0914, 1e-4, "range 125 % knee");
    near(gain(0.5, 1.5), 0.3333, 1e-4, "range 150 %");
    near(gain(0.8, 1.5), 0.0533, 1e-4, "range 150 % knee");
    near(gain(0.5, 2.0), 0.25, 1e-6, "range 200 %");
    near(gain(0.9, 2.0), 0.01, 1e-6, "range 200 % knee");
}

#[test]
fn soft_clips_without_a_sidechain() {
    near(soft_clip(0.5, 1.0, 1.0), 0.5, 1e-6, "below the knee");
    near(soft_clip(0.8, 1.0, 1.0), 0.755, 1e-4, "range 100 %");
    near(soft_clip(1.0, 1.0, 1.0), 0.875, 1e-4, "range 100 % at the threshold");
    near(soft_clip(1.2, 1.0, 1.0), 0.955, 1e-4, "range 100 %");
    near(soft_clip(1.5, 1.0, 1.0), 1.0, 1e-6, "range 100 % above the knee");
    near(soft_clip(1.0, 1.0, 0.5), 0.9375, 1e-4, "range 50 %");
    near(soft_clip(0.1, 1.0, 2.0), 0.0975, 1e-4, "range 200 %");
    near(soft_clip(0.5, math::db_to_gain(-6.0), 1.0), 0.4379, 1e-4, "-6 dB");
    near(soft_clip(0.99, 1.0, 0.0), 0.99, 1e-6, "range 0 % below");
    near(soft_clip(4.0, 1.0, 0.0), 1.0, 1e-6, "range 0 % is a hard clip");
}

#[test]
fn never_exceeds_the_threshold_without_a_sidechain() {
    let frames = 24_000;
    let mut noise = Noise(3);
    let signal: Vec<f32> = (0..frames).map(|_| noise.next() * 2.0).collect();
    for attack in [0.0, 2.5, 10.0] {
        for range in [0.0, 1.0, 2.0] {
            for (hold, release) in [(0.0, 0.0), (5.0, 50.0)] {
                let mut ducker = ducker();
                ducker.set_threshold_db(-6.0);
                ducker.set_attack_ms(attack);
                ducker.set_hold_ms(hold);
                ducker.set_release_ms(release);
                ducker.set_range(range);
                let (out_left, _) = run(&mut ducker, &signal, &signal, None);
                let limit = math::db_to_gain(-6.0) + 1e-5;
                assert!(out_left.iter().all(|sample| sample.abs() <= limit), "attack {attack} range {range}");
            }
        }
    }
}

#[test]
fn carrier_plus_sidechain_stay_under_the_threshold() {
    let frames = 48_000;
    let mut noise = Noise(7);
    let threshold = math::db_to_gain(-3.0);
    let carrier: Vec<f32> = (0..frames).map(|_| noise.next() * threshold).collect();
    let side: Vec<f32> = (0..frames).map(|index| noise.next() * libm::expf(-((index % 6000) as f32) / 900.0)).collect();
    for attack in [0.0, 1.0, 5.0, 10.0] {
        for (hold, release) in [(0.0, 0.0), (2.0, 50.0), (0.0, 400.0)] {
            let mut ducker = ducker();
            ducker.set_threshold_db(-3.0);
            ducker.set_attack_ms(attack);
            ducker.set_hold_ms(hold);
            ducker.set_release_ms(release);
            let (out_left, _) = run(&mut ducker, &carrier, &carrier, Some((&side, &side)));
            let latency = ducker.latency();
            for index in latency..frames {
                let sum = out_left[index].abs() + side[index - latency].abs().min(threshold);
                assert!(sum <= threshold + 1e-5, "{sum} at {index} (attack {attack})");
            }
        }
    }
}

#[test]
fn attack_is_a_quadratic_ramp_into_the_sidechain() {
    let mut ducker = ducker();
    ducker.set_release_ms(0.0);
    let step = 10_000;
    let side: Vec<f32> = (0..16_000).map(|index| if index >= step {0.5} else {0.0}).collect();
    let duck = ducking(&mut ducker, &side);
    assert_eq!(duck[step - 241], 0.0);
    near(duck[step - 180], 0.0313, 2e-4, "a quarter in");
    near(duck[step - 120], 0.1251, 2e-4, "halfway");
    near(duck[step - 60], 0.2814, 2e-4, "three quarters in");
    near(duck[step], 0.5, 1e-6, "reached with the step");
}

#[test]
fn attack_ramps_from_the_current_level() {
    let mut released = ducker();
    released.set_release_ms(50.0);
    let mut side = vec![0.2f32; 12_000];
    side[4_000..4_480].fill(0.8);
    let duck = ducking(&mut released, &side);
    near(duck[3_820], 0.2374, 2e-4, "a quarter in");
    near(duck[3_880], 0.3499, 2e-4, "halfway");
    near(duck[3_940], 0.5374, 2e-4, "three quarters in");
    let mut instant = ducker();
    instant.set_release_ms(0.0);
    let duck = ducking(&mut instant, &side);
    near(duck[3_880], 0.2, 1e-6, "without release the ramp starts from silence");
    near(duck[3_940], 0.45, 1e-4, "three quarters of a ramp from silence");
}

#[test]
fn release_halves_the_ducking_every_release_time() {
    let mut ducker = ducker();
    ducker.set_attack_ms(0.0);
    ducker.set_release_ms(50.0);
    let mut side = vec![0.0f32; 24_000];
    side[4_000..8_000].fill(0.5);
    let duck = ducking(&mut ducker, &side);
    for (frames, ratio) in [(600usize, 0.8409f32), (1_200, 0.7071), (2_400, 0.5), (4_800, 0.25)] {
        near(duck[8_000 + frames] / 0.5, ratio, 5e-3, "release");
    }
}

#[test]
fn release_settles_on_the_level_still_ahead() {
    let mut ducker = ducker();
    ducker.set_attack_ms(0.0);
    ducker.set_release_ms(50.0);
    ducker.set_range(0.0);
    let frames = 24_000;
    let signal: Vec<f32> = (0..frames).map(|index| if (4_000..4_480).contains(&index) {2.0} else {0.5}).collect();
    let (out_left, _) = run(&mut ducker, &signal, &signal, None);
    let gain = |index: usize| out_left[index + ducker.latency()] / 0.5;
    near(gain(4_480 + 100), 0.5107, 1e-3, "release towards the level");
    near(gain(4_480 + 1_200), 0.6405, 1e-3, "release towards the level");
    near(gain(4_480 + 2_400), 0.7997, 1e-3, "release towards the level");
}

#[test]
fn hold_keeps_the_peak_for_the_hold_time() {
    let mut ducker = ducker();
    ducker.set_attack_ms(0.0);
    ducker.set_hold_ms(5.0);
    ducker.set_release_ms(0.0);
    let mut side = vec![0.0f32; 16_000];
    side[4_000..8_000].fill(0.5);
    let duck = ducking(&mut ducker, &side);
    near(duck[8_000 + 239], 0.5, 1e-6, "held");
    near(duck[8_000 + 241], 0.0, 1e-6, "released after the hold time");
}

#[test]
fn ducking_never_dips_while_a_louder_peak_is_ahead() {
    let mut ducker = ducker();
    ducker.set_attack_ms(8.0);
    ducker.set_release_ms(30.0);
    let mut side = vec![0.2f32; 12_000];
    side[4_000..4_100].fill(0.6);
    side[4_250..4_260].fill(0.9);
    let duck = ducking(&mut ducker, &side);
    near(duck[4_100], 0.6, 1e-4, "held between the peaks");
    near(duck[4_150], 0.6593, 1e-3, "then ramps into the louder peak");
}

#[test]
fn rms_mode_follows_the_sine_calibrated_power() {
    let mut rms = ducker();
    rms.set_mode(MODE_RMS);
    rms.set_attack_ms(0.0);
    rms.set_release_ms(0.0);
    let mut side = vec![0.0f32; 9_600];
    side[3_000..].fill(0.25);
    let duck = ducking(&mut rms, &side);
    near(duck[3_000], 0.0496, 2e-4, "first frame");
    near(duck[3_048], 0.2791, 1e-3, "after a millisecond");
    near(duck[9_000], 0.3536, 1e-4, "settles at the dc level times the square root of two");
    let frames = 9_600;
    let carrier = vec![1.0f32; frames];
    let left = vec![0.6f32; frames];
    let right = vec![0.0f32; frames];
    let mut linked = ducker();
    linked.set_mode(MODE_RMS);
    let (out_left, out_right) = run(&mut linked, &carrier, &carrier, Some((&left, &right)));
    near(out_left[frames - 1], 0.4, 1e-4, "the channel link averages the power");
    near(out_right[frames - 1], 0.4, 1e-4, "the channel link averages the power");
}

#[test]
fn stereo_blends_the_detected_levels() {
    let frames = 4_800;
    let carrier = vec![1.0f32; frames];
    let left = vec![0.6f32; frames];
    let right = vec![0.2f32; frames];
    for (stereo, expected) in [(0.0f32, 0.4f32), (0.5, 0.6), (1.0, 0.8)] {
        let mut ducker = ducker();
        ducker.set_stereo(stereo);
        let (out_left, out_right) = run(&mut ducker, &carrier, &carrier, Some((&left, &right)));
        near(out_left[frames - 1], 0.4, 1e-5, "the louder channel");
        near(out_right[frames - 1], expected, 1e-5, "the quieter channel");
    }
    let loud = vec![2.0f32; frames];
    let quiet = vec![0.5f32; frames];
    for (stereo, expected) in [(0.0f32, 0.5f32), (0.5, 0.8), (1.0, 1.0)] {
        let mut ducker = ducker();
        ducker.set_range(0.0);
        ducker.set_stereo(stereo);
        let (_, out_right) = run(&mut ducker, &loud, &quiet, None);
        near(out_right[frames - 1] / 0.5, expected, 1e-5, "without a sidechain");
    }
}

#[test]
fn mix_blends_dry_and_ducked() {
    for (mix, expected) in [(0.0f32, 1.0f32), (0.25, 0.875), (0.5, 0.75), (1.0, 0.5)] {
        let mut ducker = ducker();
        ducker.set_mix(mix);
        let side = vec![0.5f32; 4_800];
        let duck = ducking(&mut ducker, &side);
        near(1.0 - duck[4_000], expected, 1e-5, "mix");
    }
}

#[test]
fn the_dry_path_is_latency_aligned() {
    let frames = 6_000;
    let mut noise = Noise(11);
    let signal: Vec<f32> = (0..frames).map(|_| noise.next()).collect();
    let mut dry = ducker();
    dry.set_threshold_db(-12.0);
    dry.set_mix(0.0);
    let (out_dry, _) = run(&mut dry, &signal, &signal, None);
    let latency = dry.latency();
    for index in latency..frames {
        assert_eq!(out_dry[index], signal[index - latency], "mix 0 is the delayed input");
    }
}

#[test]
fn isp_mode_catches_peaks_between_samples() {
    // A quarter-rate sine at 45 degrees: every sample is at 0.354, the waveform peaks at 0.5 between them.
    let side: Vec<f32> = (0..9_600)
        .map(|index| 0.5 * libm::sinf(core::f32::consts::FRAC_PI_2 * (index % 4) as f32 + core::f32::consts::FRAC_PI_4))
        .collect();
    let gain_of = |mode: i32| {
        let mut ducker = ducker();
        ducker.set_mode(mode);
        ducker.set_attack_ms(0.0);
        ducker.set_release_ms(0.0);
        1.0 - ducking(&mut ducker, &side)[6_000]
    };
    near(gain_of(MODE_PEAK), 0.6464, 1e-3, "sample peaks");
    near(gain_of(MODE_ISP), 0.5, 0.01, "true peaks");
}

#[test]
fn changing_attack_while_running_keeps_the_ceiling() {
    let frames = 24_000;
    let mut noise = Noise(5);
    let signal: Vec<f32> = (0..frames).map(|_| noise.next() * 2.0).collect();
    let mut ducker = ducker();
    ducker.set_threshold_db(-6.0);
    ducker.set_range(0.0);
    let mut out = vec![0.0f32; frames];
    let mut scratch = vec![0.0f32; frames];
    for (block, from) in (0..frames).step_by(128).enumerate() {
        ducker.set_attack_ms((block % 11) as f32);
        ducker.process(&signal, &signal, None, &mut out, &mut scratch, from, (from + 128).min(frames));
    }
    let limit = math::db_to_gain(-6.0) + 1e-5;
    assert!(out.iter().all(|sample| sample.abs() <= limit));
}

#[test]
fn publishes_display_entries() {
    let mut ducker = ducker();
    let signal = vec![0.5f32; 2_400];
    run(&mut ducker, &signal, &signal, None);
    assert_eq!(ducker.display_written, 10);
    assert_eq!(ducker.display[9], [0.5, 0.5, 0.5, 1.0]);
}

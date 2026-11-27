use super::*;
use ducker::{shape_sidechain, target_gain, MODE_ISP, MODE_PEAK, MODE_RMS};

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

#[test]
fn reports_ten_milliseconds_plus_the_isp_filter_delay_as_latency() {
    let mut state: Box<DuckerState> = Box::new(unsafe { core::mem::zeroed() });
    LinearMatrixDucker::init(&mut state, SR);
    assert_eq!(state.ducker.latency(), 480 + ducker::ISP_DELAY);
    assert_eq!(abi::native_latency(), 486);
}

#[test]
fn carrier_plus_sidechain_never_exceeds_the_threshold_in_peak_mode() {
    let frames = 48_000;
    let mut noise = Noise(7);
    let carrier_left: Vec<f32> = (0..frames).map(|_| noise.next() * 1.5).collect();
    let carrier_right: Vec<f32> = (0..frames).map(|_| noise.next() * 0.7).collect();
    // A pumping sidechain: noise bursts with a decaying envelope, peaks stay at or below the threshold.
    let threshold = math::db_to_gain(-3.0);
    let side_left: Vec<f32> = (0..frames).map(|index| {
        let envelope = libm::expf(-((index % 6000) as f32) / 900.0);
        noise.next() * envelope * threshold
    }).collect();
    let side_right: Vec<f32> = side_left.iter().map(|value| value * 0.5).collect();
    for attack in [0.0, 1.0, 5.0, 10.0] {
        for (hold, release) in [(0.0, 1.0), (20.0, 50.0), (0.0, 400.0)] {
            for stereo in [0.0, 0.5, 1.0] {
                let mut ducker = ducker();
                ducker.set_threshold_db(-3.0);
                ducker.set_attack_ms(attack);
                ducker.set_hold_ms(hold);
                ducker.set_release_ms(release);
                ducker.set_stereo(stereo);
                ducker.set_mode(MODE_PEAK);
                let (out_left, out_right) = run(&mut ducker, &carrier_left, &carrier_right,
                    Some((&side_left, &side_right)));
                let latency = ducker.latency();
                for index in latency..frames {
                    let source = index - latency;
                    let left = out_left[index].abs() + side_left[source].abs();
                    let right = out_right[index].abs() + side_right[source].abs();
                    assert!(left <= threshold + 1e-5, "left {left} at {index} (attack {attack}, stereo {stereo})");
                    assert!(right <= threshold + 1e-5, "right {right} at {index} (attack {attack}, stereo {stereo})");
                }
            }
        }
    }
}

#[test]
fn limits_to_the_threshold_without_a_sidechain() {
    let frames = 24_000;
    let mut noise = Noise(3);
    let signal: Vec<f32> = (0..frames).map(|_| noise.next() * 2.0).collect();
    for attack in [0.0, 2.5, 10.0] {
        let mut ducker = ducker();
        ducker.set_threshold_db(-6.0);
        ducker.set_attack_ms(attack);
        let (out_left, _) = run(&mut ducker, &signal, &signal, None);
        let limit = math::db_to_gain(-6.0) + 1e-5;
        assert!(out_left.iter().all(|sample| sample.abs() <= limit), "attack {attack}");
    }
}

#[test]
fn zero_attack_acts_as_a_sample_accurate_clipper() {
    let mut ducker = ducker();
    ducker.set_threshold_db(-6.0);
    ducker.set_attack_ms(0.0);
    ducker.set_release_ms(1.0);
    let threshold = math::db_to_gain(-6.0);
    let frames = 4_000;
    let signal: Vec<f32> = (0..frames).map(|index| if index == 2_000 {1.0} else {0.1}).collect();
    let (out_left, _) = run(&mut ducker, &signal, &signal, None);
    let peak = 2_000 + ducker.latency();
    assert!((out_left[peak] - threshold).abs() < 1e-5, "the peak is clamped to the threshold");
    assert!((out_left[peak - 1] - 0.1).abs() < 1e-6, "the sample before the peak is untouched");
}

#[test]
fn attack_ramps_the_gain_down_over_the_lookahead_window() {
    let mut ducker = ducker();
    ducker.set_threshold_db(-6.0);
    ducker.set_attack_ms(5.0);
    let frames = 4_000;
    let signal: Vec<f32> = (0..frames).map(|index| if index >= 2_000 {1.0} else {0.25}).collect();
    let (out_left, _) = run(&mut ducker, &signal, &signal, None);
    let step = 2_000 + ducker.latency();
    let attack = 240;
    assert!((out_left[step - attack - 2] - 0.25).abs() < 1e-6, "untouched before the lookahead window");
    let ramp = &out_left[step - attack..step];
    assert!(ramp.windows(2).all(|pair| pair[1] <= pair[0] + 1e-7), "the gain falls monotonically");
    assert!(ramp[attack / 2] < 0.25 && ramp[attack / 2] > 0.125, "halfway down in the middle of the window");
    assert!((out_left[step] - math::db_to_gain(-6.0)).abs() < 1e-5, "reaches the threshold with the step");
}

#[test]
fn holds_the_reduction_then_releases_exponentially() {
    let mut ducker = ducker();
    ducker.set_threshold_db(0.0);
    ducker.set_attack_ms(0.0);
    ducker.set_hold_ms(10.0);
    ducker.set_release_ms(20.0);
    let frames = 12_000;
    let drop = 4_000;
    let carrier = vec![0.5f32; frames];
    let side: Vec<f32> = (0..frames).map(|index| if index < drop {0.8} else {0.0}).collect();
    let (out_left, _) = run(&mut ducker, &carrier, &carrier, Some((&side, &side)));
    let latency = ducker.latency();
    let ducked = 0.2 / 0.5;
    let hold = 480;
    let release = 960.0;
    let gain = |index: usize| out_left[index + latency] / 0.5;
    assert!((gain(drop - 1) - ducked).abs() < 1e-5, "ducked while the sidechain is loud");
    assert!((gain(drop + hold - 1) - ducked).abs() < 1e-5, "held for the hold time");
    for steps in [1usize, 480, 960, 2880] {
        let expected = 1.0 - (1.0 - ducked) * libm::expf(-(steps as f32) / release);
        assert!((gain(drop + hold - 1 + steps) - expected).abs() < 1e-3, "release after {steps} steps");
    }
}

#[test]
fn the_dry_path_and_the_wet_path_are_latency_aligned() {
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
    let mut wet = ducker();
    wet.set_threshold_db(-12.0);
    let (out_wet, _) = run(&mut wet, &signal, &signal, None);
    let mut half = ducker();
    half.set_threshold_db(-12.0);
    half.set_mix(0.5);
    let (out_half, _) = run(&mut half, &signal, &signal, None);
    for index in latency..frames {
        assert!((out_half[index] - 0.5 * (out_dry[index] + out_wet[index])).abs() < 1e-6);
    }
}

#[test]
fn isp_mode_catches_peaks_between_samples() {
    let frames = 8_000;
    // A quarter-rate sine at 45 degrees: every sample is at 0.707, the waveform peaks at 1.0 between them.
    let signal: Vec<f32> = (0..frames)
        .map(|index| libm::sinf(core::f32::consts::FRAC_PI_2 * (index % 4) as f32 + core::f32::consts::FRAC_PI_4))
        .collect();
    let peak_of = |mode: i32| {
        let mut ducker = ducker();
        ducker.set_threshold_db(-1.0);
        ducker.set_mode(mode);
        let (out_left, _) = run(&mut ducker, &signal, &signal, None);
        out_left[4_000..].iter().fold(0.0f32, |max, sample| max.max(sample.abs()))
    };
    let threshold = math::db_to_gain(-1.0);
    assert!((peak_of(MODE_PEAK) - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-4, "sample peaks pass untouched");
    let isp = peak_of(MODE_ISP);
    assert!(isp < threshold * core::f32::consts::FRAC_1_SQRT_2 * 1.03, "the true peak is held at the threshold: {isp}");
    assert!(isp > threshold * core::f32::consts::FRAC_1_SQRT_2 * 0.9, "but not much below it: {isp}");
}

#[test]
fn rms_mode_reacts_to_the_average_level() {
    let frames = 8_000;
    let signal: Vec<f32> = (0..frames).map(|index| libm::sinf(index as f32 * 0.05)).collect();
    let peak_of = |mode: i32| {
        let mut ducker = ducker();
        ducker.set_threshold_db(-2.0);
        ducker.set_mode(mode);
        let (out_left, _) = run(&mut ducker, &signal, &signal, None);
        out_left[4_000..].iter().fold(0.0f32, |max, sample| max.max(sample.abs()))
    };
    assert!(peak_of(MODE_PEAK) <= math::db_to_gain(-2.0) + 1e-5, "peak mode clamps the peaks");
    assert!(peak_of(MODE_RMS) > 0.99, "a sine with an rms of -3 dB passes a -2 dB threshold in rms mode");
}

#[test]
fn range_shapes_the_sidechain() {
    assert_eq!(shape_sidechain(0.7, 1.0), 0.7);
    assert_eq!(shape_sidechain(0.7, 0.0), 0.0);
    assert_eq!(shape_sidechain(0.4, 0.5), 0.0);
    assert!((shape_sidechain(0.75, 0.5) - 0.5).abs() < 1e-6);
    assert!(shape_sidechain(0.2, 2.0) > 0.2);
    assert_eq!(shape_sidechain(1.0, 2.0), 1.0);
    assert_eq!(shape_sidechain(3.0, 1.0), 1.0);
    assert_eq!(target_gain(0.5, 0.0, 1.0, 1.0), 1.0);
    assert!((target_gain(1.0, 0.25, 1.0, 1.0) - 0.75).abs() < 1e-6);
    assert_eq!(target_gain(1.0, 1.0, 1.0, 1.0), 0.0);
}

#[test]
fn stereo_controls_the_channel_link() {
    let frames = 4_000;
    let loud = vec![1.0f32; frames];
    let quiet = vec![0.25f32; frames];
    let right_of = |stereo: f32| {
        let mut ducker = ducker();
        ducker.set_threshold_db(-6.0);
        ducker.set_stereo(stereo);
        let (_, out_right) = run(&mut ducker, &loud, &quiet, None);
        out_right[frames - 1]
    };
    assert!((right_of(0.0) - 0.25 * math::db_to_gain(-6.0)).abs() < 1e-5, "linked: the right follows the left");
    assert!((right_of(1.0) - 0.25).abs() < 1e-6, "independent: the right stays untouched");
}

#[test]
fn changing_attack_while_running_keeps_the_ceiling() {
    let frames = 24_000;
    let mut noise = Noise(5);
    let signal: Vec<f32> = (0..frames).map(|_| noise.next() * 2.0).collect();
    let mut ducker = ducker();
    ducker.set_threshold_db(-6.0);
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
    assert_eq!(ducker.display[9], [0.5, 0.5, 0.0, 1.0]);
}

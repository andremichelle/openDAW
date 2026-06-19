//! The one-pole low-pass effect core (driven by the device ABI's `AudioEffect`): it strongly attenuates
//! a Nyquist-rate (alternating) signal and, fed a constant, settles toward that level.

use abi::AudioEffect;
use device_lowpass::{Lowpass, LowpassState};

const SR: f32 = 48_000.0;
const BPM: f32 = 120.0;
// One LFO cycle per half-note = 1920 pulses. Peak (sin=+1) at 1/4 cycle -> pulse 480; trough at pulse 1440.
const LFO_PEAK_PULSE: f64 = 480.0;
const LFO_TROUGH_PULSE: f64 = 1440.0;

fn empty_state() -> LowpassState {
    // The engine hands the device a zeroed state block; mirror that.
    unsafe { core::mem::zeroed() }
}

fn energy(samples: &[f32]) -> f32 {
    samples.iter().map(|sample| sample * sample).sum()
}

#[test]
fn attenuates_nyquist() {
    let mut state = empty_state();
    let input: Vec<f32> = (0..128).map(|index| if index % 2 == 0 { 1.0 } else { -1.0 }).collect();
    let mut output = [0.0f32; 128];
    Lowpass::process_audio(&mut state, &input, &mut output, SR, BPM, 0.0);
    assert!(energy(&output) < energy(&input) * 0.1, "the highest frequency is strongly attenuated");
}

#[test]
fn settles_toward_dc() {
    let mut state = empty_state();
    let input = [1.0f32; 512];
    let mut output = [0.0f32; 512];
    Lowpass::process_audio(&mut state, &input, &mut output, SR, BPM, 0.0);
    assert!(output[511] > 0.9, "a constant input settles toward its level");
    assert!(output[0] < output[511], "and approaches it gradually, not instantly");
}

#[test]
fn cutoff_tracks_the_sample_rate() {
    // Same cutoff frequency, higher sample rate -> smaller per-sample coefficient -> slower settling.
    let input = [1.0f32; 64];
    let mut at_48 = [0.0f32; 64];
    let mut at_96 = [0.0f32; 64];
    Lowpass::process_audio(&mut empty_state(), &input, &mut at_48, 48_000.0, BPM, 0.0);
    Lowpass::process_audio(&mut empty_state(), &input, &mut at_96, 96_000.0, BPM, 0.0);
    assert!(at_96[63] < at_48[63], "a higher sample rate settles slower for the same cutoff");
}

#[test]
fn the_lfo_is_locked_to_song_position() {
    // The cutoff is a function of the musical position: starting at the LFO peak position passes far more of
    // a Nyquist tone than starting at the trough position.
    let input: Vec<f32> = (0..2048).map(|index| if index % 2 == 0 { 1.0 } else { -1.0 }).collect();
    let mut at_peak = vec![0.0f32; 2048];
    let mut at_trough = vec![0.0f32; 2048];
    Lowpass::process_audio(&mut empty_state(), &input, &mut at_peak, SR, BPM, LFO_PEAK_PULSE);
    Lowpass::process_audio(&mut empty_state(), &input, &mut at_trough, SR, BPM, LFO_TROUGH_PULSE);
    assert!(energy(&at_peak) > energy(&at_trough) * 2.0, "cutoff is high at the LFO peak, low at the trough");
}

#[test]
fn the_lfo_rate_follows_the_bpm() {
    // Starting at the LFO peak, a faster tempo sweeps the cutoff down toward the trough sooner, so the same
    // Nyquist tone passes less overall at the higher tempo.
    let input: Vec<f32> = (0..8192).map(|index| if index % 2 == 0 { 1.0 } else { -1.0 }).collect();
    let mut slow = vec![0.0f32; 8192];
    let mut fast = vec![0.0f32; 8192];
    Lowpass::process_audio(&mut empty_state(), &input, &mut slow, SR, 60.0, LFO_PEAK_PULSE);
    Lowpass::process_audio(&mut empty_state(), &input, &mut fast, SR, 480.0, LFO_PEAK_PULSE);
    assert!(energy(&slow) > energy(&fast), "a faster tempo sweeps the cutoff faster");
}

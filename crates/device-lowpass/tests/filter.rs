//! The one-pole low-pass effect core (driven by the device ABI's `AudioEffect`): it strongly attenuates
//! a Nyquist-rate (alternating) signal and, fed a constant, settles toward that level.

use abi::AudioEffect;
use device_lowpass::{Lowpass, LowpassState};

const SR: f32 = 48_000.0;

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
    Lowpass::process_audio(&mut state, &input, &mut output, SR);
    assert!(energy(&output) < energy(&input) * 0.1, "the highest frequency is strongly attenuated");
}

#[test]
fn settles_toward_dc() {
    let mut state = empty_state();
    let input = [1.0f32; 512];
    let mut output = [0.0f32; 512];
    Lowpass::process_audio(&mut state, &input, &mut output, SR);
    assert!(output[511] > 0.9, "a constant input settles toward its level");
    assert!(output[0] < output[511], "and approaches it gradually, not instantly");
}

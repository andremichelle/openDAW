//! An AUDIO-EFFECT device with one AUTOMATED parameter (Route D), wired AFTER an instrument (instrument
//! output -> this effect's input -> the bus). It reads its one input buffer and writes its one output buffer
//! through a one-pole low-pass whose cutoff is a real parameter, driven by automation: on each global clock
//! event the SDK calls `automate`, which PULLS the cutoff's unit value (0..1) at that position and maps it
//! to a frequency. The coefficient is derived from that frequency and the SAMPLE RATE, so it behaves the
//! same at any rate. Proves the host's `PluginAudioEffect` bridge AND the clock-driven parameter pull: the
//! device sees its block split at every clock event, refreshes the cutoff, and renders the chunk between.
//!
//! The cutoff parameter is named by its field-key PATH on the box: `RevampDeviceBox.lowPass` (key 16) ->
//! `frequency` (key 10), i.e. `[16, 10]` — the stable schema keys, passed as-is to the host (no encoding).
//! The plugin maps the 0..1 unit value EXPONENTIALLY to 80..1120 Hz (equal steps = equal frequency ratios,
//! the musically correct curve for a cutoff).
//!
//! Exports: `kind()` (effect), `state_size()`, `process(desc_ptr)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::Ports;
use math::{exp_lerp, TAU};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const MAX_COEFF: f32 = 0.99; // clamp the one-pole coefficient below 1 for stability
// The cutoff parameter's field-key PATH on the box: RevampDeviceBox.lowPass (16) -> frequency (10). The
// stable schema keys, passed to the host as-is — not an encoding of how the host stores them.
const CUTOFF_FIELD: [u16; 2] = [16, 10];
const CUTOFF_MIN_HZ: f32 = 80.0;
const CUTOFF_MAX_HZ: f32 = 1120.0;

/// The effect's per-instance state, interpreted from the engine-allocated (zeroed) block: the filter's last
/// output sample (`z1`) and the current cutoff in Hz, both carried across quanta. `cutoff_hz` is refreshed
/// by `automate` on each clock event (the first tick at a transport start sets it before any audio).
pub struct LowpassState {
    z1: f32,
    cutoff_hz: f32
}

/// Map a parameter's unit value (0..1) to the cutoff frequency in Hz, exponentially over 80..1120 Hz. The
/// mapping is the plugin's; the automation curve carries only the 0..1 unit value.
fn cutoff_hz(unit: f32) -> f32 {
    exp_lerp(CUTOFF_MIN_HZ, CUTOFF_MAX_HZ, unit)
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Lowpass;

impl abi::AudioEffect for Lowpass {
    type State = LowpassState;

    fn process_audio(state: &mut LowpassState, input: &[f32], output: &mut [f32], sample_rate: f32, _bpm: f32, _position: f64) {
        // One-pole low-pass `y += a*(x - y)`, coefficient from the cutoff and the SAMPLE RATE
        // (`a = 2*PI*fc/fs`). The cutoff is the automated parameter `automate` set (held across the chunk).
        let coeff = (TAU * state.cutoff_hz / sample_rate).min(MAX_COEFF);
        let mut z1 = state.z1;
        for (sample, target) in input.iter().zip(output.iter_mut()) {
            z1 += coeff * (*sample - z1);
            *target = z1;
        }
        state.z1 = z1;
    }

    fn automate(state: &mut LowpassState, position: f64) {
        // Pull the cutoff's unit value (0..1) at this clock position and map it to a frequency. The mapping
        // is the plugin's: the curve carries only 0..1.
        let path = CUTOFF_FIELD; // a stack copy, so the host reads a stable address during the call
        let unit = abi::pull_automation(&path, position);
        state.cutoff_hz = cutoff_hz(unit);
    }
}

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block. The state is two floats, so the
/// size does not depend on `sample_rate`; the parameter keeps the ABI uniform with devices whose state IS
/// rate-sized.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<LowpassState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<LowpassState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Lowpass>(ports);
}

#[cfg(test)]
mod tests {
    //! The one-pole low-pass core (driven via the ABI's `AudioEffect`): it strongly attenuates a
    //! Nyquist-rate signal, settles toward a constant, and its cutoff is the automated PARAMETER (an
    //! exponential 0..1 -> Hz map), not an internal LFO. In-crate so it can set the private `cutoff_hz`.
    use super::{cutoff_hz, Lowpass, LowpassState, CUTOFF_MAX_HZ, CUTOFF_MIN_HZ};
    use abi::AudioEffect;

    const SR: f32 = 48_000.0;
    const BPM: f32 = 120.0;

    fn state_with(hz: f32) -> LowpassState {
        LowpassState {z1: 0.0, cutoff_hz: hz}
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample * sample).sum()
    }

    #[test]
    fn unit_value_maps_exponentially_over_the_cutoff_range() {
        assert!((cutoff_hz(0.0) - CUTOFF_MIN_HZ).abs() < 1.0e-3, "0 -> min");
        assert!((cutoff_hz(1.0) - CUTOFF_MAX_HZ).abs() < 1.0e-2, "1 -> max");
        // Exponential: the midpoint is the GEOMETRIC mean, below the arithmetic midpoint (600).
        let geometric_mean = (CUTOFF_MIN_HZ * CUTOFF_MAX_HZ).sqrt();
        assert!((cutoff_hz(0.5) - geometric_mean).abs() < 0.5, "0.5 -> geometric mean");
        assert!(cutoff_hz(0.5) < (CUTOFF_MIN_HZ + CUTOFF_MAX_HZ) / 2.0, "the exponential midpoint sits below the linear one");
    }

    #[test]
    fn attenuates_nyquist() {
        let input: Vec<f32> = (0..128).map(|index| if index % 2 == 0 {1.0} else {-1.0}).collect();
        let mut output = [0.0f32; 128];
        Lowpass::process_audio(&mut state_with(cutoff_hz(0.5)), &input, &mut output, SR, BPM, 0.0);
        assert!(energy(&output) < energy(&input) * 0.1, "the highest frequency is strongly attenuated");
    }

    #[test]
    fn settles_toward_dc() {
        let input = [1.0f32; 512];
        let mut output = [0.0f32; 512];
        Lowpass::process_audio(&mut state_with(cutoff_hz(0.5)), &input, &mut output, SR, BPM, 0.0);
        assert!(output[511] > 0.9, "a constant input settles toward its level");
        assert!(output[0] < output[511], "and approaches it gradually, not instantly");
    }

    #[test]
    fn cutoff_tracks_the_sample_rate() {
        // Same cutoff frequency, higher sample rate -> smaller per-sample coefficient -> slower settling.
        let input = [1.0f32; 64];
        let mut at_48 = [0.0f32; 64];
        let mut at_96 = [0.0f32; 64];
        Lowpass::process_audio(&mut state_with(300.0), &input, &mut at_48, 48_000.0, BPM, 0.0);
        Lowpass::process_audio(&mut state_with(300.0), &input, &mut at_96, 96_000.0, BPM, 0.0);
        assert!(at_96[63] < at_48[63], "a higher sample rate settles slower for the same cutoff");
    }

    #[test]
    fn cutoff_parameter_drives_the_filter() {
        // A higher cutoff passes far more of a Nyquist tone than a lower one; the parameter sets it.
        let input: Vec<f32> = (0..2048).map(|index| if index % 2 == 0 {1.0} else {-1.0}).collect();
        let mut high = vec![0.0f32; 2048];
        let mut low = vec![0.0f32; 2048];
        Lowpass::process_audio(&mut state_with(cutoff_hz(1.0)), &input, &mut high, SR, BPM, 0.0);
        Lowpass::process_audio(&mut state_with(cutoff_hz(0.0)), &input, &mut low, SR, BPM, 0.0);
        assert!(energy(&high) > energy(&low) * 2.0, "a higher cutoff passes more of the Nyquist tone");
    }

    #[test]
    fn automate_pulls_and_maps_the_cutoff() {
        // The native `pull_automation` stub returns 0.5; `automate` maps it through `cutoff_hz`.
        let mut state = state_with(0.0);
        Lowpass::automate(&mut state, 0.0);
        assert_eq!(state.cutoff_hz, cutoff_hz(0.5));
    }
}

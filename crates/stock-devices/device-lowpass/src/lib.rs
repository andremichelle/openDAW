//! An AUDIO-EFFECT device with TWO automated parameters (Route D, push model), wired AFTER an instrument
//! (instrument output -> this effect's input -> the bus). It runs its input through a biquad low-pass
//! (`dsp::biquad`) whose cutoff and resonance are real parameters: `init` binds them with the host and gets
//! back an id each; the engine pushes a value through `parameter_changed` for the initial (box-field)
//! value, on edits, and on automation (the global clock). The plugin maps each 0..1 unit value to its range
//! and recomputes the biquad coefficients.
//!
//! The parameters are named by their field-key PATH on the box (the stable schema keys, no encoding):
//! cutoff = `RevampDeviceBox.lowPass.frequency` = `[16, 10]`, resonance = `lowPass.q` = `[16, 12]`. Cutoff
//! maps exponentially to 80..1120 Hz, resonance exponentially to a Q of 0.707 (Butterworth) .. 12.
//!
//! Exports: `kind()` (effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr)`,
//! `parameter_changed(state_ptr, id, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{AudioEffect, Ports};
use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor};
use math::exp_lerp;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The parameter field-key PATHs on the box (stable schema keys, passed to the host as-is). RevampDeviceBox
// .lowPass is field 16; within a RevampPass, frequency is 10 and q is 12.
const CUTOFF_FIELD: [u16; 2] = [16, 10];
const RESONANCE_FIELD: [u16; 2] = [16, 12];
const CUTOFF_MIN_HZ: f32 = 80.0;
const CUTOFF_MAX_HZ: f32 = 1120.0;
const Q_MIN: f32 = core::f32::consts::FRAC_1_SQRT_2; // 0.707, Butterworth (the un-resonant default)
const Q_MAX: f32 = 12.0;

/// Map the cutoff's unit value (0..1) to a frequency in Hz, exponentially (equal steps = equal ratios).
fn cutoff_hz(unit: f32) -> f32 {
    exp_lerp(CUTOFF_MIN_HZ, CUTOFF_MAX_HZ, unit)
}

/// Map the resonance's unit value (0..1) to a biquad Q, exponentially from Butterworth up to a sharp peak.
fn resonance_q(unit: f32) -> f32 {
    exp_lerp(Q_MIN, Q_MAX, unit)
}

/// The effect's per-instance state, interpreted from the engine-allocated (zeroed) block: the biquad's
/// second-order section state + its coefficients, the current cutoff (Hz) and resonance (Q) the host pushed,
/// a `dirty` flag set when either changed (so the coefficients are recomputed on the next chunk), and the
/// parameter ids `bind_parameter` returned. Valid when zeroed (silent until the engine pushes the defaults).
pub struct LowpassState {
    biquad: BiquadMono,
    coeff: BiquadCoeff,
    cutoff_hz: f32,
    resonance_q: f32,
    dirty: bool,
    cutoff_id: u32,
    resonance_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Lowpass;

impl AudioEffect for Lowpass {
    type State = LowpassState;

    fn init(state: &mut LowpassState) {
        state.cutoff_id = abi::bind_parameter(&CUTOFF_FIELD);
        state.resonance_id = abi::bind_parameter(&RESONANCE_FIELD);
    }

    fn parameter_changed(state: &mut LowpassState, id: u32, value: f32) {
        // Map the 0..1 unit value to this parameter's range and mark the coefficients stale. The mapping is
        // the plugin's; the host only ever hands over the unit value.
        if id == state.cutoff_id {
            state.cutoff_hz = cutoff_hz(value);
        } else if id == state.resonance_id {
            state.resonance_q = resonance_q(value);
        }
        state.dirty = true;
    }

    fn process_audio(state: &mut LowpassState, input: &[f32], output: &mut [f32], sample_rate: f32, _bpm: f32, _position: f64) {
        // Recompute the coefficients only when a parameter changed. The biquad's cutoff is a NORMALISED
        // frequency (Hz / sample_rate), so the filter behaves the same at any rate.
        if state.dirty {
            let normalized = (state.cutoff_hz / sample_rate) as f64;
            state.coeff.set_lowpass_params(normalized, state.resonance_q as f64);
            state.dirty = false;
        }
        state.biquad.process(&state.coeff, input, output, 0, input.len());
    }
}

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<LowpassState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<LowpassState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Lowpass>(ports);
}

/// Bind this device's parameters with the host (it records their field-paths and returns an id each).
#[no_mangle]
pub extern "C" fn init(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Lowpass as AudioEffect>::init) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Lowpass as AudioEffect>::parameter_changed(state, id, value)) }
}

#[cfg(test)]
mod tests {
    //! The biquad low-pass core (driven via the ABI's `AudioEffect`): its cutoff + resonance are automated
    //! PARAMETERS the engine pushes through `parameter_changed`, mapped to Hz / Q here. In-crate so it can
    //! reach the private state.
    use super::{cutoff_hz, resonance_q, Lowpass, LowpassState, CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, Q_MAX, Q_MIN};
    use abi::AudioEffect;

    const SR: f32 = 48_000.0;

    fn empty_state() -> LowpassState {
        unsafe { core::mem::zeroed() }
    }

    fn state_at(cutoff_unit: f32, resonance_unit: f32) -> LowpassState {
        let mut state = empty_state();
        state.cutoff_hz = cutoff_hz(cutoff_unit);
        state.resonance_q = resonance_q(resonance_unit);
        state.dirty = true;
        state
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample * sample).sum()
    }

    fn nyquist(len: usize) -> Vec<f32> {
        (0..len).map(|index| if index % 2 == 0 {1.0} else {-1.0}).collect()
    }

    #[test]
    fn unit_values_map_exponentially_over_their_ranges() {
        assert!((cutoff_hz(0.0) - CUTOFF_MIN_HZ).abs() < 1.0e-3);
        assert!((cutoff_hz(1.0) - CUTOFF_MAX_HZ).abs() < 1.0e-2);
        assert!(cutoff_hz(0.5) < (CUTOFF_MIN_HZ + CUTOFF_MAX_HZ) / 2.0, "exponential midpoint sits below linear");
        assert!((resonance_q(0.0) - Q_MIN).abs() < 1.0e-3, "resonance starts at the Butterworth Q");
        assert!((resonance_q(1.0) - Q_MAX).abs() < 1.0e-2);
    }

    #[test]
    fn attenuates_nyquist_at_a_low_cutoff() {
        let input = nyquist(512);
        let mut output = vec![0.0f32; 512];
        Lowpass::process_audio(&mut state_at(0.5, 0.0), &input, &mut output, SR, 120.0, 0.0);
        assert!(energy(&output) < energy(&input) * 0.05, "the Nyquist tone is strongly attenuated");
    }

    #[test]
    fn cutoff_parameter_drives_the_filter() {
        let input = nyquist(2048);
        let mut high = vec![0.0f32; 2048];
        let mut low = vec![0.0f32; 2048];
        Lowpass::process_audio(&mut state_at(1.0, 0.0), &input, &mut high, SR, 120.0, 0.0);
        Lowpass::process_audio(&mut state_at(0.0, 0.0), &input, &mut low, SR, 120.0, 0.0);
        assert!(energy(&high) > energy(&low) * 2.0, "a higher cutoff passes more of the Nyquist tone");
    }

    #[test]
    fn parameter_changed_routes_by_id_and_marks_dirty() {
        let mut state = empty_state();
        // Mirror what `init` does natively (the bind stub returns 0, so assign distinct ids by hand here).
        state.cutoff_id = 0;
        state.resonance_id = 1;
        Lowpass::parameter_changed(&mut state, 0, 1.0);
        assert_eq!(state.cutoff_hz, cutoff_hz(1.0), "id 0 sets the cutoff");
        Lowpass::parameter_changed(&mut state, 1, 1.0);
        assert_eq!(state.resonance_q, resonance_q(1.0), "id 1 sets the resonance");
        assert!(state.dirty, "a parameter change marks the coefficients stale");
    }
}

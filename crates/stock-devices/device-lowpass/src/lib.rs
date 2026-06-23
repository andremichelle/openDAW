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
use abi::{AudioEffect, Block, ParamValue, Ports};
use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor};
use math::value_mapping::{Exponential, ValueMapping};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The parameter field-key PATHs on the box (stable schema keys, passed to the host as-is). RevampDeviceBox
// .lowPass is field 16; within a RevampPass, frequency is 10 and q is 12.
const CUTOFF_FIELD: [u16; 2] = [16, 10];
const RESONANCE_FIELD: [u16; 2] = [16, 12];
// This device's value mappings (uniform 0..1 -> the parameter's real value). The host is mapping-agnostic;
// the device owns these. Cutoff is exponential 80..1120 Hz; resonance is exponential over the Q range from
// Butterworth (0.707) up to a sharp peak. Swapping in a custom mapping is a local change here.
const CUTOFF_MAPPING: Exponential = Exponential {min: 80.0, max: 1120.0};
const RESONANCE_MAPPING: Exponential = Exponential {min: core::f32::consts::FRAC_1_SQRT_2, max: 12.0};

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
    resonance_id: u32,
    sample_rate: f32 // the device's own rate, stashed from `Ports::sample_rate` each `process`
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Lowpass;

impl AudioEffect for Lowpass {
    type State = LowpassState;

    fn init(state: &mut LowpassState) {
        state.cutoff_id = abi::bind_parameter(&CUTOFF_FIELD);
        state.resonance_id = abi::bind_parameter(&RESONANCE_FIELD);
    }

    fn parameter_changed(state: &mut LowpassState, id: u32, value: ParamValue) {
        // `Unit` => the uniform 0..1 automation value, mapped through this device's mapping; `Float` => the box
        // field's already-real value (Hz / Q), used directly. Both are f32 parameters, so anything else is a
        // contract error. Either way mark the coefficients stale.
        if id == state.cutoff_id {
            state.cutoff_hz = match value {
                ParamValue::Unit(unit) => CUTOFF_MAPPING.y(unit),
                ParamValue::Float(hz) => hz,
                _ => panic!("lowpass cutoff expects a unit or float value")
            };
        } else if id == state.resonance_id {
            state.resonance_q = match value {
                ParamValue::Unit(unit) => RESONANCE_MAPPING.y(unit),
                ParamValue::Float(q) => q,
                _ => panic!("lowpass resonance expects a unit or float value")
            };
        }
        state.dirty = true;
    }

    fn process_audio(state: &mut LowpassState, input: &[f32], output: &mut [f32], _block: &Block) {
        // Recompute the coefficients only when a parameter changed. The biquad's cutoff is a NORMALISED
        // frequency (Hz / sample_rate), so the filter behaves the same at any rate. This filter is driven by
        // automated parameters, so it ignores the block's tempo / position.
        if state.dirty {
            let normalized = (state.cutoff_hz / state.sample_rate) as f64;
            state.coeff.set_lowpass_params(normalized, state.resonance_q as f64);
            state.dirty = false;
        }
        state.biquad.process(&state.coeff, input, output, 0, input.len());
    }
}

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<LowpassState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<LowpassState>::from_descriptor(desc_ptr) };
    ports.state.sample_rate = ports.sample_rate; // stash the device's rate before the SDK dispatches
    abi::render_effect::<Lowpass>(ports);
}

/// Bind this device's parameters with the host (it records their field-paths and returns an id each).
#[no_mangle]
pub extern "C" fn init(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Lowpass as AudioEffect>::init) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back. The
/// `kind` tag tells the SDK how to type the f32 `value` into a `ParamValue` (uniform to map, or a real Hz/Q).
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Lowpass as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[cfg(test)]
mod tests {
    //! The biquad low-pass core (driven via the ABI's `AudioEffect`): its cutoff + resonance are automated
    //! PARAMETERS the engine pushes through `parameter_changed`, mapped to Hz / Q here. In-crate so it can
    //! reach the private state.
    use super::{Lowpass, LowpassState, CUTOFF_MAPPING, RESONANCE_MAPPING};
    use abi::{AudioEffect, Block, BlockFlags, ParamValue};
    use math::value_mapping::ValueMapping;

    const SR: f32 = 48_000.0;

    fn empty_state() -> LowpassState {
        unsafe { core::mem::zeroed() }
    }

    fn state_at(cutoff_hz: f32, resonance_q: f32) -> LowpassState {
        let mut state = empty_state();
        state.cutoff_hz = cutoff_hz;
        state.resonance_q = resonance_q;
        state.sample_rate = SR;
        state.dirty = true;
        state
    }

    // A whole-chunk block (the filter ignores it; `s0`/`s1` are rebased to the slice as the SDK does).
    fn block(len: usize) -> Block {
        Block {index: 0, flags: BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: len as u32, bpm: 120.0}
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample * sample).sum()
    }

    fn nyquist(len: usize) -> Vec<f32> {
        (0..len).map(|index| if index % 2 == 0 {1.0} else {-1.0}).collect()
    }

    #[test]
    fn attenuates_nyquist_at_a_low_cutoff() {
        let input = nyquist(512);
        let mut output = vec![0.0f32; 512];
        Lowpass::process_audio(&mut state_at(300.0, 0.707), &input, &mut output, &block(512));
        assert!(energy(&output) < energy(&input) * 0.05, "the Nyquist tone is strongly attenuated");
    }

    #[test]
    fn cutoff_parameter_drives_the_filter() {
        let input = nyquist(2048);
        let mut high = vec![0.0f32; 2048];
        let mut low = vec![0.0f32; 2048];
        Lowpass::process_audio(&mut state_at(1120.0, 0.707), &input, &mut high, &block(2048));
        Lowpass::process_audio(&mut state_at(80.0, 0.707), &input, &mut low, &block(2048));
        assert!(energy(&high) > energy(&low) * 2.0, "a higher cutoff passes more of the Nyquist tone");
    }

    #[test]
    fn parameter_changed_maps_a_unit_value_but_takes_a_real_value_directly() {
        let mut state = empty_state();
        state.cutoff_id = 0;
        state.resonance_id = 1;
        // Unit: the uniform value is mapped (exp 80..1120, so 1.0 -> 1120 Hz).
        Lowpass::parameter_changed(&mut state, 0, ParamValue::Unit(1.0));
        assert_eq!(state.cutoff_hz, CUTOFF_MAPPING.y(1.0), "a unit value is mapped");
        // Float: a real field value (a UI edit) is used directly, NOT mapped.
        Lowpass::parameter_changed(&mut state, 0, ParamValue::Float(440.0));
        assert_eq!(state.cutoff_hz, 440.0, "a real value is used as-is");
        Lowpass::parameter_changed(&mut state, 1, ParamValue::Unit(1.0));
        assert_eq!(state.resonance_q, RESONANCE_MAPPING.y(1.0), "the resonance maps independently");
        assert!(state.dirty, "a parameter change marks the coefficients stale");
    }
}

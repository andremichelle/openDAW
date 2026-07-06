//! The StereoTool AUDIO-EFFECT device, a faithful port of the TS `StereoToolDeviceProcessor`. It applies a
//! ramped 2x2 stereo mixing matrix built from volume (dB), panning, stereo width, per-channel invert, and a
//! left/right swap, under a selectable pan law (linear / equal-power). The matrix is recomputed only when a
//! parameter changes, then glides via `StereoMatrixRamp`.
//!
//! Parameters (`StereoToolDeviceBox`): volume `[10]` (decibel -72/0/12), panning `[11]` (bipolar), stereo `[12]`
//! (bipolar), invert-l `[13]`, invert-r `[14]`, swap `[15]` (bools). The panning-mixing `[20]` is an INT field
//! (0 = Linear, 1 = EqualPower; observed, not automatable). The device owns the mappings.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`,
//! `field_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, AudioEffect, Block, FieldValue, ParamValue, Ports};
use dsp::db_to_gain;
use dsp::panning::{Mixing, StereoParams};
use dsp::ramp::StereoMatrixRamp;
use math::value_mapping::{Decibel, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const VOLUME_FIELD: [u16; 1] = [10];
const PANNING_FIELD: [u16; 1] = [11];
const STEREO_FIELD: [u16; 1] = [12];
const INVERT_L_FIELD: [u16; 1] = [13];
const INVERT_R_FIELD: [u16; 1] = [14];
const SWAP_FIELD: [u16; 1] = [15];
const PANNING_MIXING_FIELD: [u16; 1] = [20];

const VOLUME_MAPPING: Decibel = Decibel::new(-72.0, 0.0, 12.0);
const PANNING_MAPPING: Linear = Linear::bipolar();
const STEREO_MAPPING: Linear = Linear::bipolar();

const SMOOTH_SECONDS: f32 = 0.005; // the TS `Ramp.stereoMatrix` default glide time

/// The effect's per-instance state (engine-allocated, zeroed): the ramped matrix (built in `init`), the current
/// stereo params + pan law, a `needs_update` flag (recompute the matrix on the next block after any change), the
/// TS `#processed` flag (the first delivery jumps, later edits glide), and the parameter / field ids.
pub struct StereoToolState {
    matrix: StereoMatrixRamp,
    params: StereoParams,
    mixing: Mixing,
    needs_update: bool,
    processed: bool,
    volume_id: u32,
    panning_id: u32,
    stereo_id: u32,
    invert_l_id: u32,
    invert_r_id: u32,
    swap_id: u32,
    panning_mixing_field_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct StereoTool;

impl AudioEffect for StereoTool {
    type State = StereoToolState;

    fn init(state: &mut StereoToolState, sample_rate: f32) {
        state.matrix = StereoMatrixRamp::stereo_matrix(sample_rate, SMOOTH_SECONDS);
        state.params = StereoParams::default();
        state.mixing = Mixing::Linear; // the box default (Mixing.Linear); field_changed refines it
        state.needs_update = true;
        state.processed = false;
        state.volume_id = abi::bind_parameter(&VOLUME_FIELD);
        state.panning_id = abi::bind_parameter(&PANNING_FIELD);
        state.stereo_id = abi::bind_parameter(&STEREO_FIELD);
        state.invert_l_id = abi::bind_parameter(&INVERT_L_FIELD);
        state.invert_r_id = abi::bind_parameter(&INVERT_R_FIELD);
        state.swap_id = abi::bind_parameter(&SWAP_FIELD);
        state.panning_mixing_field_id = abi::observe_field(&PANNING_MIXING_FIELD);
    }

    fn parameter_changed(state: &mut StereoToolState, id: u32, value: ParamValue) {
        if id == state.volume_id {
            state.params.gain = db_to_gain(float_value(value, &VOLUME_MAPPING));
        } else if id == state.panning_id {
            state.params.panning = float_value(value, &PANNING_MAPPING);
        } else if id == state.stereo_id {
            state.params.stereo = float_value(value, &STEREO_MAPPING);
        } else if id == state.invert_l_id {
            state.params.invert_l = bool_value(value);
        } else if id == state.invert_r_id {
            state.params.invert_r = bool_value(value);
        } else if id == state.swap_id {
            state.params.swap = bool_value(value);
        } else {
            return;
        }
        state.needs_update = true;
    }

    fn reset(state: &mut StereoToolState) {
        state.processed = false;
    }

    fn process_audio(state: &mut StereoToolState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        if state.needs_update {
            state.matrix.update(&state.params, state.mixing, state.processed);
            state.needs_update = false;
        }
        state.matrix.process_frames(in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize);
        state.processed = true;
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<StereoToolState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<StereoToolState>::from_descriptor(desc_ptr) };
    abi::render_effect::<StereoTool>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <StereoTool as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <StereoTool as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &VOLUME_MAPPING),
        1 => float_value(value, &PANNING_MAPPING),
        2 => float_value(value, &STEREO_MAPPING),
        3..=5 => if bool_value(value) {1.0} else {0.0},
        _ => f32::NAN
    }
}

/// Transport STOP: clear the runtime state (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <StereoTool as AudioEffect>::reset) }
}

/// Apply the observed `panning-mixing` int field (0 = Linear, 1 = EqualPower).
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut StereoToolState| {
            if id == state.panning_mixing_field_id {
                if let FieldValue::Int(mode) = FieldValue::from_wire(kind, bits, len) {
                    state.mixing = if mode == 1 {Mixing::EqualPower} else {Mixing::Linear};
                    state.needs_update = true;
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    //! The StereoTool DSP driven directly (setting the private state). f32 audio, mirroring the TS math.
    use super::{StereoTool, StereoToolState};
    use dsp::panning::Mixing;
    use dsp::ramp::StereoMatrixRamp;

    const SR: f32 = 48_000.0;

    fn state() -> StereoToolState {
        let mut state: StereoToolState = unsafe { core::mem::zeroed() };
        state.matrix = StereoMatrixRamp::stereo_matrix(SR, 0.005);
        state.mixing = Mixing::Linear;
        state.needs_update = true;
        state
    }

    fn run(state: &mut StereoToolState, in_left: &[f32], in_right: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = in_left.len();
        let (mut out_left, mut out_right) = (vec![0.0f32; n], vec![0.0f32; n]);
        if state.needs_update {
            state.matrix.update(&state.params, state.mixing, state.processed);
            state.needs_update = false;
        }
        state.matrix.process_frames(in_left, in_right, &mut out_left, &mut out_right, 0, n);
        state.processed = true;
        (out_left, out_right)
    }

    #[test]
    fn unity_passes_stereo_through() {
        let mut state = state();
        state.params.gain = 1.0;
        let (left, right) = run(&mut state, &[0.5, -0.2], &[0.3, 0.8]);
        assert!((left[0] - 0.5).abs() < 1e-6 && (right[0] - 0.3).abs() < 1e-6, "identity pass-through");
    }

    #[test]
    fn swap_exchanges_the_channels() {
        let mut state = state();
        state.params.gain = 1.0;
        state.params.swap = true;
        let (left, right) = run(&mut state, &[0.5], &[0.9]);
        assert!((left[0] - 0.9).abs() < 1e-6 && (right[0] - 0.5).abs() < 1e-6, "swap exchanges L and R");
    }

    #[test]
    fn full_mono_sums_the_channels_equally() {
        let mut state = state();
        state.params.gain = 1.0;
        state.params.stereo = -1.0; // fully mono
        let (left, right) = run(&mut state, &[1.0], &[0.0]);
        assert!((left[0] - right[0]).abs() < 1e-6, "mono: both channels identical");
    }

    #[test]
    fn invert_left_negates_the_left_channel() {
        let mut state = state();
        state.params.gain = 1.0;
        state.params.invert_l = true;
        let (left, _right) = run(&mut state, &[0.4], &[0.0]);
        assert!((left[0] + 0.4).abs() < 1e-6, "left channel is inverted");
    }
}

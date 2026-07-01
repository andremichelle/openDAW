//! The Crusher AUDIO-EFFECT device, a faithful port of the TS `CrusherDeviceProcessor`: a thin wrapper binding
//! the `CrusherDeviceBox` parameters to the `dsp::crusher::Crusher` bit-crusher / sample-rate reducer.
//!
//! Parameters (`CrusherDeviceBox`): crush `[10]` (unipolar; the DSP receives `1 - crush`), bits `[11]`
//! (linear-integer 1..16), boost `[12]` (linear 0..24 dB), mix `[13]` (exponential 0.001..1). The device owns
//! the mappings; the host is mapping-agnostic.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, AudioEffect, Block, ParamValue, Ports};
use dsp::crusher::Crusher;
use math::value_mapping::{Exponential, Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The parameter key PATHs on the `CrusherDeviceBox` (the stable schema keys).
const CRUSH_FIELD: [u16; 1] = [10];
const BITS_FIELD: [u16; 1] = [11];
const BOOST_FIELD: [u16; 1] = [12];
const MIX_FIELD: [u16; 1] = [13];

// This device's value mappings (uniform 0..1 -> the parameter's real value), mirroring the TS adapter.
const CRUSH_MAPPING: Linear = Linear::unipolar();
const BITS_MAPPING: LinearInteger = LinearInteger {min: 1, max: 16};
const BOOST_MAPPING: Linear = Linear {min: 0.0, max: 24.0};
const MIX_MAPPING: Exponential = Exponential {min: 0.001, max: 1.0};

/// The effect's per-instance state (engine-allocated, zeroed): the DSP (built in `init`) and the parameter ids.
pub struct CrusherState {
    dsp: Crusher,
    crush_id: u32,
    bits_id: u32,
    boost_id: u32,
    mix_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct CrusherDevice;

impl AudioEffect for CrusherDevice {
    type State = CrusherState;

    fn init(state: &mut CrusherState, sample_rate: f32) {
        state.dsp = Crusher::new(sample_rate);
        state.crush_id = abi::bind_parameter(&CRUSH_FIELD);
        state.bits_id = abi::bind_parameter(&BITS_FIELD);
        state.boost_id = abi::bind_parameter(&BOOST_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
    }

    fn parameter_changed(state: &mut CrusherState, id: u32, value: ParamValue) {
        if id == state.crush_id {
            state.dsp.set_crush(1.0 - float_value(value, &CRUSH_MAPPING)); // 1 - crush: 0 = clean, 1 = max
        } else if id == state.bits_id {
            state.dsp.set_bit_depth(int_value(value, &BITS_MAPPING));
        } else if id == state.boost_id {
            state.dsp.set_boost(float_value(value, &BOOST_MAPPING));
        } else if id == state.mix_id {
            state.dsp.set_mix(float_value(value, &MIX_MAPPING));
        }
    }

    fn reset(state: &mut CrusherState) {
        state.dsp.reset();
    }

    fn process_audio(state: &mut CrusherState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        state.dsp.process(in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize);
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<CrusherState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<CrusherState>::from_descriptor(desc_ptr) };
    abi::render_effect::<CrusherDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <CrusherDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <CrusherDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[cfg(test)]
mod tests {
    //! The device wrapper delegates to the DSP (covered thoroughly in `dsp::crusher`); here we just confirm the
    //! parameter routing (crush inverts, mix bypasses) drives the DSP as the TS processor does.
    use super::{CrusherDevice, CrusherState};
    use abi::{AudioEffect, ParamValue};

    fn state() -> CrusherState {
        let mut state: CrusherState = unsafe { core::mem::zeroed() };
        CrusherDevice::init(&mut state, 48_000.0);
        // `init` binds ids off the (native-stub) host, all 0; assign distinct ids so routing is testable.
        state.crush_id = 1;
        state.bits_id = 2;
        state.boost_id = 3;
        state.mix_id = 4;
        state
    }

    #[test]
    fn mix_zero_passes_the_input_through() {
        let mut state = state();
        let (crush, bits, boost, mix) = (state.crush_id, state.bits_id, state.boost_id, state.mix_id);
        CrusherDevice::parameter_changed(&mut state, crush, ParamValue::Float(0.5));
        CrusherDevice::parameter_changed(&mut state, bits, ParamValue::Int(4));
        CrusherDevice::parameter_changed(&mut state, boost, ParamValue::Float(0.0));
        CrusherDevice::parameter_changed(&mut state, mix, ParamValue::Float(0.0));
        let input = [0.6f32, -0.4, 0.8];
        let (mut left, mut right) = (vec![0.0f32; 3], vec![0.0f32; 3]);
        state.dsp.process(&input, &input, &mut left, &mut right, 0, 3);
        for (got, want) in left.iter().zip(input) {
            assert!((got - want).abs() < 1e-6, "mix=0 dry pass-through");
        }
    }

    #[test]
    fn full_crush_low_bits_snaps_output_to_steps() {
        let mut state = state();
        let (crush, bits, boost, mix) = (state.crush_id, state.bits_id, state.boost_id, state.mix_id);
        CrusherDevice::parameter_changed(&mut state, crush, ParamValue::Float(0.0)); // 1 - 0 = 1 -> nyquist
        CrusherDevice::parameter_changed(&mut state, bits, ParamValue::Int(1));
        CrusherDevice::parameter_changed(&mut state, boost, ParamValue::Float(0.0));
        CrusherDevice::parameter_changed(&mut state, mix, ParamValue::Float(1.0));
        let input: Vec<f32> = (0..128).map(|i| 0.9 * (i as f32 * 0.3).sin()).collect();
        let (mut left, mut right) = (vec![0.0f32; 128], vec![0.0f32; 128]);
        state.dsp.process(&input, &input, &mut left, &mut right, 0, 128);
        for sample in &left {
            let nearest = [-1.0f32, 0.0, 1.0].iter().map(|step| (sample - step).abs()).fold(f32::MAX, f32::min);
            assert!(nearest < 1e-4, "1-bit routing snaps to a step, got {sample}");
        }
    }
}

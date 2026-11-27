#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, AudioEffect, Block, ParamValue, Ports};
use math::value_mapping::{Exponential, Linear, LinearInteger};

pub mod corrode;
#[cfg(test)]
mod tests;

use corrode::Corrode;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const MODE_FIELD: [u16; 1] = [10];
const FREQUENCY_FIELD: [u16; 1] = [11];
const WIDTH_FIELD: [u16; 1] = [12];
const AMOUNT_FIELD: [u16; 1] = [13];

const MODE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
const FREQUENCY_MAPPING: Exponential = Exponential {min: 50.0, max: 18000.0};
const WIDTH_MAPPING: Exponential = Exponential {min: 0.08, max: 10.0};
const AMOUNT_MAPPING: Linear = Linear {min: 0.0, max: 100.0};

pub struct CorrodeState {
    dsp: Corrode,
    mode_id: u32,
    frequency_id: u32,
    width_id: u32,
    amount_id: u32
}

pub struct CorrodeDevice;

impl AudioEffect for CorrodeDevice {
    type State = CorrodeState;

    fn init(state: &mut CorrodeState, sample_rate: f32) {
        state.dsp.init(sample_rate);
        abi::set_latency(state.dsp.latency());
        state.mode_id = abi::bind_parameter(&MODE_FIELD);
        state.frequency_id = abi::bind_parameter(&FREQUENCY_FIELD);
        state.width_id = abi::bind_parameter(&WIDTH_FIELD);
        state.amount_id = abi::bind_parameter(&AMOUNT_FIELD);
    }

    fn parameter_changed(state: &mut CorrodeState, id: u32, value: ParamValue) {
        if id == state.mode_id {
            state.dsp.set_mode(int_value(value, &MODE_MAPPING));
        } else if id == state.frequency_id {
            state.dsp.set_frequency(float_value(value, &FREQUENCY_MAPPING));
        } else if id == state.width_id {
            state.dsp.set_width(float_value(value, &WIDTH_MAPPING));
        } else if id == state.amount_id {
            state.dsp.set_amount(float_value(value, &AMOUNT_MAPPING));
        }
    }

    fn reset(state: &mut CorrodeState) {
        state.dsp.reset();
    }

    fn process_audio(state: &mut CorrodeState, output: [&mut [f32]; 2], block: &Block) {
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
    core::mem::size_of::<CorrodeState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<CorrodeState>::from_descriptor(desc_ptr) };
    abi::render_effect::<CorrodeDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <CorrodeDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <CorrodeDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => int_value(value, &MODE_MAPPING) as f32,
        1 => float_value(value, &FREQUENCY_MAPPING),
        2 => float_value(value, &WIDTH_MAPPING),
        3 => float_value(value, &AMOUNT_MAPPING),
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <CorrodeDevice as AudioEffect>::reset) }
}

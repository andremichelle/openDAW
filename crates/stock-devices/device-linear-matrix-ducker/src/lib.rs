#![cfg_attr(target_family = "wasm", no_std)]
pub mod ducker;

use abi::{float_value, int_value, AudioEffect, Block, ParamValue, Ports, MAIN_INPUT};
use ducker::{Ducker, DISPLAY_ENTRIES, DISPLAY_VALUES};
use math::value_mapping::{Linear, LinearInteger, Power};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const THRESHOLD_FIELD: [u16; 1] = [10];
const ATTACK_FIELD: [u16; 1] = [11];
const HOLD_FIELD: [u16; 1] = [12];
const RELEASE_FIELD: [u16; 1] = [13];
const MODE_FIELD: [u16; 1] = [14];
const RANGE_FIELD: [u16; 1] = [15];
const STEREO_FIELD: [u16; 1] = [16];
const MIX_FIELD: [u16; 1] = [17];
const SIDE_CHAIN_FIELD: [u16; 1] = [30];
const DISPLAY_FIELD: [u16; 1] = [0];
const DISPLAY_LENGTH: usize = 1 + DISPLAY_ENTRIES * DISPLAY_VALUES;

pub const THRESHOLD_MAPPING: Linear = Linear {min: -60.0, max: 6.0};
pub const ATTACK_MAPPING: Linear = Linear {min: 0.0, max: 10.0};
pub const HOLD_MAPPING: Linear = Linear {min: 0.0, max: 10.0};
pub const MODE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
pub const RANGE_MAPPING: Linear = Linear {min: 0.0, max: 2.0};
pub const UNIPOLAR_MAPPING: Linear = Linear::unipolar();

pub fn release_mapping() -> Power {Power::by_center(90.5, 0.0, 1000.0)}

pub struct DuckerState {
    ducker: Ducker,
    threshold_id: u32,
    attack_id: u32,
    hold_id: u32,
    release_id: u32,
    mode_id: u32,
    range_id: u32,
    stereo_id: u32,
    mix_id: u32,
    sidechain_id: u32,
    display_id: u32
}

pub struct LinearMatrixDucker;

impl AudioEffect for LinearMatrixDucker {
    type State = DuckerState;

    fn init(state: &mut DuckerState, sample_rate: f32) {
        state.ducker.init(sample_rate);
        state.threshold_id = abi::bind_parameter(&THRESHOLD_FIELD);
        state.attack_id = abi::bind_parameter(&ATTACK_FIELD);
        state.hold_id = abi::bind_parameter(&HOLD_FIELD);
        state.release_id = abi::bind_parameter(&RELEASE_FIELD);
        state.mode_id = abi::bind_parameter(&MODE_FIELD);
        state.range_id = abi::bind_parameter(&RANGE_FIELD);
        state.stereo_id = abi::bind_parameter(&STEREO_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
        state.sidechain_id = abi::bind_sidechain(&SIDE_CHAIN_FIELD);
        state.display_id = abi::bind_broadcast(&DISPLAY_FIELD, DISPLAY_LENGTH as u32);
        abi::set_latency(state.ducker.latency() as u32);
    }

    fn parameter_changed(state: &mut DuckerState, id: u32, value: ParamValue) {
        let ducker = &mut state.ducker;
        if id == state.threshold_id {
            ducker.set_threshold_db(float_value(value, &THRESHOLD_MAPPING));
        } else if id == state.attack_id {
            ducker.set_attack_ms(float_value(value, &ATTACK_MAPPING));
        } else if id == state.hold_id {
            ducker.set_hold_ms(float_value(value, &HOLD_MAPPING));
        } else if id == state.release_id {
            ducker.set_release_ms(float_value(value, &release_mapping()));
        } else if id == state.mode_id {
            ducker.set_mode(int_value(value, &MODE_MAPPING));
        } else if id == state.range_id {
            ducker.set_range(float_value(value, &RANGE_MAPPING));
        } else if id == state.stereo_id {
            ducker.set_stereo(float_value(value, &UNIPOLAR_MAPPING));
        } else if id == state.mix_id {
            ducker.set_mix(float_value(value, &UNIPOLAR_MAPPING));
        }
    }

    fn reset(state: &mut DuckerState) {
        state.ducker.reset();
    }

    fn process_audio(state: &mut DuckerState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let side = abi::resolve_input(state.sidechain_id);
        let side_channels = side.as_ref().map(|reference| (reference.left(), reference.right()));
        let [out_left, out_right] = output;
        state.ducker.process(in_left, in_right, side_channels, out_left, out_right, block.s0 as usize, block.s1 as usize);
        if !abi::broadcast_active(state.display_id) {return}
        let ptr = abi::broadcast_ptr(state.display_id);
        if ptr == 0 {return}
        let values = unsafe { core::slice::from_raw_parts_mut(ptr as *mut f32, DISPLAY_LENGTH) };
        values[0] = state.ducker.display_written as f32;
        for (entry, chunk) in state.ducker.display.iter().zip(values[1..].chunks_exact_mut(DISPLAY_VALUES)) {
            chunk.copy_from_slice(entry);
        }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<DuckerState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    abi::render_effect::<LinearMatrixDucker>(unsafe { Ports::<DuckerState>::from_descriptor(desc_ptr) });
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| LinearMatrixDucker::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe {
        abi::with_state(state_ptr, |state| {
            LinearMatrixDucker::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))
        })
    }
}

#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &THRESHOLD_MAPPING),
        1 => float_value(value, &ATTACK_MAPPING),
        2 => float_value(value, &HOLD_MAPPING),
        3 => float_value(value, &release_mapping()),
        4 => int_value(value, &MODE_MAPPING) as f32,
        5 => float_value(value, &RANGE_MAPPING),
        6 => float_value(value, &UNIPOLAR_MAPPING),
        7 => float_value(value, &UNIPOLAR_MAPPING),
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, LinearMatrixDucker::reset) }
}

#[cfg(test)]
mod tests;

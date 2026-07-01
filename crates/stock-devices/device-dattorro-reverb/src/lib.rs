//! The DattorroReverb AUDIO-EFFECT device, a faithful port of the TS `DattorroReverbDeviceProcessor` — a thin
//! wrapper binding the `DattorroReverbDeviceBox` parameters to the `dsp::dattorro::DattorroReverbDsp` plate reverb.
//!
//! Parameters (`DattorroReverbDeviceBox`): preDelay `[10]` (linear 0..1000 ms), bandwidth `[11]`,
//! inputDiffusion1/2 `[12,13]`, decay `[14]`, decayDiffusion1/2 `[15,16]`, damping `[17]`, excursionRate `[18]`,
//! excursionDepth `[19]` (all unipolar), wet `[20]` / dry `[21]` (decibel). The device owns the mappings.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, ParamValue, Ports};
use dsp::dattorro::DattorroReverbDsp;
use dsp::db_to_gain;
use math::value_mapping::{Decibel, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const PRE_DELAY_FIELD: [u16; 1] = [10];
const BANDWIDTH_FIELD: [u16; 1] = [11];
const INPUT_DIFFUSION1_FIELD: [u16; 1] = [12];
const INPUT_DIFFUSION2_FIELD: [u16; 1] = [13];
const DECAY_FIELD: [u16; 1] = [14];
const DECAY_DIFFUSION1_FIELD: [u16; 1] = [15];
const DECAY_DIFFUSION2_FIELD: [u16; 1] = [16];
const DAMPING_FIELD: [u16; 1] = [17];
const EXCURSION_RATE_FIELD: [u16; 1] = [18];
const EXCURSION_DEPTH_FIELD: [u16; 1] = [19];
const WET_FIELD: [u16; 1] = [20];
const DRY_FIELD: [u16; 1] = [21];

const PRE_DELAY_MAPPING: Linear = Linear {min: 0.0, max: 1000.0};
const UNIPOLAR: Linear = Linear::unipolar();
const GAIN_MAPPING: Decibel = Decibel::default_volume();

/// The reverb's per-instance state (engine-allocated, zeroed): the plate DSP (init in place — it is ~500 KB, too
/// large for the device stack) and the parameter ids.
pub struct DattorroState {
    dsp: DattorroReverbDsp,
    pre_delay_id: u32,
    bandwidth_id: u32,
    input_diffusion1_id: u32,
    input_diffusion2_id: u32,
    decay_id: u32,
    decay_diffusion1_id: u32,
    decay_diffusion2_id: u32,
    damping_id: u32,
    excursion_rate_id: u32,
    excursion_depth_id: u32,
    wet_id: u32,
    dry_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Dattorro;

impl AudioEffect for Dattorro {
    type State = DattorroState;

    fn init(state: &mut DattorroState, sample_rate: f32) {
        state.dsp.init(sample_rate);
        state.pre_delay_id = abi::bind_parameter(&PRE_DELAY_FIELD);
        state.bandwidth_id = abi::bind_parameter(&BANDWIDTH_FIELD);
        state.input_diffusion1_id = abi::bind_parameter(&INPUT_DIFFUSION1_FIELD);
        state.input_diffusion2_id = abi::bind_parameter(&INPUT_DIFFUSION2_FIELD);
        state.decay_id = abi::bind_parameter(&DECAY_FIELD);
        state.decay_diffusion1_id = abi::bind_parameter(&DECAY_DIFFUSION1_FIELD);
        state.decay_diffusion2_id = abi::bind_parameter(&DECAY_DIFFUSION2_FIELD);
        state.damping_id = abi::bind_parameter(&DAMPING_FIELD);
        state.excursion_rate_id = abi::bind_parameter(&EXCURSION_RATE_FIELD);
        state.excursion_depth_id = abi::bind_parameter(&EXCURSION_DEPTH_FIELD);
        state.wet_id = abi::bind_parameter(&WET_FIELD);
        state.dry_id = abi::bind_parameter(&DRY_FIELD);
    }

    fn parameter_changed(state: &mut DattorroState, id: u32, value: ParamValue) {
        if id == state.pre_delay_id {
            state.dsp.set_pre_delay_ms(float_value(value, &PRE_DELAY_MAPPING));
        } else if id == state.bandwidth_id {
            state.dsp.set_bandwidth(float_value(value, &UNIPOLAR));
        } else if id == state.input_diffusion1_id {
            state.dsp.set_input_diffusion1(float_value(value, &UNIPOLAR));
        } else if id == state.input_diffusion2_id {
            state.dsp.set_input_diffusion2(float_value(value, &UNIPOLAR));
        } else if id == state.decay_id {
            state.dsp.set_decay(float_value(value, &UNIPOLAR));
        } else if id == state.decay_diffusion1_id {
            state.dsp.set_decay_diffusion1(float_value(value, &UNIPOLAR));
        } else if id == state.decay_diffusion2_id {
            state.dsp.set_decay_diffusion2(float_value(value, &UNIPOLAR));
        } else if id == state.damping_id {
            state.dsp.set_damping(float_value(value, &UNIPOLAR));
        } else if id == state.excursion_rate_id {
            state.dsp.set_excursion_rate(float_value(value, &UNIPOLAR));
        } else if id == state.excursion_depth_id {
            state.dsp.set_excursion_depth(float_value(value, &UNIPOLAR));
        } else if id == state.wet_id {
            state.dsp.set_wet_gain(db_to_gain(float_value(value, &GAIN_MAPPING)));
        } else if id == state.dry_id {
            state.dsp.set_dry_gain(db_to_gain(float_value(value, &GAIN_MAPPING)));
        }
    }

    fn process_audio(state: &mut DattorroState, output: [&mut [f32]; 2], block: &Block) {
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
    core::mem::size_of::<DattorroState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<DattorroState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Dattorro>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Dattorro as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Dattorro as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

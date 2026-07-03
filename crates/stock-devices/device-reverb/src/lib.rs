//! The Reverb AUDIO-EFFECT device, a faithful port of the TS `ReverbDeviceProcessor` — a thin wrapper binding
//! the `ReverbDeviceBox` parameters to the `dsp::freeverb::FreeVerb` (comb + allpass reverb) with a stereo
//! pre-delay.
//!
//! Parameters (`ReverbDeviceBox`): decay `[10]` (unipolar -> room size), pre-delay `[11]` (exp 0.001..0.5 s),
//! damp `[12]` (unipolar), filter `[13]` (bipolar; bound but UNUSED, mirroring the TS which never applies it),
//! wet `[14]` / dry `[15]` (decibel). The device owns the mappings; the host is mapping-agnostic.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, ParamValue, Ports};
use dsp::db_to_gain;
use dsp::freeverb::FreeVerb;
use math::value_mapping::{Decibel, Exponential, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const DECAY_FIELD: [u16; 1] = [10];
const PRE_DELAY_FIELD: [u16; 1] = [11];
const DAMP_FIELD: [u16; 1] = [12];
const FILTER_FIELD: [u16; 1] = [13];
const WET_FIELD: [u16; 1] = [14];
const DRY_FIELD: [u16; 1] = [15];

const DECAY_MAPPING: Linear = Linear::unipolar();
const PRE_DELAY_MAPPING: Exponential = Exponential {min: 0.001, max: 0.500};
const DAMP_MAPPING: Linear = Linear::unipolar();
const FILTER_MAPPING: Linear = Linear::bipolar();
const GAIN_MAPPING: Decibel = Decibel::default_volume(); // ValueMapping.DefaultDecibel = decibel(-72, -12, 0)

/// The reverb's per-instance state (engine-allocated, zeroed): the FreeVerb DSP (built in `init`), the sample
/// rate (for the pre-delay in samples), and the parameter ids. `filter_id` is bound but never applied (TS parity).
pub struct ReverbState {
    reverb: FreeVerb,
    sample_rate: f32,
    decay_id: u32,
    pre_delay_id: u32,
    damp_id: u32,
    filter_id: u32,
    wet_id: u32,
    dry_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Reverb;

impl AudioEffect for Reverb {
    type State = ReverbState;

    fn init(state: &mut ReverbState, sample_rate: f32) {
        state.reverb.init(sample_rate);
        state.sample_rate = sample_rate;
        state.decay_id = abi::bind_parameter(&DECAY_FIELD);
        state.pre_delay_id = abi::bind_parameter(&PRE_DELAY_FIELD);
        state.damp_id = abi::bind_parameter(&DAMP_FIELD);
        state.filter_id = abi::bind_parameter(&FILTER_FIELD);
        state.wet_id = abi::bind_parameter(&WET_FIELD);
        state.dry_id = abi::bind_parameter(&DRY_FIELD);
    }

    fn parameter_changed(state: &mut ReverbState, id: u32, value: ParamValue) {
        if id == state.decay_id {
            state.reverb.room_size = float_value(value, &DECAY_MAPPING);
        } else if id == state.pre_delay_id {
            let seconds = float_value(value, &PRE_DELAY_MAPPING);
            state.reverb.predelay_in_samples = libm::ceilf(seconds * state.sample_rate) as usize;
        } else if id == state.damp_id {
            state.reverb.damp = float_value(value, &DAMP_MAPPING);
        } else if id == state.wet_id {
            state.reverb.wet_gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.dry_id {
            state.reverb.dry_gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.filter_id {
            let _ = float_value(value, &FILTER_MAPPING); // bound for automation parity, but the TS DSP ignores it
        }
    }

    fn reset(state: &mut ReverbState) {
        state.reverb.clear(); // TS `ReverbDeviceProcessor.reset` -> `FreeVerb.clear`: the tail dies on STOP
    }

    fn process_audio(state: &mut ReverbState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        state.reverb.process(in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize);
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ReverbState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<ReverbState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Reverb>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Reverb as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Reverb as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Transport STOP: the reverb tail dies (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Reverb as AudioEffect>::reset) }
}

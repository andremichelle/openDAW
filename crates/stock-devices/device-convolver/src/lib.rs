//! The Convolver AUDIO-EFFECT device: convolves the signal with an impulse-response SAMPLE via
//! `dsp::convolution::Convolver` (zero-latency non-uniform partitioned convolution, SIMD128).
//!
//! The IR is the `file` pointer `[10]`, observed with `abi::observe_sample` and resolved to planar
//! frames each block (`resolve_sample`), resampled to the engine rate at load time. The transform
//! is TIME-DISTRIBUTED (a budget of partitions per block), so an IR swap never spikes the render.
//!
//! Parameters: wet `[11]` / dry `[12]` (decibel), pre-delay `[13]` (exp 0.001..0.5 s), normalize
//! `[14]` (unity IR energy), reverse `[15]` (both retransform the IR).
//!
//! Exports: `kind()`, `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`,
//! `sample_changed(...)`, `reset(...)`, `map_parameter(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, ParamValue, Ports};
use dsp::convolution::Convolver;
use dsp::db_to_gain;
use math::value_mapping::{Decibel, Exponential};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const FILE_POINTER: [u16; 1] = [10];
const WET_FIELD: [u16; 1] = [11];
const DRY_FIELD: [u16; 1] = [12];
const PRE_DELAY_FIELD: [u16; 1] = [13];
const NORMALIZE_FIELD: [u16; 1] = [14];
const REVERSE_FIELD: [u16; 1] = [15];

const GAIN_MAPPING: Decibel = Decibel::default_volume();
const PRE_DELAY_MAPPING: Exponential = Exponential {min: 0.001, max: 0.500};

// per-block IR transform budget in 8192-partition units (a full 8 s IR loads in ~24 blocks)
const LOAD_BUDGET: usize = 2;

pub struct ConvolverState {
    convolver: Convolver,
    sample_rate: f32,
    sample: Option<u32>,
    reload: bool,
    normalize: bool,
    reverse: bool,
    wet_id: u32,
    dry_id: u32,
    pre_delay_id: u32,
    normalize_id: u32,
    reverse_id: u32,
    sample_id: u32
}

pub struct ConvolverDevice;

impl ConvolverDevice {
    fn maintain_ir(state: &mut ConvolverState) {
        let Some(handle) = state.sample else { return };
        if !state.reload && !state.convolver.loading() {
            return;
        }
        let Some(sample) = abi::resolve_sample(handle) else { return };
        let left = sample.plane(0);
        let stereo = sample.channel_count > 1;
        let right = if stereo { sample.plane(1) } else { left };
        if state.reload {
            let ratio = if sample.sample_rate > 0.0 { sample.sample_rate / state.sample_rate } else { 1.0 };
            state.convolver.begin_load(left, right, stereo, state.normalize, state.reverse, ratio);
            state.reload = false;
        }
        state.convolver.load_step(left, right, LOAD_BUDGET);
    }

    fn sample_changed(state: &mut ConvolverState, id: u32, sample: Option<u32>) {
        if id != state.sample_id {
            return;
        }
        state.sample = sample;
        match sample {
            Some(_) => state.reload = true,
            None => {
                state.reload = false;
                state.convolver.unload();
            }
        }
    }
}

impl AudioEffect for ConvolverDevice {
    type State = ConvolverState;

    fn init(state: &mut ConvolverState, sample_rate: f32) {
        state.convolver.init();
        state.sample_rate = sample_rate;
        state.sample = None;
        state.reload = false;
        state.normalize = true;
        state.reverse = false;
        state.wet_id = abi::bind_parameter(&WET_FIELD);
        state.dry_id = abi::bind_parameter(&DRY_FIELD);
        state.pre_delay_id = abi::bind_parameter(&PRE_DELAY_FIELD);
        state.normalize_id = abi::bind_parameter(&NORMALIZE_FIELD);
        state.reverse_id = abi::bind_parameter(&REVERSE_FIELD);
        state.sample_id = abi::observe_sample(&FILE_POINTER);
    }

    fn parameter_changed(state: &mut ConvolverState, id: u32, value: ParamValue) {
        if id == state.wet_id {
            state.convolver.wet_gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.dry_id {
            state.convolver.dry_gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.pre_delay_id {
            let seconds = float_value(value, &PRE_DELAY_MAPPING);
            state.convolver.predelay_samples = libm::ceilf(seconds * state.sample_rate) as usize;
        } else if id == state.normalize_id {
            let normalize = abi::bool_value(value);
            if normalize != state.normalize {
                state.normalize = normalize;
                state.reload = state.sample.is_some();
            }
        } else if id == state.reverse_id {
            let reverse = abi::bool_value(value);
            if reverse != state.reverse {
                state.reverse = reverse;
                state.reload = state.sample.is_some();
            }
        }
    }

    fn reset(state: &mut ConvolverState) {
        state.convolver.clear_runtime();
    }

    fn process_audio(state: &mut ConvolverState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else { return };
        if block.s0 == 0 {
            Self::maintain_ir(state);
        }
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        state.convolver.process(in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize);
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ConvolverState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<ConvolverState>::from_descriptor(desc_ptr) };
    abi::render_effect::<ConvolverDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut ConvolverState| {
            <ConvolverDevice as AudioEffect>::init(state, sample_rate);
            // per-instance period phase from the state address: heavy FFT quanta never align across instances
            state.convolver.set_stagger((state_ptr >> 6) as usize);
        })
    }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ConvolverDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Apply an observed `file` pointer change (the IR sample), by the id `observe_sample` returned.
#[no_mangle]
pub extern "C" fn sample_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    let sample = if present != 0 { Some(handle) } else { None };
    unsafe { abi::with_state(state_ptr, |state| ConvolverDevice::sample_changed(state, id, sample)) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 | 1 => float_value(value, &GAIN_MAPPING),
        2 => float_value(value, &PRE_DELAY_MAPPING),
        3 | 4 => if abi::bool_value(value) {1.0} else {0.0},
        _ => f32::NAN
    }
}

/// Transport STOP: the convolution tail dies, the IR spectra stay.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <ConvolverDevice as AudioEffect>::reset) }
}

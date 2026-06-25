//! The Delay, a tempo-syncable stereo delay AUDIO EFFECT, a faithful port of the TS `DelayDeviceProcessor` +
//! `DelayDeviceDsp`. The DSP (circular delay + filter + pre-delay + LFO + limiter + cross-feedback) lives in
//! `delay_dsp.rs`, the pre-delay line in `delay.rs`, the tempo-sync fraction table in `fractions.rs`.
//!
//! RATE-SIZED STATE: the delay buffers are large and depend on the sample rate (the worst case is a 1-bar
//! delay at 30 bpm + 1 s pre-delay + 50 ms LFO). The state ends with a flexible `[f32; 0]` tail;
//! `state_size(sample_rate)` returns `header + 4 * pow2(maxFrames) * 4` bytes (two delay lines + two
//! pre-delay lines), and `process` slices the four buffers out of the engine-allocated tail. No `Vec`.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(state_ptr, id, kind, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, ParamValue, Ports};
use math::db_to_gain;
use math::value_mapping::{Decibel, Exponential, Linear, LinearInteger, Power, ValueMapping};
use dsp::ppqn::pulses_to_samples;

mod delay;
mod delay_dsp;
mod fractions;
use delay_dsp::DelayDsp;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const TEMPO_MIN: f32 = 30.0; // TempoRange.min, the slowest tempo, which sets the worst-case delay length
const MAX_MILLIS_TIME: f64 = 1000.0; // DelayDeviceBoxAdapter.MAX_MILLIS_TIME
const LFO_DEPTH_MAX: f64 = 50.0; // DelayDeviceBoxAdapter.LFO_DEPTH_MAX (ms)
const LFO_SPEED_MIN: f32 = 0.1;
const LFO_SPEED_MAX: f32 = 5.0;

// The DelayDeviceBox field-key paths (the stable schema keys).
const PRE_SYNC_L_FIELD: [u16; 1] = [16];
const PRE_MILLIS_L_FIELD: [u16; 1] = [17];
const PRE_SYNC_R_FIELD: [u16; 1] = [19];
const PRE_MILLIS_R_FIELD: [u16; 1] = [20];
const DELAY_SYNC_FIELD: [u16; 1] = [10]; // delayMusical
const DELAY_MILLIS_FIELD: [u16; 1] = [22]; // delayMillis
const FEEDBACK_FIELD: [u16; 1] = [11];
const CROSS_FIELD: [u16; 1] = [12];
const LFO_SPEED_FIELD: [u16; 1] = [23];
const LFO_DEPTH_FIELD: [u16; 1] = [24];
const FILTER_FIELD: [u16; 1] = [13];
const WET_FIELD: [u16; 1] = [14];
const DRY_FIELD: [u16; 1] = [15];

mod param {
    pub const PRE_SYNC_L: usize = 0;
    pub const PRE_MILLIS_L: usize = 1;
    pub const PRE_SYNC_R: usize = 2;
    pub const PRE_MILLIS_R: usize = 3;
    pub const DELAY_SYNC: usize = 4;
    pub const DELAY_MILLIS: usize = 5;
    pub const FEEDBACK: usize = 6;
    pub const CROSS: usize = 7;
    pub const LFO_SPEED: usize = 8;
    pub const LFO_DEPTH: usize = 9;
    pub const FILTER: usize = 10;
    pub const WET: usize = 11;
    pub const DRY: usize = 12;
    pub const COUNT: usize = 13;
}

const SYNC_MAPPING: LinearInteger = LinearInteger {min: 0, max: fractions::FRACTIONS.len() as i32 - 1};
const UNIPOLAR: Linear = Linear::unipolar();
const BIPOLAR: Linear = Linear::bipolar();
const LFO_SPEED_MAPPING: Exponential = Exponential {min: LFO_SPEED_MIN, max: LFO_SPEED_MAX};
const LFO_DEPTH_MAPPING: Power = Power {exp: 4.0, min: 0.0, max: LFO_DEPTH_MAX as f32}; // power(4, 0, 50)
const VOLUME_MAPPING: Decibel = Decibel::default_volume();

/// Resolve a sync-time fraction index (a `linearInteger`): the automation value snapped, else the real int.
fn sync_index(value: ParamValue) -> i32 {
    match value {
        ParamValue::Unit(unit) => SYNC_MAPPING.y(unit),
        ParamValue::Int(real) => real,
        ParamValue::Float(real) => real as i32,
        ParamValue::Bool(flag) => if flag {1} else {0}
    }
}

/// The pre-delay millis parameters use `powerByCenter(100, 0, 1000)`; built at use (a log, but rare on edits).
fn millis_value(value: ParamValue) -> f32 {
    float_value(value, &Power::by_center(100.0, 0.0, MAX_MILLIS_TIME as f32))
}

/// The worst-case delay length in frames (pow2): a 1-bar fraction at the slowest tempo, plus the full
/// unsynced millis and the full LFO depth. Sizes the rate-dependent delay buffers identically to the TS.
fn delay_size(sample_rate: f32) -> usize {
    let max_fraction = fractions::fraction_pulses(fractions::FRACTIONS.len() as i32 - 1); // [1, 1] = one bar
    let max_delay = pulses_to_samples(max_fraction, TEMPO_MIN, sample_rate);
    let max_unsync = MAX_MILLIS_TIME * 0.001 * sample_rate as f64;
    let max_lfo = LFO_DEPTH_MAX * 0.001 * sample_rate as f64;
    let frames = libm::ceil(max_delay + max_unsync + max_lfo).max(1.0) as usize;
    frames.next_power_of_two()
}

/// The device state: the DSP (no buffers), the sample rate, the pow2 buffer size, the per-block delay-time
/// inputs (recomputed against `bpm`), the bound parameter ids, and the flexible `[f32; 0]` tail the engine
/// allocates to hold the four pow2-sized delay buffers.
#[repr(C)]
pub struct DelayState {
    delay_dsp: DelayDsp,
    sample_rate: f32,
    buffer_size: usize,
    pre_sync_l: i32,
    pre_millis_l: f32,
    pre_sync_r: i32,
    pre_millis_r: f32,
    delay_sync: i32,
    delay_millis: f32,
    ids: [u32; param::COUNT],
    tail: [f32; 0]
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Delay;

fn sync_samples(index: i32, bpm: f32, sample_rate: f32) -> f64 {
    pulses_to_samples(fractions::fraction_pulses(index), bpm, sample_rate)
}

fn unsync_samples(millis: f32, sample_rate: f32) -> f64 {
    millis as f64 * 0.001 * sample_rate as f64
}

impl AudioEffect for Delay {
    type State = DelayState;

    fn init(state: &mut DelayState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life
        state.buffer_size = delay_size(sample_rate);
        state.delay_dsp = DelayDsp::new(sample_rate, state.buffer_size);
        state.ids[param::PRE_SYNC_L] = abi::bind_parameter(&PRE_SYNC_L_FIELD);
        state.ids[param::PRE_MILLIS_L] = abi::bind_parameter(&PRE_MILLIS_L_FIELD);
        state.ids[param::PRE_SYNC_R] = abi::bind_parameter(&PRE_SYNC_R_FIELD);
        state.ids[param::PRE_MILLIS_R] = abi::bind_parameter(&PRE_MILLIS_R_FIELD);
        state.ids[param::DELAY_SYNC] = abi::bind_parameter(&DELAY_SYNC_FIELD);
        state.ids[param::DELAY_MILLIS] = abi::bind_parameter(&DELAY_MILLIS_FIELD);
        state.ids[param::FEEDBACK] = abi::bind_parameter(&FEEDBACK_FIELD);
        state.ids[param::CROSS] = abi::bind_parameter(&CROSS_FIELD);
        state.ids[param::LFO_SPEED] = abi::bind_parameter(&LFO_SPEED_FIELD);
        state.ids[param::LFO_DEPTH] = abi::bind_parameter(&LFO_DEPTH_FIELD);
        state.ids[param::FILTER] = abi::bind_parameter(&FILTER_FIELD);
        state.ids[param::WET] = abi::bind_parameter(&WET_FIELD);
        state.ids[param::DRY] = abi::bind_parameter(&DRY_FIELD);
    }

    fn process_audio(state: &mut DelayState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        let sample_rate = state.sample_rate;
        let bpm = block.bpm;
        // Recompute the three offsets against the current tempo (the setters no-op when unchanged, and glide
        // when they change, mirroring the TS bpm-changed / dirty-flag recompute).
        let pre_left = sync_samples(state.pre_sync_l, bpm, sample_rate) + unsync_samples(state.pre_millis_l, sample_rate);
        let pre_right = sync_samples(state.pre_sync_r, bpm, sample_rate) + unsync_samples(state.pre_millis_r, sample_rate);
        let main = sync_samples(state.delay_sync, bpm, sample_rate) + unsync_samples(state.delay_millis, sample_rate);
        state.delay_dsp.set_pre_delay_left_offset(pre_left);
        state.delay_dsp.set_pre_delay_right_offset(pre_right);
        state.delay_dsp.set_offset(main);
        // Slice the four pow2 delay buffers out of the engine-allocated tail (disjoint from the header, so the
        // raw slices never alias `delay_dsp`).
        let size = state.buffer_size;
        let tail = unsafe { core::slice::from_raw_parts_mut(state.tail.as_mut_ptr(), 4 * size) };
        let (delay_l, rest) = tail.split_at_mut(size);
        let (delay_r, rest) = rest.split_at_mut(size);
        let (pre_l, pre_r) = rest.split_at_mut(size);
        if block.flags.discontinuous() {
            state.delay_dsp.reset([delay_l, delay_r], [pre_l, pre_r]);
        }
        let [input_l, input_r] = input.channels();
        let [output_l, output_r] = output;
        // The sub-chunk to process this call (absolute quantum coords); the delay line state persists across
        // chunks, so slicing each sub-range advances it exactly once over the quantum.
        state.delay_dsp.process([&input_l[s0..s1], &input_r[s0..s1]], [&mut output_l[s0..s1], &mut output_r[s0..s1]], [delay_l, delay_r], [pre_l, pre_r]);
    }

    fn parameter_changed(state: &mut DelayState, id: u32, value: ParamValue) {
        let Some(index) = state.ids.iter().position(|bound| *bound == id) else {
            return;
        };
        let sample_rate = state.sample_rate;
        match index {
            param::PRE_SYNC_L => state.pre_sync_l = sync_index(value),
            param::PRE_MILLIS_L => state.pre_millis_l = millis_value(value),
            param::PRE_SYNC_R => state.pre_sync_r = sync_index(value),
            param::PRE_MILLIS_R => state.pre_millis_r = millis_value(value),
            param::DELAY_SYNC => state.delay_sync = sync_index(value),
            param::DELAY_MILLIS => state.delay_millis = millis_value(value),
            param::FEEDBACK => state.delay_dsp.feedback = float_value(value, &UNIPOLAR) as f64,
            param::CROSS => state.delay_dsp.cross = float_value(value, &UNIPOLAR) as f64,
            param::LFO_SPEED => state.delay_dsp.lfo_phase_incr = float_value(value, &LFO_SPEED_MAPPING) as f64 / sample_rate as f64,
            param::LFO_DEPTH => state.delay_dsp.lfo_depth = float_value(value, &LFO_DEPTH_MAPPING) as f64 * 0.001 * sample_rate as f64,
            param::FILTER => state.delay_dsp.set_filter(float_value(value, &BIPOLAR)),
            param::WET => state.delay_dsp.wet = db_to_gain(float_value(value, &VOLUME_MAPPING)) as f64,
            param::DRY => state.delay_dsp.dry = db_to_gain(float_value(value, &VOLUME_MAPPING)) as f64,
            _ => {}
        }
    }

    fn reset(state: &mut DelayState) {
        // Zero the four rate-sized delay lines (the main L/R + pre-delay L/R) out of the engine-allocated tail.
        let size = state.buffer_size;
        let tail = unsafe { core::slice::from_raw_parts_mut(state.tail.as_mut_ptr(), 4 * size) };
        let (delay_l, rest) = tail.split_at_mut(size);
        let (delay_r, rest) = rest.split_at_mut(size);
        let (pre_l, pre_r) = rest.split_at_mut(size);
        state.delay_dsp.reset([delay_l, delay_r], [pre_l, pre_r]);
    }
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

/// Bytes the engine must allocate (zeroed): the fixed header plus the four pow2 delay buffers, whose size
/// scales with the sample rate (the rate-sized tail).
#[no_mangle]
pub extern "C" fn state_size(sample_rate: f32) -> u32 {
    (core::mem::size_of::<DelayState>() + 4 * delay_size(sample_rate) * core::mem::size_of::<f32>()) as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<DelayState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Delay>(ports);
}

/// Boot hook: size the delay buffers from the sample rate, build the DSP, and bind the parameters.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Delay as AudioEffect>::init(state, sample_rate)) }
}

/// Transport STOP: zero the delay lines so the echo tail does not resume on the next playback.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Delay as AudioEffect>::reset(state)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Delay as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

//! Transparent audio-chain measurement device. Telemetry at append(0): [Hz, confidence, dBFS].
#![cfg_attr(target_family = "wasm", no_std)]
mod detector;
use abi::{AudioEffect, Block, ParamValue, Ports, float_value, int_value};
use math::value_mapping::{Linear, LinearInteger};
use detector::Detector;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {abi::panic_to_host(info)}

pub struct TunerState {
    detector: Detector,
    threshold: f32,
    channel: i32,
    threshold_id: u32,
    channel_id: u32,
    broadcast_id: u32,
}
pub struct TunerDevice;
impl AudioEffect for TunerDevice {
    type State = TunerState;
    fn init(state: &mut TunerState, sample_rate: f32) {
        state.detector.prepare(sample_rate);
        state.threshold = -55.0;
        state.channel = 0;
        state.threshold_id = abi::bind_parameter(&[11]);
        state.channel_id = abi::bind_parameter(&[12]);
        state.broadcast_id = abi::bind_broadcast(&[0], 3);
    }
    fn parameter_changed(state: &mut TunerState, id: u32, value: ParamValue) {
        if id == state.threshold_id {state.threshold = float_value(value, &Linear {min: -80.0, max: -20.0});}
        else if id == state.channel_id {
            state.channel = int_value(value, &LinearInteger {min: 0, max: 2});
            state.detector.reset();
        }
    }
    fn reset(state: &mut TunerState) {state.detector.reset();}
    fn process_audio(state: &mut TunerState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [left, right] = input.channels();
        let [out_left, out_right] = output;
        for index in block.s0 as usize..block.s1 as usize {
            out_left[index] = left[index];
            out_right[index] = right[index];
            state.detector.feed(left[index], right[index], state.channel, state.threshold);
        }
        let ptr = abi::broadcast_ptr(state.broadcast_id);
        if ptr != 0 {
            let values = unsafe {core::slice::from_raw_parts_mut(ptr as *mut f32, 3)};
            values.copy_from_slice(&[state.detector.frequency, state.detector.confidence, state.detector.level]);
        }
    }
}
#[no_mangle]
pub extern "C" fn kind() -> u32 {abi::DEVICE_KIND_AUDIO_EFFECT}
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {core::mem::size_of::<TunerState>() as u32}
#[no_mangle]
pub extern "C" fn init(ptr: u32, sample_rate: f32) {
    unsafe {abi::with_state(ptr, |state| TunerDevice::init(state, sample_rate))}
}
#[no_mangle]
pub extern "C" fn process(ptr: u32) {
    abi::render_effect::<TunerDevice>(unsafe {Ports::<TunerState>::from_descriptor(ptr)});
}
#[no_mangle]
pub extern "C" fn parameter_changed(ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe {abi::with_state(ptr, |state| TunerDevice::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation)))}
}
#[no_mangle]
pub extern "C" fn reset(ptr: u32) {unsafe {abi::with_state(ptr, TunerDevice::reset)}}

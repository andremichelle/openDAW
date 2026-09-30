//! The Wclap AUDIO-EFFECT device: a CLAP plugin compiled to wasm32, hosted as its own instance next to the
//! engine through the `host_wclap_*` JS bridge (see `packages/studio/core-wasm/src/wclap/wclap-bridge.ts`).
//! The shared field/bridge logic lives in `wclap-common`, the instrument twin is `device-wclap-instrument`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{AudioEffect, Block, FieldValue, ParamValue, Ports};
use wclap_common::WclapLink;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

pub struct WclapState {
    link: WclapLink
}

pub struct WclapDevice;

impl AudioEffect for WclapDevice {
    type State = WclapState;

    fn init(state: &mut WclapState, _sample_rate: f32) {
        state.link.init();
    }

    fn parameter_changed(_state: &mut WclapState, _id: u32, _value: ParamValue) {}

    fn reset(state: &mut WclapState) {
        state.link.reset();
    }

    fn process_audio(state: &mut WclapState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        state.link.process_effect(in_left, in_right, out_left, out_right, s0, s1);
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<WclapState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<WclapState>::from_descriptor(desc_ptr) };
    abi::render_effect::<WclapDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <WclapDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <WclapDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut WclapState| state.link.apply_field(id, FieldValue::from_wire(kind, bits, len)))
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <WclapDevice as AudioEffect>::reset) }
}

#[no_mangle]
pub extern "C" fn terminate(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut WclapState| state.link.release()) }
}

#[cfg(test)]
mod tests {
    use super::{WclapDevice, WclapState};
    use abi::AudioEffect;

    #[test]
    fn not_loaded_bridge_passes_the_input_through() {
        let mut state: WclapState = unsafe { core::mem::zeroed() };
        WclapDevice::init(&mut state, 48_000.0);
        let in_left: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();
        let in_right: Vec<f32> = (0..128).map(|i| (i as f32 * 0.07).cos()).collect();
        let (mut out_left, mut out_right) = (vec![0.0f32; 128], vec![0.0f32; 128]);
        state.link.process_effect(&in_left, &in_right, &mut out_left, &mut out_right, 32, 96);
        assert_eq!(&out_left[32..96], &in_left[32..96]);
        assert_eq!(&out_right[32..96], &in_right[32..96]);
        assert!(out_left[..32].iter().all(|&sample| sample == 0.0));
    }
}

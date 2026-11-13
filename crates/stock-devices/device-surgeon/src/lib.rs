//! `device-surgeon`, the engine core of Surgeon (see `plans/surgeon.md`): a monophonic FM voice played by a pitch
//! loop and four lanes that are all computed from the song position. Heap free and valid when zeroed.
//! `hit_envelope` and `svf` are copies of the openDrum dsp blocks until those land in `dsp`.

#![cfg_attr(target_family = "wasm", no_std)]

pub mod device;
pub mod engine;
pub mod hash;
pub mod hit_envelope;
pub mod param;
pub mod pattern;
pub mod svf;
pub mod voice;

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{FieldValue, Instrument, ParamValue, Ports};
use device::{Surgeon, SurgeonState};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<SurgeonState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<SurgeonState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Surgeon>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Surgeon as Instrument>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Surgeon as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    device::map(id, unit)
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Surgeon as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Surgeon as Instrument>::reset(state)) }
}

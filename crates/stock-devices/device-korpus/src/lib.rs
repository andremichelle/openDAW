//! Korpus, a physical-modelling INSTRUMENT device built from scratch: a modal resonator bank with
//! five material laws (marimba, vibraphone, bell, membrane, plate) and a dual-polarization plucked
//! string with a commuted synthetic body. Heap-free: per-instance state lives in the engine-assigned
//! state block; both engines use fixed arrays only.

#![cfg_attr(target_family = "wasm", no_std)]

pub mod device;
pub mod engine;
pub mod voice;

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<device::State>() as u32
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe {abi::Ports::<device::State>::from_descriptor(desc_ptr)};
    abi::render_instrument::<device::Device>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe {abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::init(state, sample_rate))}
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe {
        abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::parameter_changed(
            state, id, abi::ParamValue::from_wire(kind, value, modulation)))
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe {abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::reset(state))}
}

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    abi::panic_to_host(info)
}

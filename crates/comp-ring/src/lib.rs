//! Ring modulator: `out = in0 * in1 * gain`. Two inputs, separate output — the multi-input ABI.
//! Stateless DSP; safe Rust via the `abi` shim.

#![no_std]

use core::panic::PanicInfo;
use abi::Ports;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<u32>::from_descriptor(desc_ptr) };
    let gain = ports.params[0];
    let a = ports.inputs.get(0);
    let b = ports.inputs.get(1);
    for (index, sample) in ports.output.iter_mut().enumerate() {
        *sample = a[index] * b[index] * gain;
    }
}

#[no_mangle]
pub extern "C" fn probe() -> u32 {
    let marker: u32 = 0;
    (&marker as *const u32) as usize as u32
}

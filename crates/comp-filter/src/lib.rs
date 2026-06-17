//! In-place one-pole lowpass. Per-instance state (`y1`) lives in an engine-assigned block, so the
//! same module backs many instances. DSP is safe Rust via the `abi` shim. `probe` returns a stack
//! address so the harness can confirm this module's region is disjoint from the others.

#![cfg_attr(not(test), no_std)]

#[cfg(not(test))]
use core::panic::PanicInfo;
use abi::Ports;

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[repr(C)]
struct State {
    y1: f32,
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<State>::from_descriptor(desc_ptr) };
    let coeff = ports.params[0];
    let state = ports.state;
    for sample in ports.output.iter_mut() {
        state.y1 += coeff * (*sample - state.y1);
        *sample = state.y1;
    }
}

#[no_mangle]
pub extern "C" fn probe() -> u32 {
    let marker: u32 = 0;
    (&marker as *const u32) as usize as u32
}

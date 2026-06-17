//! Feedback delay whose delay line is **heap-allocated** (Rust's `alloc` crate via a custom bump
//! allocator living in this module's own region). Proves a device can use a real heap, that it
//! coexists with the other modules, and that each instance allocates its own line. The per-sample
//! DSP is safe Rust; the heap-line handle is reconstructed once per call from per-instance state.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

#[cfg(not(test))]
use core::alloc::{GlobalAlloc, Layout};
#[cfg(not(test))]
use core::panic::PanicInfo;
use core::slice;
use abi::Ports;
use alloc::vec;

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The custom allocator only exists in the wasm build; native `cargo test` uses std's allocator.
#[cfg(not(test))]
const HEAP_SIZE: usize = 1 << 20; // 1 MiB arena, in this module's relocated region
#[cfg(not(test))]
static mut HEAP: [u8; HEAP_SIZE] = [0; HEAP_SIZE];
#[cfg(not(test))]
static mut HEAP_POS: usize = 0;

#[cfg(not(test))]
struct Bump;

#[cfg(not(test))]
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let align = layout.align();
        let start = (HEAP_POS + align - 1) & !(align - 1);
        let end = start + layout.size();
        if end > HEAP_SIZE {
            return core::ptr::null_mut();
        }
        HEAP_POS = end;
        (&raw mut HEAP).cast::<u8>().add(start)
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[cfg(not(test))]
#[global_allocator]
static ALLOCATOR: Bump = Bump;

const LINE_LEN: usize = 512;

#[repr(C)]
struct State {
    initialized: u32,
    pos: u32,
    line_ptr: u32,
    line_len: u32,
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<State>::from_descriptor(desc_ptr) };
    let feedback = ports.params[0];
    let state = ports.state;
    if state.initialized == 0 {
        let line = vec![0.0f32; LINE_LEN]; // heap allocation via the custom allocator
        state.line_ptr = line.as_ptr() as usize as u32;
        state.line_len = line.len() as u32;
        state.pos = 0;
        state.initialized = 1;
        core::mem::forget(line); // bump heap never frees; keep the line alive across calls
    }
    let line = unsafe { slice::from_raw_parts_mut(state.line_ptr as *mut f32, state.line_len as usize) };
    let length = line.len();
    let mut position = state.pos as usize;
    for sample in ports.output.iter_mut() {
        let echoed = *sample + feedback * line[position];
        line[position] = echoed;
        *sample = echoed;
        position += 1;
        if position >= length {
            position = 0;
        }
    }
    state.pos = position as u32;
}

#[no_mangle]
pub extern "C" fn probe() -> u32 {
    let marker: u32 = 0;
    (&marker as *const u32) as usize as u32
}

/// Bytes allocated from this module's heap so far (for the harness to confirm the heap was used).
#[cfg(not(test))]
#[no_mangle]
pub extern "C" fn heap_used() -> u32 {
    unsafe { HEAP_POS as u32 }
}

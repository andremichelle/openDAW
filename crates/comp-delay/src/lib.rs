//! Feedback delay whose delay line is **heap-allocated** (Rust's `alloc` crate via a custom bump
//! allocator living in this module's own region). Proves a device can use a real heap, that it
//! coexists with the other modules, and that each instance allocates its own line. The per-sample
//! DSP is safe Rust; the heap-line handle is reconstructed once per call from per-instance state.

#![no_std]

extern crate alloc;

use core::alloc::{GlobalAlloc, Layout};
use core::panic::PanicInfo;
use core::slice;
use abi::Ports;
use alloc::vec;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const HEAP_SIZE: usize = 1 << 20; // 1 MiB arena, in this module's relocated region
static mut HEAP: [u8; HEAP_SIZE] = [0; HEAP_SIZE];
static mut HEAP_POS: usize = 0;

struct Bump;

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let align = layout.align();
        let start = (*(&raw const HEAP_POS) + align - 1) & !(align - 1);
        let end = start + layout.size();
        if end > HEAP_SIZE {
            return core::ptr::null_mut();
        }
        *(&raw mut HEAP_POS) = end;
        (&raw mut HEAP).cast::<u8>().add(start)
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

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
#[no_mangle]
pub extern "C" fn heap_used() -> u32 {
    unsafe { *(&raw const HEAP_POS) as u32 }
}

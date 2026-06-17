//! The WASM audio-engine module: a downstream `BoxGraph` mirror fed the live FORWARD-only sync
//! stream (`SyncSource` -> worklet/test bridge). JS copies the serialized `UpdateTask[]` into the
//! input buffer, calls `apply_updates(len)`, then reads the 32-byte checksum buffer to compare
//! against the TS source after every transaction.
//!
//! ALLOCATOR NOTE: uses a bump allocator that never frees — fine for bounded replay/tests, but a
//! continuously-running production engine needs a real reclaiming allocator. Flagged, not final.

#![cfg_attr(not(test), no_std)]
// The engine is a single-threaded wasm module; its graph/registry/buffers are process globals
// accessed only from the one worklet thread, so the static-mut references here are sound.
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::vec::Vec;
use boxgraph::boxes::Registry;
use boxgraph::bytes::ByteReader;
use boxgraph::graph::BoxGraph;
use boxgraph::updates::decode_forward;
use studio_boxes::registry;

const INPUT_CAPACITY: usize = 1 << 20; // 1 MiB scratch for one transaction's update bytes

static mut INPUT: [u8; INPUT_CAPACITY] = [0; INPUT_CAPACITY];
static mut CHECKSUM: [u8; 32] = [0; 32];
static mut GRAPH: Option<BoxGraph> = None;
static mut REGISTRY: Option<Registry> = None;

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    unsafe { INPUT.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn input_capacity() -> usize {
    INPUT_CAPACITY
}

#[no_mangle]
pub extern "C" fn checksum_ptr() -> *const u8 {
    unsafe { CHECKSUM.as_ptr() }
}

/// Reset to an empty graph (call before replaying a fresh session).
#[no_mangle]
pub extern "C" fn reset() {
    unsafe {
        GRAPH = Some(BoxGraph::from_boxes(Vec::new()));
        REGISTRY = Some(registry());
        CHECKSUM = [0; 32];
    }
}

/// Apply one forward-only transaction from the first `len` input bytes, then refresh the checksum
/// buffer. Returns 0 on success, 1 on a decode/apply error.
#[no_mangle]
pub extern "C" fn apply_updates(len: usize) -> i32 {
    unsafe {
        if GRAPH.is_none() {
            reset();
        }
        let graph = GRAPH.as_mut().unwrap();
        let registry = REGISTRY.as_ref().unwrap();
        let mut reader = ByteReader::new(&INPUT[..len]);
        let updates = match decode_forward(&mut reader) {
            Ok(updates) => updates,
            Err(_) => return 1
        };
        if graph.transaction(&updates, registry).is_err() {
            return 1;
        }
        CHECKSUM = graph.checksum();
        0
    }
}

#[cfg(not(test))]
mod runtime {
    use core::alloc::{GlobalAlloc, Layout};
    use core::ptr::null_mut;

    const HEAP_SIZE: usize = 64 << 20;
    static mut HEAP: [u8; HEAP_SIZE] = [0; HEAP_SIZE];
    static mut OFFSET: usize = 0;

    struct Bump;

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align();
            let start = (OFFSET + align - 1) & !(align - 1);
            let end = start + layout.size();
            if end > HEAP_SIZE {
                return null_mut();
            }
            OFFSET = end;
            HEAP.as_mut_ptr().add(start)
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    #[global_allocator]
    static ALLOCATOR: Bump = Bump;

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        loop {}
    }
}

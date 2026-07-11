//! The standalone analyzer wasm for the core-worker: one analysis pass (detect + describe) over
//! PCM, writing `stretch::TransientDescriptor` records (#[repr(C)], 64 bytes) — the SINGLE format
//! shared with the engine's SAB descriptor channel and the OPFS `markers.bin` cache. Runs in a
//! worker's own instance/memory — never the audio thread.

use stretch::{Analyzer, TransientDescriptor};

/// Allocate a buffer inside this module's memory (the worker copies PCM in, reads records out).
#[no_mangle]
pub extern "C" fn alloc_bytes(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    ptr
}

#[no_mangle]
pub extern "C" fn free_bytes(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) };
}

/// Analyze planar stereo PCM: writes up to `max_records` TransientDescriptors to `out_ptr`,
/// returns the count.
#[no_mangle]
pub extern "C" fn analyze(
    left_ptr: *const f32,
    right_ptr: *const f32,
    num_frames: usize,
    sample_rate: f32,
    out_ptr: *mut TransientDescriptor,
    max_records: usize
) -> usize {
    let left = unsafe { core::slice::from_raw_parts(left_ptr, num_frames) };
    let right = unsafe { core::slice::from_raw_parts(right_ptr, num_frames) };
    let analyzed = Analyzer::default().analyze(left, right, sample_rate);
    let count = analyzed.markers.len().min(max_records);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, count) };
    out.copy_from_slice(&analyzed.markers[..count]);
    count
}

/// Record size in bytes (layout guard for the JS side).
#[no_mangle]
pub extern "C" fn record_size() -> usize {
    core::mem::size_of::<TransientDescriptor>()
}

/// Format version for markers.bin / SAB records — bump to invalidate caches when the analyzer
/// changes behavior.
#[no_mangle]
pub extern "C" fn analyzer_version() -> u32 {
    1
}

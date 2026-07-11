//! The standalone analyzer wasm for the core-worker: one analysis pass (detect + describe) over
//! PCM, writing 64-byte marker records the engine's SAB channel and the OPFS `markers.bin` cache
//! share as their single binary format. Runs in a worker's own instance/memory — never the
//! audio thread. std build: normal allocator, no engine ABI coupling.

use stretch::Analyzer;

/// One marker record, the shared wire/cache format (64 bytes, little-endian, layout-stable).
#[repr(C)]
pub struct MarkerRecord {
    pub position: f64,
    pub loop_start: f64,
    pub loop_end: f64,
    pub strength: f32,
    pub period: f32,
    pub harmonicity: f32,
    pub rms: f32,
    pub loop_score: f32,
    pub beat_seconds: f32,
    pub loop_rms: f32,
    pub reserved: f32
}

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

/// Analyze planar stereo PCM: writes up to `max_records` MarkerRecords to `out_ptr`, returns the
/// count. `left_ptr`/`right_ptr` are f32 planes of `num_frames` each.
#[no_mangle]
pub extern "C" fn analyze(
    left_ptr: *const f32,
    right_ptr: *const f32,
    num_frames: usize,
    sample_rate: f32,
    out_ptr: *mut MarkerRecord,
    max_records: usize
) -> usize {
    let left = unsafe { core::slice::from_raw_parts(left_ptr, num_frames) };
    let right = unsafe { core::slice::from_raw_parts(right_ptr, num_frames) };
    let analyzed = Analyzer::default().analyze(left, right, sample_rate);
    let count = analyzed.markers.len().min(max_records);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, count) };
    for (record, marker) in out.iter_mut().zip(analyzed.markers.iter()) {
        *record = MarkerRecord {
            position: marker.position,
            loop_start: marker.loop_start,
            loop_end: marker.loop_end,
            strength: marker.strength,
            period: marker.period,
            harmonicity: marker.harmonicity,
            rms: marker.rms,
            loop_score: marker.loop_score,
            beat_seconds: marker.beat_seconds,
            loop_rms: marker.loop_rms,
            reserved: 0.0
        };
    }
    count
}

/// Format version for markers.bin / SAB records — bump to invalidate caches when the analyzer
/// changes behavior.
#[no_mangle]
pub extern "C" fn analyzer_version() -> u32 {
    1
}

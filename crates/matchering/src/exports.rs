// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

// WASM CONTRACT: packages/studio/matchering/src/MatcheringWasm.ts mirrors these exports and layouts.
use crate::analysis::{analyse_reference as analyse, match_target as matching, Error, MatchResult, ReferenceProfile,
                      Stage};
use crate::config::{BINS, CURVE_LIMIT_DB};

pub const PROFILE_LENGTH: usize = 2 + 2 * BINS;
pub const RESULT_LENGTH: usize = 2 + 2 * BINS;

#[link(wasm_import_module = "env")]
extern "C" {
    fn progress(stage: u32);
}

fn status(error: Error) -> i32 {
    match error {
        Error::TooShort => 1,
        Error::TooLong => 2,
        Error::LengthMismatch => 3
    }
}

#[no_mangle]
pub extern "C" fn alloc_bytes(length: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(length);
    let pointer = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub extern "C" fn free_bytes(pointer: *mut u8, length: usize) {
    unsafe { drop(Vec::from_raw_parts(pointer, 0, length)) };
}

#[no_mangle]
pub extern "C" fn bins() -> usize {BINS}

fn write_profile(profile: &ReferenceProfile, output: *mut f64) {
    let output = unsafe {core::slice::from_raw_parts_mut(output, PROFILE_LENGTH)};
    output[0] = profile.match_rms;
    output[1] = profile.final_amplitude;
    output[2..2 + BINS].copy_from_slice(&profile.mid_spectrum);
    output[2 + BINS..].copy_from_slice(&profile.side_spectrum);
}

#[no_mangle]
pub extern "C" fn builtin_profile_count() -> usize {crate::profiles::COUNT}

/// Writes the built-in profile `index` in the profile layout below.
#[no_mangle]
pub extern "C" fn builtin_profile(index: usize, output: *mut f64) {write_profile(&crate::profiles::builtin(index), output)}

/// Writes PROFILE_LENGTH f64: match_rms, final_amplitude, mid spectrum, side spectrum. Returns 0 or an error status.
#[no_mangle]
pub extern "C" fn analyse_reference(left: *const f32, right: *const f32, frames: usize, output: *mut f64) -> i32 {
    let (left, right) = unsafe {(core::slice::from_raw_parts(left, frames), core::slice::from_raw_parts(right, frames))};
    match analyse(left, right) {
        Ok(profile) => {
            write_profile(&profile, output);
            0
        }
        Err(error) => status(error)
    }
}

/// Reads a profile in the layout above, writes RESULT_LENGTH f64: gain, final_amplitude, mid curve, side curve.
#[no_mangle]
pub extern "C" fn match_target(left: *const f32, right: *const f32, frames: usize, profile: *const f64,
                               output: *mut f64) -> i32 {
    let (left, right) = unsafe {(core::slice::from_raw_parts(left, frames), core::slice::from_raw_parts(right, frames))};
    let profile = unsafe {core::slice::from_raw_parts(profile, PROFILE_LENGTH)};
    let profile = ReferenceProfile {
        match_rms: profile[0],
        final_amplitude: profile[1],
        mid_spectrum: profile[2..2 + BINS].to_vec(),
        side_spectrum: profile[2 + BINS..].to_vec()
    };
    let mut report = |stage: Stage| unsafe {progress(stage as u32)};
    match matching(left, right, &profile, Some(CURVE_LIMIT_DB), &mut report) {
        Ok(MatchResult {gain, final_amplitude, mid_curve, side_curve}) => {
            let output = unsafe {core::slice::from_raw_parts_mut(output, RESULT_LENGTH)};
            output[0] = gain;
            output[1] = final_amplitude;
            output[2..2 + BINS].copy_from_slice(&mid_curve);
            output[2 + BINS..].copy_from_slice(&side_curve);
            0
        }
        Err(error) => status(error)
    }
}

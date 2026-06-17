//! The device boundary shim — the ONE place that holds `unsafe` in the device path. It turns the
//! host-assigned shared-memory descriptor (raw byte offsets) into safe Rust slices and typed state,
//! so device DSP code is written entirely in safe Rust.
//!
//! Canonical descriptor (u32 words); every offset is a byte address into the shared linear memory:
//!   [0] frames
//!   [1] in_count     [2] in_offsets_ptr   (-> u32[in_count],  each -> f32[frames])
//!   [3] out_count    [4] out_offsets_ptr  (-> u32[out_count], each -> f32[frames])
//!   [5] param_count  [6] params_ptr       (-> f32[param_count])
//!   [7] state_ptr    (-> device instance state)

#![no_std]

use core::ptr::NonNull;
use core::slice;

/// Read-only view over a device's input ports.
#[derive(Clone, Copy)]
pub struct Inputs<'a> {
    offsets: &'a [u32],
    frames: usize,
}

impl<'a> Inputs<'a> {
    #[inline]
    pub fn len(&self) -> usize { self.offsets.len() }

    #[inline]
    pub fn is_empty(&self) -> bool { self.offsets.is_empty() }

    /// The `index`-th input buffer as a safe slice (`frames` samples).
    #[inline]
    pub fn get(&self, index: usize) -> &'a [f32] {
        let offset = self.offsets[index];
        unsafe { slice::from_raw_parts(offset as *const f32, self.frames) }
    }
}

/// Everything a device needs for one `process` call, as safe references. Built once by
/// [`Ports::from_descriptor`]; device code touches only these fields and never writes `unsafe`.
pub struct Ports<'a, S> {
    pub frames: usize,
    pub inputs: Inputs<'a>,
    pub output: &'a mut [f32],
    pub params: &'a [f32],
    pub state: &'a mut S,
}

impl<'a, S> Ports<'a, S> {
    /// Parse a canonical descriptor into safe views.
    ///
    /// # Safety
    /// `desc_ptr` must reference a valid descriptor whose offsets describe live, mutually
    /// non-aliasing f32 buffers of `frames` samples and a state block of at least `size_of::<S>()`,
    /// all in this module's shared linear memory. The engine guarantees this when it assembles the
    /// descriptor; nothing else may call it.
    #[inline]
    pub unsafe fn from_descriptor(desc_ptr: u32) -> Self {
        let desc = desc_ptr as *const u32;
        let frames = *desc.add(0) as usize;
        let in_count = *desc.add(1) as usize;
        let in_offsets_ptr = *desc.add(2) as *const u32;
        let out_count = *desc.add(3) as usize;
        let out_offsets_ptr = *desc.add(4) as *const u32;
        let param_count = *desc.add(5) as usize;
        let params_ptr = *desc.add(6) as *const f32;
        let state_ptr = *desc.add(7) as *mut S;
        let in_offsets = if in_count == 0 {
            slice::from_raw_parts(NonNull::<u32>::dangling().as_ptr(), 0)
        } else {
            slice::from_raw_parts(in_offsets_ptr, in_count)
        };
        let output = if out_count == 0 {
            slice::from_raw_parts_mut(NonNull::<f32>::dangling().as_ptr(), 0)
        } else {
            slice::from_raw_parts_mut(*out_offsets_ptr as *mut f32, frames)
        };
        let params = if param_count == 0 {
            slice::from_raw_parts(NonNull::<f32>::dangling().as_ptr(), 0)
        } else {
            slice::from_raw_parts(params_ptr, param_count)
        };
        Self {
            frames,
            inputs: Inputs {offsets: in_offsets, frames},
            output,
            params,
            state: &mut *state_ptr,
        }
    }
}

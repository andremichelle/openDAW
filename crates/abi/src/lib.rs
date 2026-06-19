//! The device boundary shim — the ONE place that holds `unsafe` in the device path. It turns the
//! host-assigned shared-memory descriptor (raw byte offsets) into safe Rust slices and typed state,
//! so device DSP code is written entirely in safe Rust.
//!
//! Canonical descriptor (u32 words); every offset is a byte address into the shared linear memory:
//!   [0]  frames
//!   [1]  in_count       [2]  in_offsets_ptr   (-> u32[in_count],  each -> f32[frames])
//!   [3]  out_count      [4]  out_offsets_ptr  (-> u32[out_count], each -> f32[frames])
//!   [5]  param_count    [6]  params_ptr       (-> f32[param_count])
//!   [7]  state_ptr      (-> device instance state)
//!   [8]  in_event_cap   [9]  in_events_ptr    (-> EventRecord[in_event_cap]; a device-owned SCRATCH the
//!                                              device's `host_pull_events` pull WRITES into, NOT pre-filled)
//!   [10] out_event_cap  [11] out_events_ptr   (-> EventRecord[out_event_cap]; a MIDI-fx pull RESPONSE
//!                                              buffer, event-output devices only; 0 for instruments/effects)
//!   [12] block_count    [13] blocks_ptr       (-> BlockRecord[block_count]; the quantum's ProcessInfo)
//!   [14] sample_rate (f32 bits)               (the engine's render sample rate; passed in, never a global)
//!
//! The engine no longer PUSHES a resolved event array. A device PULLS its own input event stream for a
//! pulse range through the `host_pull_events` host import (bound to the engine's export by the loader),
//! into its `[8]/[9]` scratch, and times its own sub-blocks over the `[12]/[13]` blocks.

#![cfg_attr(not(test), no_std)]

use core::ptr::NonNull;
use core::slice;

/// One timed note event the host hands an instrument for the current block, already resolved to a
/// sample `offset` within `[0, frames)`. CLAP-shaped: a flat, `#[repr(C)]` record read straight from
/// shared memory (no heap). `kind` is `EVENT_NOTE_ON` / `EVENT_NOTE_OFF`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EventRecord {
    pub offset: u32,
    pub kind: u32,
    pub id: u32,
    pub pitch: u32,
    pub velocity: f32,
    pub cent: f32
}

pub const EVENT_NOTE_ON: u32 = 0;
pub const EVENT_NOTE_OFF: u32 = 1;

/// One render block of the quantum's `ProcessInfo` (mirrors `engine-env::Block`): a pulse range
/// `[p0, p1)` mapped to the sample range `[s0, s1)` at `bpm`, with transport `flags`. A flat,
/// `#[repr(C)]` record both the host (engine) and the device read from shared memory. Field ORDER is
/// chosen so the two `u32`s precede the `f64`s: `p0`/`p1` stay 8-aligned with no implicit padding, so
/// the layout is identical and explicit on both sides. The device pulls each block's events with
/// `pull_events(p0, p1, flags, ...)` and may honour `[s0, s1)` for sub-block timing or ignore it.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BlockRecord {
    pub index: u32,
    pub flags: u32,
    pub p0: f64,
    pub p1: f64,
    pub s0: u32,
    pub s1: u32,
    pub bpm: f32,
    pub reserved: u32
}

// The host resolves this device's input note/param events for a pulse range on demand (Route A pull).
// The device imports it from `env`; the worklet loader binds it to the engine's `host_pull_events`
// export, so the call is wasm-to-wasm. It writes resolved `EventRecord`s into the device's scratch and
// returns the count written (capped at `max`).
#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn host_pull_events(from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32;
}

/// Pull this device's resolved input events for the pulse range `[from, to)` into `out`, returning the
/// number written (offsets are absolute within the quantum, lifecycle-sorted). On native builds there is
/// no host, so the stub returns 0 (native device tests drive `render` directly, never `process`).
#[inline]
pub fn pull_events(from: f64, to: f64, flags: u32, out: &mut [EventRecord]) -> usize {
    #[cfg(target_family = "wasm")]
    { unsafe { host_pull_events(from, to, flags, out.as_mut_ptr() as u32, out.len() as u32) as usize } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (from, to, flags, out.len()); 0 }
}

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
    /// The quantum's render blocks (the `ProcessInfo`). The device pulls each block's events and may
    /// fragment `[s0, s1)` at the offsets, or process the whole quantum and ignore the blocks.
    pub blocks: &'a [BlockRecord],
    /// A device-owned scratch the device PULLS its input events into (via [`pull_events`]); not
    /// pre-filled by the host. `len()` is the capacity. Empty when the descriptor declares no scratch.
    pub event_scratch: &'a mut [EventRecord],
    /// The engine's render sample rate. Passed in via the descriptor, so devices never hold it as a
    /// global; the host sets it from the audio context.
    pub sample_rate: f32,
}

impl<'a, S> Ports<'a, S> {
    /// Parse a canonical descriptor into safe views. `event_scratch` is the device-owned pull buffer
    /// (empty when the descriptor declares `in_event_cap == 0`); `blocks` is the quantum's block array.
    ///
    /// # Safety
    /// `desc_ptr` must reference a valid descriptor whose offsets describe live, mutually
    /// non-aliasing f32 buffers of `frames` samples, a state block of at least `size_of::<S>()`,
    /// `in_event_cap` writable `EventRecord` slots, and `block_count` valid `BlockRecord`s — all in this
    /// module's shared linear memory. The engine guarantees this when it assembles the descriptor;
    /// nothing else may call it.
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
        let in_event_cap = *desc.add(8) as usize;
        let in_events_ptr = *desc.add(9) as *mut EventRecord;
        // [10] out_event_cap / [11] out_events_ptr: event-output devices (MIDI fx, phase 4); unused here.
        let block_count = *desc.add(12) as usize;
        let blocks_ptr = *desc.add(13) as *const BlockRecord;
        let sample_rate = f32::from_bits(*desc.add(14));
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
        let event_scratch = if in_event_cap == 0 {
            slice::from_raw_parts_mut(NonNull::<EventRecord>::dangling().as_ptr(), 0)
        } else {
            slice::from_raw_parts_mut(in_events_ptr, in_event_cap)
        };
        let blocks = if block_count == 0 {
            slice::from_raw_parts(NonNull::<BlockRecord>::dangling().as_ptr(), 0)
        } else {
            slice::from_raw_parts(blocks_ptr, block_count)
        };
        Self {
            frames,
            inputs: Inputs {offsets: in_offsets, frames},
            output,
            params,
            state: &mut *state_ptr,
            blocks,
            event_scratch,
            sample_rate,
        }
    }
}

/// The device-SDK template for an AUDIO instrument (the TS `AudioProcessor` / `NoteEventInstrument`
/// analog). A device implements this and calls [`render_instrument`] from its `process` export; the SDK
/// owns the event pull, the fragment-at-offsets timing, and the dispatch, so a device author writes only
/// the DSP: render active state into a sub-chunk (`process_audio`), apply one note event at its offset
/// (`handle_event`), and an optional once-per-quantum post-pass (`finish`, e.g. reclaim idle voices or
/// run a delay). `State` is the device's instance state, interpreted from the engine-allocated block.
pub trait Instrument {
    type State;
    /// Render the active state additively into `output` for one inter-event sub-chunk.
    fn process_audio(state: &mut Self::State, output: &mut [f32], sample_rate: f32);
    /// Apply one note event (on / off) at its sample offset.
    fn handle_event(state: &mut Self::State, event: &EventRecord, sample_rate: f32);
    /// Once per quantum, after all blocks. Default: nothing.
    fn finish(state: &mut Self::State, output: &mut [f32], sample_rate: f32) {
        let _ = (state, output, sample_rate);
    }
}

/// Fragment `output` at the (offset-sorted, output-relative) `events` and dispatch: `process_audio` for
/// each chunk between events, `handle_event` at each offset. Host-independent (events are supplied), so a
/// device's DSP is unit-testable without the engine. Does not clear `output` or run `finish`.
#[inline]
pub fn dispatch_range<I: Instrument>(state: &mut I::State, output: &mut [f32], events: &[EventRecord], sample_rate: f32) {
    let frames = output.len();
    let mut cursor = 0;
    for event in events {
        let offset = (event.offset as usize).min(frames);
        if offset > cursor {
            I::process_audio(state, &mut output[cursor..offset], sample_rate);
            cursor = offset;
        }
        I::handle_event(state, event, sample_rate);
    }
    if cursor < frames {
        I::process_audio(state, &mut output[cursor..frames], sample_rate);
    }
}

/// The full per-quantum instrument path a device calls from `process`: clear the output, PULL each
/// block's events into the scratch (Route A), dispatch the whole quantum (block offsets do not overlap
/// and the host lifecycle-sorts each block, so the accumulated run is already offset-ordered), then run
/// the once-per-quantum `finish`.
pub fn render_instrument<I: Instrument>(ports: Ports<I::State>) {
    let sample_rate = ports.sample_rate;
    for sample in ports.output.iter_mut() {
        *sample = 0.0;
    }
    let mut count = 0;
    for block in ports.blocks {
        if count >= ports.event_scratch.len() {
            break;
        }
        count += pull_events(block.p0, block.p1, block.flags, &mut ports.event_scratch[count..]);
    }
    dispatch_range::<I>(ports.state, ports.output, &ports.event_scratch[..count], sample_rate);
    I::finish(ports.state, ports.output, sample_rate);
}

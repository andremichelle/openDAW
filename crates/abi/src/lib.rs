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
//!   [12] block_count    [13] blocks_ptr       (-> Block[block_count]; the quantum's ProcessInfo)
//!   [14] sample_rate (f32 bits)               (the engine's render sample rate; passed in, never a global)
//!
//! The engine no longer PUSHES a resolved event array. A device PULLS its own input event stream for a
//! pulse range through the `host_pull_events` host import (bound to the engine's export by the loader),
//! into its `[8]/[9]` scratch, and times its own sub-blocks over the `[12]/[13]` blocks.

#![cfg_attr(not(test), no_std)]

use core::ptr::NonNull;
use core::slice;

/// One timed note event. CLAP-shaped: a flat, `#[repr(C)]` record read straight from shared memory (no
/// heap). `kind` is `EVENT_NOTE_ON` / `EVENT_NOTE_OFF`. It carries TWO time fields: `position` is the
/// pulse position, the currency the MIDI-fx pull chain works in (a groove device warps it, the host
/// resolves the chain in pulses); `offset` is the sample offset within `[0, frames)`, which the CONSUMER
/// (an instrument's `render_instrument`) fills from `position` for its DSP. MIDI fx read/write `position`
/// and leave `offset` to the consumer. `position` first so the `f64` is 8-aligned with no padding.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EventRecord {
    pub position: f64,
    pub offset: u32,
    pub kind: u32,
    pub id: u32,
    pub pitch: u32,
    pub velocity: f32,
    pub cent: f32
}

pub const EVENT_NOTE_ON: u32 = 0;
pub const EVENT_NOTE_OFF: u32 = 1;
/// A parameter-automation update (Route D): clock-driven, merged into the pulled stream. `pitch` carries
/// the parameter index, `velocity` the new value. At an equal position the device-SDK applies it between
/// note-off and note-on (see the engine's event ordering), so a note starting there sees the new value.
pub const EVENT_PARAM: u32 = 2;

/// What a device IS, so the host knows how to wire it into the graph (it reads this from the device's
/// `kind` export at load). An instrument voices notes into audio; an effect transforms an input buffer; a
/// MIDI effect is a pull source that transforms an upstream event stream (no audio, exports
/// `process_events` instead of `process`).
pub const DEVICE_KIND_INSTRUMENT: u32 = 0;
pub const DEVICE_KIND_AUDIO_EFFECT: u32 = 1;
pub const DEVICE_KIND_MIDI_EFFECT: u32 = 2;

// WASM CONTRACT: pulses-per-quarter-note, mirror of lib-dsp (PPQN = 960). Devices doing musical timing
// (tempo-synced LFOs, arpeggiator rates) convert pulses with it.
pub const PPQN_QUARTER: f64 = 960.0;

/// Per-block transport flags (`BlockFlag` in TS, core-processors `processing.ts`), shared by the host and
/// devices. State flags (`TRANSPORTING`, `PLAYING`) persist across a block's sub-chunks; event flags
/// (`DISCONTINUOUS`, `BPM_CHANGED`) are one-shot, cleared after the first chunk via `EVENT_MASK`.
/// `#[repr(transparent)]` so it is layout-identical to a `u32`: it is the `Block.flags` wire field AND
/// carries the host's flag helpers. `DISCONTINUOUS` marks a transport jump (loop wrap / seek), the cue for
/// a stateful device to release what it holds.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlockFlags(pub u32);

impl BlockFlags {
    pub const TRANSPORTING: u32 = 1 << 0;
    pub const DISCONTINUOUS: u32 = 1 << 1;
    pub const PLAYING: u32 = 1 << 2;
    pub const BPM_CHANGED: u32 = 1 << 3;
    pub const EVENT_MASK: u32 = Self::DISCONTINUOUS | Self::BPM_CHANGED;

    /// Mirror of TS `BlockFlags.create`.
    pub fn create(transporting: bool, discontinuous: bool, playing: bool, bpm_changed: bool) -> Self {
        let mut bits = 0;
        if transporting { bits |= Self::TRANSPORTING; }
        if discontinuous { bits |= Self::DISCONTINUOUS; }
        if playing { bits |= Self::PLAYING; }
        if bpm_changed { bits |= Self::BPM_CHANGED; }
        Self(bits)
    }

    /// True when every bit of `mask` is set (TS `Bits.every`).
    pub fn has(self, mask: u32) -> bool {
        self.0 & mask == mask
    }

    pub fn transporting(self) -> bool {
        self.has(Self::TRANSPORTING)
    }

    pub fn playing(self) -> bool {
        self.has(Self::PLAYING)
    }

    pub fn discontinuous(self) -> bool {
        self.has(Self::DISCONTINUOUS)
    }

    pub fn bpm_changed(self) -> bool {
        self.has(Self::BPM_CHANGED)
    }

    /// Clear the one-shot event flags after the first chunk (TS `flags &= ~eventMask`).
    pub fn clear_event_flags(&mut self) {
        self.0 &= !Self::EVENT_MASK;
    }
}

/// One render block of the quantum's `ProcessInfo`: a pulse range `[p0, p1)` mapped to the sample range
/// `[s0, s1)` at `bpm`, with transport `flags`. The ONE block type shared by the host (engine processors)
/// and devices, read straight from shared memory. `#[repr(C)]` with the two leading `u32`s before the
/// `f64`s so `p0`/`p1` stay 8-aligned (no implicit padding mid-struct); `s0`/`s1` are sample indices as
/// `u32` (the host casts to `usize` to slice). A device pulls each block's events with
/// `pull_events(p0, p1, flags, ...)` and may honour `[s0, s1)` for sub-block timing or ignore it.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Block {
    pub index: u32,
    pub flags: BlockFlags,
    pub p0: f64,
    pub p1: f64,
    pub s0: u32,
    pub s1: u32,
    pub bpm: f32
}

// The host resolves this device's input note/param events for a pulse range on demand (Route A pull).
// The device imports it from `env`; the worklet loader binds it to the engine's `host_pull_events`
// export, so the call is wasm-to-wasm. It writes resolved `EventRecord`s into the device's scratch and
// returns the count written (capped at `max`).
#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn host_pull_events(from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32;
    fn host_pulse_to_offset(pulse: f64) -> u32;
    fn host_bind_parameter(path_ptr: u32, path_len: u32) -> u32;
    fn host_update_parameters(position: f64, out_ptr: u32, max: u32) -> u32;
    fn host_first_update_position(at: f64) -> f64;
    fn host_next_update_position(after: f64) -> f64;
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

/// Map a pulse position to its sample offset within the current quantum (the host resolves it against the
/// block containing `pulse`). A generative device (e.g. an arpeggiator placing notes on a rate grid) uses
/// this to time the events it emits. Native stub returns 0.
#[inline]
pub fn pulse_to_offset(pulse: f64) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_pulse_to_offset(pulse) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = pulse; 0 }
}

/// The kind tag carried beside a [`ParamChange`]'s `value`, telling the SDK how to read that one f32: `UNIT`
/// is the uniform `0..1` automation value to MAP; `INT`/`FLOAT`/`BOOL` are a box field's already-real value of
/// that primitive type (a UI edit / un-automated default), the f32 carrying it losslessly for any realistic
/// parameter. The SDK turns `(kind, value)` into a typed [`ParamValue`], so devices never inspect the tag.
pub const PARAM_KIND_UNIT: u32 = 0;
pub const PARAM_KIND_INT: u32 = 1;
pub const PARAM_KIND_FLOAT: u32 = 2;
pub const PARAM_KIND_BOOL: u32 = 3;

/// One resolved parameter change the host hands back from [`update_parameters`]: the parameter's `id` (the
/// value [`bind_parameter`] returned), a `kind` tag (`PARAM_KIND_*`), and the new `value` as a single f32. The
/// SDK decodes `(kind, value)` into a typed [`ParamValue`]. `#[repr(C)]` so the host writes it straight into
/// the scratch; the two `u32`s precede the f32 and everything is 4-aligned with no padding.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ParamChange {
    pub id: u32,
    pub kind: u32,
    pub value: f32
}

/// A parameter value handed to a device's `parameter_changed`, ALREADY TYPED so device code never casts or
/// reads a raw tag. The analog of lib-std's typed `ValueMapping<Y>` outputs: `Unit` is the uniform `0..1`
/// automation value the device maps with its OWN mapping; `Int` / `Float` / `Bool` are a box field's
/// already-real value (a UI edit / un-automated default) to use directly. The SDK builds this from a
/// [`ParamChange`]'s wire `(kind, value)` via [`ParamValue::from_wire`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamValue {
    Unit(f32),
    Int(i32),
    Float(f32),
    Bool(bool)
}

impl ParamValue {
    /// Decode the wire `(kind, value)` into a typed value. The ONE numeric conversion of an f32-carried real
    /// value to its primitive type lives here, once, so device code stays cast-free. Panics on an unknown
    /// kind: the engine and SDK are the only writers, so that can only be a contract drift, never live input.
    #[inline]
    pub fn from_wire(kind: u32, value: f32) -> Self {
        match kind {
            PARAM_KIND_UNIT => ParamValue::Unit(value),
            PARAM_KIND_INT => ParamValue::Int(value as i32),
            PARAM_KIND_FLOAT => ParamValue::Float(value),
            PARAM_KIND_BOOL => ParamValue::Bool(value != 0.0),
            _ => panic!("unknown parameter kind")
        }
    }
}

/// Register one of THIS device's parameters with the host by its stable FIELD-KEY PATH on the device box
/// (`path`) — e.g. `[16, 10]` for `lowPass.frequency`, the same keys the box schema uses (no encoding).
/// Returns an opaque `id` the device keeps and matches in `parameter_changed`. A device calls this from its
/// `init` hook, once per parameter; the host then observes that field's value and any automation track. The
/// host stays mapping-agnostic — the device maps the uniform automation value itself. Native stub returns 0.
#[inline]
pub fn bind_parameter(path: &[u16]) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_bind_parameter(path.as_ptr() as u32, path.len() as u32) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = path; 0 }
}

/// Pull THIS device's parameters that CHANGED at pulse `position` into `out` (the host resolves each — its
/// automation curve, else its field value — and diffs against the last value it handed out), returning the
/// number written. The device applies each via its `parameter_changed`. Called by the SDK on a clock event.
/// Native stub returns 0.
#[inline]
pub fn update_parameters(position: f64, out: &mut [ParamChange]) -> usize {
    #[cfg(target_family = "wasm")]
    { unsafe { host_update_parameters(position, out.as_mut_ptr() as u32, out.len() as u32) as usize } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (position, out.len()); 0 }
}

/// The FIRST update position at or AFTER `at` (INCLUSIVE) — the seed for a fragment loop, mirroring TS
/// `Fragmentor`'s `ceil(p0 / rate)` so a grid point exactly on a block's start fires (otherwise the first
/// update is dropped). The loop then ADVANCES with the strict [`next_update_position`]. Returns `INFINITY`
/// when THIS device has no automated parameter (the loop never splits). Native stub returns `INFINITY`.
#[inline]
pub fn first_update_position(at: f64) -> f64 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_first_update_position(at) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = at; f64::INFINITY }
}

/// The next parameter-update position STRICTLY after `after`, per the engine's update-clock policy (a fixed
/// grid today, tempo-aware later) — the single place that owns the rate. Strict so a fragment loop advancing
/// `position = next_update_position(position)` always moves forward (the seed comes from the inclusive
/// [`first_update_position`]). Returns `INFINITY` when THIS device has no automated parameter, so the loop
/// stops. A device's render template walks these to fragment its work; it never computes a grid itself.
/// Native stub returns `INFINITY` (no fragmentation off-engine).
#[inline]
pub fn next_update_position(after: f64) -> f64 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_next_update_position(after) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = after; f64::INFINITY }
}

/// The most parameter changes [`update_parameters`] returns per call (a device's whole param set, comfortably).
const MAX_PARAM_CHANGES: usize = 32;

/// Pull the parameters changed at `position` and apply each through `apply` (the device's `parameter_changed`),
/// passing whether the value is the uniform automation value (to map) or an already-real value (to use).
/// The scratch is on the stack, so no device-global buffer.
#[inline]
fn apply_param_changes<S>(state: &mut S, position: f64, apply: fn(&mut S, u32, ParamValue)) {
    let mut changes = [ParamChange {id: 0, kind: 0, value: 0.0}; MAX_PARAM_CHANGES];
    let count = update_parameters(position, &mut changes);
    for change in &changes[..count] {
        apply(state, change.id, ParamValue::from_wire(change.kind, change.value));
    }
}

/// Run `body` with the device's typed state, parsed from the raw `state_ptr` the host passes to the `init`
/// and `parameter_changed` exports. The one `unsafe` deref, kept here in the ABI shim.
///
/// # Safety
/// `state_ptr` must point at a live, uniquely-borrowed `S` (the engine's per-instance state block); nothing
/// else may alias it for the call. The engine guarantees this (it calls these exports outside `process`).
#[inline]
pub unsafe fn with_state<S>(state_ptr: u32, body: impl FnOnce(&mut S)) {
    body(&mut *(state_ptr as *mut S))
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
    pub blocks: &'a [Block],
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
    /// `in_event_cap` writable `EventRecord` slots, and `block_count` valid `Block`s — all in this
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
        let blocks_ptr = *desc.add(13) as *const Block;
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
            slice::from_raw_parts(NonNull::<Block>::dangling().as_ptr(), 0)
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
    /// Render the active state additively into `output` for one inter-event sub-chunk. The sample rate is the
    /// device's own (it stashed `Ports::sample_rate` in `state`), never a per-call argument.
    fn process_audio(state: &mut Self::State, output: &mut [f32]);
    /// Apply one note event (on / off) at its sample offset.
    fn handle_event(state: &mut Self::State, event: &EventRecord);
    /// Register this device's automatable parameters with the host via [`bind_parameter`], stashing the
    /// returned ids in `state`. Called once when the device is wired. Default: nothing (no params).
    fn init(state: &mut Self::State) {
        let _ = state;
    }
    /// Apply a parameter's new typed `value` for `id` (the value `bind_parameter` returned), storing it in
    /// `state`. `value` is a [`ParamValue`]: `Unit` is the uniform `0..1` automation value to MAP to the
    /// parameter's range; `Int` / `Float` / `Bool` are a box field's already-real value to use directly. Called
    /// for the initial value, on edits, and on automation. Default: nothing (no params).
    fn parameter_changed(state: &mut Self::State, id: u32, value: ParamValue) {
        let _ = (state, id, value);
    }
    /// Once per quantum, after all blocks. Default: nothing.
    fn finish(state: &mut Self::State, output: &mut [f32]) {
        let _ = (state, output);
    }
}

/// Fragment `output` at the (offset-sorted, output-relative) `events` and dispatch: `process_audio` for
/// each chunk between events, `handle_event` at each offset. Host-independent (events are supplied), so a
/// device's DSP is unit-testable without the engine. Does not clear `output` or run `finish`.
#[inline]
pub fn dispatch_range<I: Instrument>(state: &mut I::State, output: &mut [f32], events: &[EventRecord]) {
    let frames = output.len();
    let mut cursor = 0;
    for event in events {
        let offset = (event.offset as usize).min(frames);
        if offset > cursor {
            I::process_audio(state, &mut output[cursor..offset]);
            cursor = offset;
        }
        // A clock event (Route D) pulls the parameters changed at this position; a note event voices.
        if event.kind == EVENT_PARAM {
            apply_param_changes::<I::State>(state, event.position, I::parameter_changed);
        } else {
            I::handle_event(state, event);
        }
    }
    if cursor < frames {
        I::process_audio(state, &mut output[cursor..frames]);
    }
}

/// Order resolved records for `dispatch_range`: by sample offset, then at an equal offset note-off ->
/// param-update -> note-on, so a note starting at an update position sees the refreshed parameter.
fn record_rank(kind: u32) -> u8 {
    match kind {
        EVENT_NOTE_OFF => 0,
        EVENT_PARAM => 1,
        _ => 2 // EVENT_NOTE_ON
    }
}

/// The full per-quantum instrument path a device calls from `process`: clear the output, PULL each block's
/// notes into the scratch (Route A) AND append a param-update marker at each `next_update_position` in the
/// block (Route D — generated here from the engine's update clock, not injected into the stream), resolve
/// every record's sample offset, sort, dispatch the quantum (`dispatch_range` voices notes and refreshes
/// parameters at the markers), then run the once-per-quantum `finish`.
pub fn render_instrument<I: Instrument>(ports: Ports<I::State>) {
    for sample in ports.output.iter_mut() {
        *sample = 0.0;
    }
    let mut count = 0;
    for block in ports.blocks {
        if count >= ports.event_scratch.len() {
            break;
        }
        let pulled = pull_events(block.p0, block.p1, block.flags.0, &mut ports.event_scratch[count..]);
        count += pulled;
        // Param-update markers at the engine's update positions in this block (none when the device has no
        // automation — `first_update_position` returns INFINITY). The seed is INCLUSIVE (a grid point on the
        // block start fires); the loop then advances STRICTLY. They carry the pulse position; the offset is
        // resolved with the notes below.
        let mut position = first_update_position(block.p0);
        while position < block.p1 && count < ports.event_scratch.len() {
            ports.event_scratch[count] = EventRecord {position, offset: 0, kind: EVENT_PARAM, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
            count += 1;
            position = next_update_position(position);
        }
    }
    // The pull chain works in pulse positions; resolve each record's sample offset, then sort the merged
    // notes + markers into offset order (off -> param -> on at a tie) for `dispatch_range`.
    for record in &mut ports.event_scratch[..count] {
        record.offset = pulse_to_offset(record.position);
    }
    ports.event_scratch[..count].sort_unstable_by(|a, b| a.offset.cmp(&b.offset).then(record_rank(a.kind).cmp(&record_rank(b.kind))));
    dispatch_range::<I>(ports.state, ports.output, &ports.event_scratch[..count]);
    I::finish(ports.state, ports.output);
}

/// The device-SDK template for an AUDIO EFFECT (the TS `AudioEffectDeviceProcessor` analog). It reads one
/// input buffer and writes one output buffer, going block to block AND breaking each block at its clock
/// events: render up to the event, pull the parameters changed there (`parameter_changed`), then continue
/// (the TS `AudioProcessor` split loop). `State` is the effect's instance state (e.g. a filter's history).
pub trait AudioEffect {
    type State;
    /// Transform `input` into `output` (same length) for one inter-event sub-chunk. `block` is THIS chunk's
    /// block: its `p0`/`p1` are the chunk's pulse range, `bpm`/`flags` carry over (one-shot flags cleared
    /// after the first chunk), and `s0`/`s1` are rebased to `0`/`output.len()` to match the sliced buffers.
    /// An effect locks to tempo via `block`; one driven purely by automated parameters ignores it and reads
    /// what `parameter_changed` set. The sample rate is the device's own (it stashed `Ports::sample_rate`).
    fn process_audio(state: &mut Self::State, input: &[f32], output: &mut [f32], block: &Block);
    /// Register this device's automatable parameters with the host via [`bind_parameter`], stashing the
    /// returned ids in `state`. Called once when the device is wired. Default: nothing (no params).
    fn init(state: &mut Self::State) {
        let _ = state;
    }
    /// Apply a parameter's new typed `value` for `id` (the value `bind_parameter` returned), storing it in
    /// `state`. `value` is a [`ParamValue`]: `Unit` is the uniform `0..1` automation value to MAP to the
    /// parameter's range; `Int` / `Float` / `Bool` are a box field's already-real value to use directly. Called
    /// for the initial value, on edits, and on automation. Default: nothing (no params).
    fn parameter_changed(state: &mut Self::State, id: u32, value: ParamValue) {
        let _ = (state, id, value);
    }
}

/// The per-quantum effect path a device calls from `process`: run input 0 through the effect PER BLOCK,
/// and within each block split the sample range at the engine's update positions (Route D) — `process_audio`
/// for the chunk before each, refresh the parameters there — the TS `AudioProcessor` loop, with the split
/// points generated from `next_update_position` rather than injected events. With no input it outputs
/// silence; with no transport blocks (not playing) it passes the input through. A device with no automation
/// gets no update positions (INFINITY) and runs whole blocks.
pub fn render_effect<E: AudioEffect>(ports: Ports<E::State>) {
    let frames = ports.output.len();
    if ports.inputs.is_empty() {
        for sample in ports.output.iter_mut() {
            *sample = 0.0;
        }
        return;
    }
    let input = ports.inputs.get(0);
    if ports.blocks.is_empty() {
        ports.output.copy_from_slice(&input[..frames]);
        return;
    }
    for block in ports.blocks {
        let s0 = (block.s0 as usize).min(frames);
        let s1 = (block.s1 as usize).min(frames);
        if s1 <= s0 {
            continue;
        }
        let mut cursor = s0;
        let mut chunk_p0 = block.p0; // the pulse position at `cursor`
        let mut flags = block.flags; // one-shot flags belong to the first chunk only
        let mut position = first_update_position(block.p0);
        while position < block.p1 {
            let offset = (pulse_to_offset(position) as usize).clamp(s0, s1);
            if offset > cursor {
                let sub = Block {index: block.index, flags, p0: chunk_p0, p1: position, s0: 0, s1: (offset - cursor) as u32, bpm: block.bpm};
                E::process_audio(ports.state, &input[cursor..offset], &mut ports.output[cursor..offset], &sub);
                cursor = offset;
                chunk_p0 = position;
                flags.clear_event_flags();
            }
            apply_param_changes::<E::State>(ports.state, position, E::parameter_changed);
            position = next_update_position(position);
        }
        if cursor < s1 {
            let sub = Block {index: block.index, flags, p0: chunk_p0, p1: block.p1, s0: 0, s1: (s1 - cursor) as u32, bpm: block.bpm};
            E::process_audio(ports.state, &input[cursor..s1], &mut ports.output[cursor..s1], &sub);
        }
    }
}

/// The device-SDK template for a MIDI EFFECT (the TS `MidiEffectProcessor` / `NoteEventSource` analog). A
/// MIDI fx is a PULL SOURCE: the host invokes its `process_events` for a range only when something
/// downstream pulls it, and the device pulls its OWN upstream (over a range it chooses) and returns the
/// transformed events for the range. It produces no audio. A device implements `transform` and calls
/// [`render_midi_effect`] from its `process_events` export.
pub trait MidiEffect {
    /// Per-instance state, interpreted from the engine-allocated (zeroed) block, persisting across pulls
    /// (e.g. an arpeggiator's stack of held notes). `()` for a stateless fx.
    type State;
    /// Transform the pulled upstream `input` events into `output`, returning the count written (bounded by
    /// `output.len()`). The relationship is NOT one-to-one: an fx may DROP events (a transpose silently
    /// ignores notes that fall out of MIDI range, never clamps them) or PRODUCE more than it consumed (an
    /// arpeggiator emits a stream from a held chord). Offsets are absolute within the quantum; preserve
    /// them unless the fx warps time.
    fn transform(state: &mut Self::State, input: &[EventRecord], output: &mut [EventRecord]) -> usize;
    /// Register this device's automatable parameters with the host via [`bind_parameter`], stashing the
    /// returned ids in `state`. Called once when the device is wired. Default: nothing (no params).
    fn init(state: &mut Self::State) {
        let _ = state;
    }
    /// Apply a parameter's new typed `value` for `id`. `value` is a [`ParamValue`]: `Unit` is the uniform
    /// `0..1` automation value (the device maps it), `Int` / `Float` / `Bool` a box field's already-real value.
    /// A midi-fx with automated params is pulled per update sub-range, so this is called at each. Default: nothing.
    fn parameter_changed(state: &mut Self::State, id: u32, value: ParamValue) {
        let _ = (state, id, value);
    }
}

// The on-stack scratch a MIDI fx pulls its upstream into before transforming. Stack-resident (the device
// gets a 256 KiB stack), so no device-global buffer; sized for a generous per-range event count.
const MIDI_PULL_SCRATCH: usize = 256;

/// The pull-response path a MIDI-fx device calls from `process_events(from, to, flags, state_ptr, out_ptr,
/// max)`: split `[from, to)` at the engine's update positions (Route D) and, per sub-range, PULL the upstream
/// into an on-stack scratch and `transform` it into the host-provided output, refreshing the device's
/// parameters at each boundary. A device with no automation gets no update positions (INFINITY), so this is
/// ONE pull over `[from, to)` — the previous behaviour. The upstream range equals each sub-range, which suits
/// pitch / velocity / arp transforms that do not move events in time.
pub fn render_midi_effect<M: MidiEffect>(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut M::State) };
    let out = unsafe { slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
    let mut count = 0;
    let mut sub_from = from;
    // The seed is INCLUSIVE (a boundary exactly on `from` fires); the loop then advances STRICTLY. When the fx
    // has no automation, `boundary` is INFINITY, so this is ONE pull over `[from, to)` — the previous behaviour.
    let mut boundary = first_update_position(from);
    loop {
        let sub_to = if boundary < to {boundary} else {to};
        let mut scratch = [blank; MIDI_PULL_SCRATCH];
        let pulled = pull_events(sub_from, sub_to, flags, &mut scratch);
        count += M::transform(state, &scratch[..pulled], &mut out[count..]);
        if sub_to >= to {
            break;
        }
        // refresh this fx's parameters at the update boundary, before the next sub-range transforms.
        apply_param_changes::<M::State>(state, boundary, M::parameter_changed);
        sub_from = sub_to;
        boundary = next_update_position(boundary);
    }
    count as u32
}

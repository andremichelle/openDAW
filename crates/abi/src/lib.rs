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
pub const DEVICE_KIND_EFFECT: u32 = 1;
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
    fn host_automation(path_ptr: u32, path_len: u32, position: f64) -> f32;
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

/// Pull the automation value (a UNIT 0..1, the plugin maps it to its own range) for one of THIS device's
/// parameters at pulse `position`. The parameter is named by its stable FIELD-KEY PATH on the device box
/// (`path`) — e.g. `[16, 10]` for a `lowPass.frequency` field, the same keys the box schema uses; the host
/// matches it against the automation track's target field path. No encoding: the path is passed as field
/// keys, never a packed integer, so it stays valid however the host stores its tables. A device calls this
/// from its `automate` hook on each clock event. Returns 0.5 (mid) when the field has no automation. Native
/// stub returns 0.5.
#[inline]
pub fn pull_automation(path: &[u16], position: f64) -> f32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_automation(path.as_ptr() as u32, path.len() as u32, position) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (path, position); 0.5 }
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
    /// Render the active state additively into `output` for one inter-event sub-chunk.
    fn process_audio(state: &mut Self::State, output: &mut [f32], sample_rate: f32);
    /// Apply one note event (on / off) at its sample offset.
    fn handle_event(state: &mut Self::State, event: &EventRecord, sample_rate: f32);
    /// Refresh this device's automated parameters at a clock event's pulse `position` (the TS
    /// `updateParameters`): pull each via [`pull_automation`] and apply. Default: nothing (no params).
    fn automate(state: &mut Self::State, position: f64) {
        let _ = (state, position);
    }
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
        // A clock event (Route D) refreshes the automated parameters at this offset; a note event voices.
        if event.kind == EVENT_PARAM {
            I::automate(state, event.position);
        } else {
            I::handle_event(state, event, sample_rate);
        }
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
        let pulled = pull_events(block.p0, block.p1, block.flags.0, &mut ports.event_scratch[count..]);
        // The pull chain works in pulse positions; this consumer resolves each to its sample offset for the
        // DSP (the block containing the position maps it). Positions are block-monotonic, so the result
        // stays offset-sorted for `dispatch_range`.
        for record in &mut ports.event_scratch[count..count + pulled] {
            record.offset = pulse_to_offset(record.position);
        }
        count += pulled;
    }
    dispatch_range::<I>(ports.state, ports.output, &ports.event_scratch[..count], sample_rate);
    I::finish(ports.state, ports.output, sample_rate);
}

/// The device-SDK template for an AUDIO EFFECT (the TS `AudioEffectDeviceProcessor` analog). It reads one
/// input buffer and writes one output buffer, going block to block AND breaking each block at its clock
/// events: render up to the event, refresh the automated parameters (`automate`), then continue (the TS
/// `AudioProcessor` split loop). `State` is the effect's instance state (e.g. a filter's history).
pub trait AudioEffect {
    type State;
    /// Transform `input` into `output` (same length) for one inter-event sub-chunk. `bpm` and `position`
    /// (the pulse position at the chunk's start) let an effect lock to tempo; effects driven purely by
    /// automated parameters ignore them and read the parameters `automate` set.
    fn process_audio(state: &mut Self::State, input: &[f32], output: &mut [f32], sample_rate: f32, bpm: f32, position: f64);
    /// Refresh this device's automated parameters at a clock event's pulse `position` (the TS
    /// `updateParameters`): pull each via [`pull_automation`] and apply. Default: nothing (no params).
    fn automate(state: &mut Self::State, position: f64) {
        let _ = (state, position);
    }
}

/// The per-quantum effect path a device calls from `process`: run input 0 through the effect PER BLOCK,
/// and within each block PULL the clock events (Route D) and split the block's sample range at them —
/// `process_audio` for the chunk before each event, `automate` at the event — exactly the TS
/// `AudioProcessor` loop. With no input it outputs silence; with no transport blocks (not playing) it
/// passes the input through unchanged. A device with no automation pulls nothing and runs whole blocks.
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
        // Pull this block's clock events into the scratch and resolve each to its sample offset. With no
        // automation the host injects none, so `pulled` is 0 and the block runs as one chunk.
        let pulled = pull_events(block.p0, block.p1, block.flags.0, ports.event_scratch);
        for record in &mut ports.event_scratch[..pulled] {
            record.offset = pulse_to_offset(record.position);
        }
        let mut cursor = s0;
        for index in 0..pulled {
            let record = ports.event_scratch[index];
            let offset = (record.offset as usize).clamp(s0, s1);
            if offset > cursor {
                E::process_audio(ports.state, &input[cursor..offset], &mut ports.output[cursor..offset], ports.sample_rate, block.bpm, block.p0);
                cursor = offset;
            }
            if record.kind == EVENT_PARAM {
                E::automate(ports.state, record.position);
            }
        }
        if cursor < s1 {
            E::process_audio(ports.state, &input[cursor..s1], &mut ports.output[cursor..s1], ports.sample_rate, block.bpm, block.p0);
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
}

// The on-stack scratch a MIDI fx pulls its upstream into before transforming. Stack-resident (the device
// gets a 256 KiB stack), so no device-global buffer; sized for a generous per-range event count.
const MIDI_PULL_SCRATCH: usize = 256;

/// The pull-response path a MIDI-fx device calls from `process_events(from, to, flags, state_ptr, out_ptr,
/// max)`: PULL the upstream stream for `[from, to)` into an on-stack scratch, then `transform` it (with the
/// instance state) into the host-provided output buffer. The upstream range need not equal `[from, to)` (a
/// time warp chooses its own), but this template pulls the same range, which suits pitch/velocity/arp
/// transforms that do not move events in time.
pub fn render_midi_effect<M: MidiEffect>(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut M::State) };
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
    let mut scratch = [blank; MIDI_PULL_SCRATCH];
    let pulled = pull_events(from, to, flags, &mut scratch);
    let out = unsafe { slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    M::transform(state, &scratch[..pulled], out) as u32
}

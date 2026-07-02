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
//! An effect's audio inputs are NOT in the descriptor: they are resolved by PORT id through the
//! `host_resolve_input` import (Route B/C), the through-signal at `MAIN_INPUT` and each `bind_sidechain`
//! port at `2, 3, ...`, exactly as a sampler resolves a sample handle.
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
    pub cent: f32,
    // The note's length in pulses, on a NOTE_ON only (0 otherwise). An instrument does not need it (it gets a
    // matching NOTE_OFF), but a MIDI fx exposes it to its user script as the note's `duration` — the script
    // schedules the transformed note's own note-off from it, so it must travel WITH the note-on (the matching
    // note-off can be in a later block). `f64` last so it stays 8-aligned with no padding (size 40).
    pub duration: f64
}

pub const EVENT_NOTE_ON: u32 = 0;
pub const EVENT_NOTE_OFF: u32 = 1;
/// A parameter-automation update (Route D): clock-driven, merged into the pulled stream. `pitch` carries
/// the parameter index, `velocity` the new value. At an equal position the device-SDK applies it between
/// note-off and note-on (see the engine's event ordering), so a note starting there sees the new value.
pub const EVENT_PARAM: u32 = 2;
/// A choke: force-release all of the receiving instrument's voices fast (the 5 ms ramp), click-free. The
/// composite tags a note-on as a choke for the sibling slots in a note-on's choke group (event-tagging, not
/// inter-slot firing); the slot's `handle_event` treats it as a forced release. Carried in the event stream
/// like a note event, so it is sample-accurate via the same sub-block split.
pub const EVENT_CHOKE: u32 = 3;

/// What a device IS, so the host knows how to wire it into the graph (it reads this from the device's
/// `kind` export at load). An instrument voices notes into audio; an effect transforms an input buffer; a
/// MIDI effect is a pull source that transforms an upstream event stream (no audio, exports
/// `process_events` instead of `process`).
pub const DEVICE_KIND_INSTRUMENT: u32 = 0;
pub const DEVICE_KIND_AUDIO_EFFECT: u32 = 1;
pub const DEVICE_KIND_MIDI_EFFECT: u32 = 2;

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
    fn host_resolve_sample(handle: u32, out_ptr: u32) -> u32;
    fn host_observe_sample(path_ptr: u32, path_len: u32) -> u32;
    fn host_resolve_soundfont(handle: u32, out_ptr: u32) -> u32;
    fn host_observe_soundfont(path_ptr: u32, path_len: u32) -> u32;
    fn host_observe_field(path_ptr: u32, path_len: u32) -> u32;
    fn host_bind_sidechain(path_ptr: u32, path_len: u32) -> u32;
    fn host_resolve_input(id: u32, out_ptr: u32) -> u32;
    // SCRIPT BRIDGE (Werkstatt / Apparat / Spielwerk only). `host_self_uuid` is an engine export like the rest;
    // the `host_script_*` family are JS closures the loader binds into `env` (see the `script_*` wrappers below).
    fn host_self_uuid(out16_ptr: u32);
    fn host_script_create(uuid_ptr: u32, kind: u32, state_ptr: u32) -> u32;
    fn host_script_audio(handle: u32, src_l: u32, src_r: u32, out_l: u32, out_r: u32,
                         s0: u32, s1: u32, index: u32, p0: f64, p1: f64, bpm: f32, flags: u32) -> u32;
    fn host_script_note_on(handle: u32, pitch: u32, velocity: f32, cent: f32, id: u32);
    fn host_script_note_off(handle: u32, id: u32);
    fn host_script_reset(handle: u32);
    fn host_script_param(handle: u32, index: u32, kind: u32, value: f32);
    fn host_script_sample(handle: u32, index: u32, sample_handle: u32, present: u32);
    fn host_script_notes(handle: u32, in_ptr: u32, in_count: u32, out_ptr: u32, out_max: u32,
                         from: f64, to: f64, bpm: f32, flags: u32, s0: u32, s1: u32) -> u32;
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

/// Resolve a FLOAT parameter from its [`ParamValue`]: a uniform automation value mapped through `mapping`, or
/// a real `Float` field value used directly. PANICS on an `Int` / `Bool` wire — a float parameter never
/// carries those, so it can only be a contract drift; the value is never silently coerced. Shared by all
/// plugins (the device just supplies its own `mapping`).
#[inline]
pub fn float_value<M: math::value_mapping::ValueMapping<f32>>(value: ParamValue, mapping: &M) -> f32 {
    match value {
        ParamValue::Unit(unit) => mapping.y(unit),
        ParamValue::Float(real) => real,
        ParamValue::Int(_) | ParamValue::Bool(_) => panic!("expected a float parameter")
    }
}

/// Resolve an INT parameter: a uniform automation value mapped through `mapping`, or a real `Int` value.
/// PANICS on a `Float` / `Bool` wire.
#[inline]
pub fn int_value<M: math::value_mapping::ValueMapping<i32>>(value: ParamValue, mapping: &M) -> i32 {
    match value {
        ParamValue::Unit(unit) => mapping.y(unit),
        ParamValue::Int(real) => real,
        ParamValue::Float(_) | ParamValue::Bool(_) => panic!("expected an int parameter")
    }
}

/// Resolve a BOOL parameter: a uniform automation value (true at / above the halfway point), or a real `Bool`
/// value. PANICS on an `Int` / `Float` wire.
#[inline]
pub fn bool_value(value: ParamValue) -> bool {
    match value {
        ParamValue::Unit(unit) => unit >= 0.5,
        ParamValue::Bool(flag) => flag,
        ParamValue::Int(_) | ParamValue::Float(_) => panic!("expected a bool parameter")
    }
}

pub const FIELD_KIND_INT: u32 = 0;
pub const FIELD_KIND_FLOAT: u32 = 1;
pub const FIELD_KIND_BOOL: u32 = 2;
pub const FIELD_KIND_STRING: u32 = 3;

/// A PLAIN box-field value handed to a device's [`Instrument::field_changed`], ALREADY TYPED (the analog of
/// [`ParamValue`] for observed fields, not parameters). Mirrors the box graph's field primitives one-to-one:
/// `Int` / `Float` / `Bool`, and `String` as a `&str` borrowed from the shared linear memory for the duration
/// of the call (the device must copy it if it keeps it; it is NOT valid after `field_changed` returns). The
/// SDK builds this from the wire `(kind, bits, len)` via [`FieldValue::from_wire`]. A device matches the
/// variant it expects and PANICS on any other, never coercing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FieldValue<'a> {
    Int(i32),
    Float(f32),
    Bool(bool),
    String(&'a str)
}

impl<'a> FieldValue<'a> {
    /// Decode the wire `(kind, bits, len)`: `bits` carries the numeric value's raw bits, or (for a string) the
    /// pointer to its UTF-8 bytes in the shared memory with `len` their length. Panics on an unknown kind or
    /// invalid UTF-8 (the engine is the only writer, so either is a contract drift, never live input).
    ///
    /// # Safety
    /// For a string, `bits`/`len` must point at `len` valid, initialized UTF-8 bytes that stay alive and
    /// unmoved for the whole call. The engine guarantees this (it passes a live box-field string).
    #[inline]
    pub unsafe fn from_wire(kind: u32, bits: u32, len: u32) -> Self {
        match kind {
            FIELD_KIND_INT => FieldValue::Int(bits as i32),
            FIELD_KIND_FLOAT => FieldValue::Float(f32::from_bits(bits)),
            FIELD_KIND_BOOL => FieldValue::Bool(bits != 0),
            FIELD_KIND_STRING => {
                let bytes = slice::from_raw_parts(bits as *const u8, len as usize);
                FieldValue::String(core::str::from_utf8(bytes).expect("field string is not valid UTF-8"))
            }
            _ => panic!("unknown field kind")
        }
    }
}

/// A resolved sample (Route F): decoded PLANAR f32 frames resident in the shared linear memory. `frames_ptr`
/// points at channel 0's frames; channel `c` is at `frames_ptr + c * frame_count * 4` (each plane is
/// `frame_count` consecutive f32). The host fills this from a sample handle via [`resolve_sample`]; a handle
/// that is not yet resident resolves to `None`. `#[repr(C)]` so the engine writes it straight into the
/// device's out pointer.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SampleRef {
    pub frames_ptr: u32,
    pub frame_count: u32,
    pub channel_count: u32,
    pub sample_rate: f32
}

impl SampleRef {
    /// The PLANAR frames of `channel` (0-based) as a safe slice (`frame_count` f32 at
    /// `frames_ptr + channel * frame_count * 4`). The one `unsafe` stays here in the shim; device DSP reads
    /// frames as a slice. The slice borrows the resident sample memory, valid while the sample stays resident.
    #[inline]
    pub fn plane(&self, channel: u32) -> &[f32] {
        let offset = self.frames_ptr as usize + channel as usize * self.frame_count as usize * 4;
        unsafe { slice::from_raw_parts(offset as *const f32, self.frame_count as usize) }
    }
}

/// Resolve a sample `handle` (Route F) to its resident PLANAR frames, or `None` when not yet resident (the
/// device skips that sample for the block). The host writes a [`SampleRef`] into an on-stack scratch and
/// returns 1 when resident. Native stub returns `None` (native device tests supply samples directly).
#[inline]
pub fn resolve_sample(handle: u32) -> Option<SampleRef> {
    #[cfg(target_family = "wasm")]
    {
        let mut out = SampleRef {frames_ptr: 0, frame_count: 0, channel_count: 0, sample_rate: 0.0};
        if unsafe { host_resolve_sample(handle, &mut out as *mut SampleRef as u32) } != 0 {
            Some(out)
        } else {
            None
        }
    }
    #[cfg(not(target_family = "wasm"))]
    {
        let _ = handle;
        None
    }
}

/// A resolved SOUNDFONT: a pointer + byte length of the simplified soundfont BLOB resident in the engine's
/// shared linear memory (built on the main thread from the parsed SF2 — sample table + region table + preset
/// table + PLANAR-normalized f32 PCM). `#[repr(C)]` so the engine writes it straight into the device's out
/// pointer, exactly like [`SampleRef`]. The device reads the blob IN PLACE (offset arithmetic, no allocation).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SoundfontRef {
    pub ptr: u32,
    pub len: u32
}

impl SoundfontRef {
    /// The blob as a safe byte slice. The one `unsafe` stays here in the shim; the device reads scalars out of
    /// it by fixed offset. Borrows the resident soundfont memory, valid while the soundfont stays resident.
    #[inline]
    pub fn bytes(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.ptr as *const u8, self.len as usize) }
    }
}

/// Resolve a soundfont `handle` to its resident BLOB (ptr + len), or `None` when not yet resident (the device
/// stays silent for the note). Mirrors [`resolve_sample`]: the host writes a [`SoundfontRef`] into an on-stack
/// scratch and returns 1 when resident. Native stub returns `None`.
#[inline]
pub fn resolve_soundfont(handle: u32) -> Option<SoundfontRef> {
    #[cfg(target_family = "wasm")]
    {
        let mut out = SoundfontRef {ptr: 0, len: 0};
        if unsafe { host_resolve_soundfont(handle, &mut out as *mut SoundfontRef as u32) } != 0 {
            Some(out)
        } else {
            None
        }
    }
    #[cfg(not(target_family = "wasm"))]
    {
        let _ = handle;
        None
    }
}

/// Observe this device's SOUNDFONT reference by its box pointer-field PATH (e.g. `[10]` for the Soundfont
/// device's `file`), returning an id the device matches in [`Instrument::soundfont_changed`]. The host tracks
/// that pointer reactively: on catch-up and whenever it is set / repointed / cleared it resolves the target
/// `SoundfontFileBox`, requests its simplified blob, and delivers the handle through `soundfont_changed` (a
/// resident handle, or "unbound"). Mirrors [`observe_sample`]. A device calls this from `init`. Native stub 0.
#[inline]
pub fn observe_soundfont(path: &[u16]) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_observe_soundfont(path.as_ptr() as u32, path.len() as u32) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = path; 0 }
}

/// Observe this device's sample reference by its box pointer-field PATH (e.g. `[11]` for a Playfield slot's
/// `file`), returning an id the device matches in [`Instrument::sample_changed`]. The host REACTIVELY tracks
/// that pointer: on catch-up and whenever it is set / repointed / cleared (inside a transaction, never during
/// render) it resolves the target to the AudioFileBox, requests its frames (Route F), and delivers the handle
/// through `sample_changed` (a resident handle, or "unbound" when the pointer has no target). NOT a parameter.
/// A device calls this from `init`. Native stub returns 0.
#[inline]
pub fn observe_sample(path: &[u16]) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_observe_sample(path.as_ptr() as u32, path.len() as u32) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = path; 0 }
}

/// Observe one of THIS device's PLAIN box fields by its field-key PATH (e.g. `[15]` for a Playfield slot's
/// `index`), returning an id the device matches in [`Instrument::field_changed`]. The host `catchup`s the
/// current value immediately and `subscribe`s for later edits, delivering each through `field_changed` (NEVER
/// during render, only inside a transaction). This is NOT a parameter: no automation, no mapping, no clock
/// pull, the device just reads its own field and keeps a copy. A device calls this from `init`. Native stub
/// returns 0.
#[inline]
pub fn observe_field(path: &[u16]) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_observe_field(path.as_ptr() as u32, path.len() as u32) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = path; 0 }
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

/// Declare one of THIS effect's SIDECHAIN input PORTS by its pointer FIELD-KEY PATH on the device box (e.g.
/// `[30]` for the Gate's `side-chain`). Returns the PORT id (`2, 3, ...`, after the reserved [`MAIN_INPUT`]),
/// which the device passes to [`resolve_input`] during its DSP. The host resolves the pointer to the targeted
/// box's audio output and orders that producer before this effect. An effect may declare ANY number of
/// sidechains; an unconnected one simply resolves to `None`. A device calls this from `init`. Native stub
/// returns 0.
#[inline]
pub fn bind_sidechain(path: &[u16]) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_bind_sidechain(path.as_ptr() as u32, path.len() as u32) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = path; 0 }
}

/// Resolve an audio input PORT by id to its stereo buffer for the current quantum (Route B/C): [`MAIN_INPUT`]
/// for the through-signal, or a `bind_sidechain` port id. `Some` when the port is wired, `None` when it is not
/// (an unconnected sidechain, or no upstream). The device reads the returned channels in absolute quantum
/// coordinates. Like [`resolve_sample`], it reads an engine cell the host swaps in for this `process`, so it
/// is O(1) and safe to call from the DSP. Native stub returns `None` (effect DSP is unit-tested via the pure
/// per-sample path, not through the host).
#[inline]
pub fn resolve_input(id: u32) -> Option<AudioInputRef> {
    #[cfg(target_family = "wasm")]
    {
        let mut out = AudioInputRef {left: 0, right: 0, frames: 0};
        if unsafe { host_resolve_input(id, &mut out as *mut AudioInputRef as u32) } != 0 {
            Some(out)
        } else {
            None
        }
    }
    #[cfg(not(target_family = "wasm"))]
    {
        let _ = id;
        None
    }
}

// ---- SCRIPT BRIDGE wrappers -------------------------------------------------------------------------------
// The Werkstatt / Apparat / Spielwerk devices run user JavaScript in the host's AudioWorklet. Their Rust
// side-module is a thin BRIDGE: per block it hands the engine's audio / notes / params / samples to a host JS
// callback that runs the user `Processor` over the shared linear memory. These wrappers are the ONLY device
// surface that crosses back into JS during render (every other `host_*` is a wasm-to-wasm engine export); the
// relaxation of the zero-JS-in-render guarantee is contained to these three devices. Native stubs are no-ops so
// the crates still build + unit-test off-target.

/// THIS device's 16-byte box uuid (an engine export — the engine knows it at bind). Used once from `init` to
/// key the JS-side script bridge to the matching user `Processor`. Native stub returns zeroes.
#[inline]
pub fn self_uuid() -> [u8; 16] {
    #[cfg(target_family = "wasm")]
    {
        let mut out = [0u8; 16];
        unsafe { host_self_uuid(out.as_mut_ptr() as u32) };
        out
    }
    #[cfg(not(target_family = "wasm"))]
    { [0u8; 16] }
}

/// Create the JS-side script bridge for this device (from `init`): `uuid` + `kind` (`DEVICE_KIND_*`) identify
/// it; returns a handle the device passes to every later `script_*` call. Native stub returns 0.
#[inline]
pub fn script_create(uuid: &[u8; 16], kind: u32, state_ptr: u32) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_create(uuid.as_ptr() as u32, kind, state_ptr) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (uuid, kind, state_ptr); 0 }
}

/// Run the user `process` for one `block` over the shared audio buffers (Werkstatt / Apparat). `src_l`/`src_r`
/// are the input channels' byte offsets (0 for an instrument with no input), `out_l`/`out_r` the output
/// channels'. Returns 0 ok, nonzero when the bridge silenced the device (already reported). Native stub = 0.
#[inline]
pub fn script_audio(handle: u32, src_l: u32, src_r: u32, out_l: u32, out_r: u32, block: &Block) -> u32 {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_audio(handle, src_l, src_r, out_l, out_r, block.s0, block.s1, block.index, block.p0, block.p1, block.bpm, block.flags.0) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (handle, src_l, src_r, out_l, out_r, block); 0 }
}

/// Deliver a note-on to the user `Processor` (Apparat) at the current sub-block boundary. Native stub no-op.
#[inline]
pub fn script_note_on(handle: u32, pitch: u32, velocity: f32, cent: f32, id: u32) {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_note_on(handle, pitch, velocity, cent, id) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (handle, pitch, velocity, cent, id); }
}

/// Deliver a note-off to the user `Processor` (Apparat). Native stub no-op.
#[inline]
pub fn script_note_off(handle: u32, id: u32) {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_note_off(handle, id) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (handle, id); }
}

/// Tell the user `Processor` to reset (transport stop). Native stub no-op.
#[inline]
pub fn script_reset(handle: u32) {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_reset(handle) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = handle; }
}

/// Forward a parameter change to the user `Processor` by declaration `index` + the raw `(kind, value)` (the
/// bridge maps `UNIT` via the script's `@param` mapping, uses `FLOAT`/`INT`/`BOOL` directly). Native stub no-op.
#[inline]
pub fn script_param(handle: u32, index: u32, value: ParamValue) {
    let (kind, bits) = match value {
        ParamValue::Unit(unit) => (PARAM_KIND_UNIT, unit),
        ParamValue::Int(int) => (PARAM_KIND_INT, int as f32),
        ParamValue::Float(float) => (PARAM_KIND_FLOAT, float),
        ParamValue::Bool(flag) => (PARAM_KIND_BOOL, if flag { 1.0 } else { 0.0 })
    };
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_param(handle, index, kind, bits) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (handle, index, kind, bits); }
}

/// Deliver a sample slot's resolved handle (or unbind) to the user `Processor` by declaration `index` (Apparat).
/// `present` is 0 to clear. The bridge resolves the handle's frames into `proc.samples[label]`. Native stub no-op.
#[inline]
pub fn script_sample(handle: u32, index: u32, sample_handle: u32, present: bool) {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_sample(handle, index, sample_handle, present as u32) } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (handle, index, sample_handle, present); }
}

/// Run the user note-transform generator + all stateful tracking (Spielwerk) over the pulled input events,
/// writing output `EventRecord`s into `out` and returning the count. Native stub returns 0.
#[inline]
#[allow(clippy::too_many_arguments)]
pub fn script_notes(handle: u32, input: &[EventRecord], out: &mut [EventRecord], from: f64, to: f64, bpm: f32, flags: u32, s0: u32, s1: u32) -> usize {
    #[cfg(target_family = "wasm")]
    { unsafe { host_script_notes(handle, input.as_ptr() as u32, input.len() as u32, out.as_mut_ptr() as u32, out.len() as u32, from, to, bpm, flags, s0, s1) as usize } }
    #[cfg(not(target_family = "wasm"))]
    { let _ = (handle, input, out.len(), from, to, bpm, flags, s0, s1); 0 }
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
/// The scratch is on the stack, so no device-global buffer. Public so the SCRIPTABLE devices (which write
/// `process` directly instead of via the `render_*` templates) can refresh their automated parameters at each
/// update position exactly as the templates do.
#[inline]
pub fn apply_param_changes<S>(state: &mut S, position: f64, apply: fn(&mut S, u32, ParamValue)) {
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

    /// The two input channels `[left, right]`, mirroring TS `StereoMatrix.Channels`. Requires a stereo input.
    #[inline]
    pub fn channels(&self) -> [&'a [f32]; 2] {
        [self.get(0), self.get(1)]
    }
}

/// The well-known PORT id of an effect's main input, the through-signal the engine always wires from the
/// upstream node. Resolve it with [`resolve_input`] exactly like a sidechain port; `bind_sidechain` ports are
/// numbered from `2`.
pub const MAIN_INPUT: u32 = 1;

/// A resolved audio input port (Route B/C): the source's stereo buffer for the WHOLE quantum, addressed by
/// pointers. The device indexes it in absolute quantum coordinates (the same `block.s0..s1` it writes to
/// `output`). Mirrors [`SampleRef`]: a thin handle whose accessors hand back safe slices.
#[derive(Clone, Copy)]
pub struct AudioInputRef {
    pub left: u32,
    pub right: u32,
    pub frames: u32,
}

impl AudioInputRef {
    #[inline]
    pub fn left(&self) -> &[f32] { unsafe { slice::from_raw_parts(self.left as *const f32, self.frames as usize) } }

    #[inline]
    pub fn right(&self) -> &[f32] { unsafe { slice::from_raw_parts(self.right as *const f32, self.frames as usize) } }

    /// Both channels `[left, right]`, mirroring TS `StereoMatrix.Channels`.
    #[inline]
    pub fn channels(&self) -> [&[f32]; 2] { [self.left(), self.right()] }
}

/// Everything a device needs for one `process` call, as safe references. Built once by
/// [`Ports::from_descriptor`]; device code touches only these fields and never writes `unsafe`.
pub struct Ports<'a, S> {
    pub frames: usize,
    pub inputs: Inputs<'a>,
    /// The output channels, mirroring TS `StereoMatrix.Channels`: `output[0]` = left, `output[1]` = right,
    /// pointing at distinct `f32[frames]` buffers so the two `&mut` slices never alias. A mono device writes
    /// the same samples to both.
    pub output: [&'a mut [f32]; 2],
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
        // The two output channels live at out_offsets[0] / [1] (distinct buffers, so the `&mut`s never alias).
        let out_offsets = if out_count == 0 {
            slice::from_raw_parts(NonNull::<u32>::dangling().as_ptr(), 0)
        } else {
            slice::from_raw_parts(out_offsets_ptr, out_count)
        };
        let output_left = if out_count >= 1 {
            slice::from_raw_parts_mut(out_offsets[0] as *mut f32, frames)
        } else {
            slice::from_raw_parts_mut(NonNull::<f32>::dangling().as_ptr(), 0)
        };
        let output_right = if out_count >= 2 {
            slice::from_raw_parts_mut(out_offsets[1] as *mut f32, frames)
        } else {
            slice::from_raw_parts_mut(NonNull::<f32>::dangling().as_ptr(), 0)
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
            output: [output_left, output_right],
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
    /// Render the active state additively into the stereo `output` (`[left, right]`) for one inter-event
    /// sub-chunk; a mono instrument writes the same samples to both. `block` is THIS chunk's block (like the
    /// audio effect's): `bpm` for tempo (a voice's glide), `p0`/`p1` the chunk's pulse range, `flags` carried
    /// (one-shot flags cleared after the first chunk), and `s0`/`s1` rebased to `0`/`len` to match the slice.
    /// The sample rate is the device's own (it stashed `Ports::sample_rate` in `state`), never a per-call argument.
    fn process_audio(state: &mut Self::State, output: [&mut [f32]; 2], block: &Block);
    /// Apply one note event (on / off) at its sample offset.
    fn handle_event(state: &mut Self::State, event: &EventRecord);
    /// Reset the device's RUNTIME state to silence on a transport STOP: drop every active voice, clear
    /// envelopes / read heads / filter history, so the next playback starts clean. Keep the bindings (the param
    /// / sample / field ids and the resolved parameter values, the sample rate) — only the sounding state is
    /// cleared. Called outside render, never during `process`. Default: nothing.
    fn reset(state: &mut Self::State) {
        let _ = state;
    }
    /// Register this device's automatable parameters with the host via [`bind_parameter`], stashing the
    /// returned ids in `state`. Called once when the device is wired, also receiving the engine's `sample_rate` (stable for the device's life; stash it if the DSP needs it). Default: nothing (no params).
    fn init(state: &mut Self::State, sample_rate: f32) {
        let _ = (state, sample_rate);
    }
    /// Apply a parameter's new typed `value` for `id` (the value `bind_parameter` returned), storing it in
    /// `state`. `value` is a [`ParamValue`]: `Unit` is the uniform `0..1` automation value to MAP to the
    /// parameter's range; `Int` / `Float` / `Bool` are a box field's already-real value to use directly. Called
    /// for the initial value, on edits, and on automation. Default: nothing (no params).
    fn parameter_changed(state: &mut Self::State, id: u32, value: ParamValue) {
        let _ = (state, id, value);
    }
    /// Apply a PLAIN box field's new typed `value` for `id` (the value [`observe_field`] returned), storing it
    /// in `state`. Distinct from `parameter_changed`: this is a raw field copy ([`FieldValue`], the device
    /// matches the variant it expects and panics on any other), never a parameter, so the device owns knowing
    /// things like its own routing note. Delivered on catch-up and on edits, only inside a transaction (never
    /// during render). Default: nothing.
    fn field_changed(state: &mut Self::State, id: u32, value: FieldValue) {
        let _ = (state, id, value);
    }
    /// Apply this device's observed SAMPLE reference for `id` (the value [`observe_sample`] returned), storing
    /// it in `state`. `sample` is `Some(handle)` to later [`resolve_sample`] when the pointer targets a sample,
    /// or `None` when it is unbound (cleared) and the device should stop playing it. Delivered on catch-up and
    /// on add / remove / repoint, only inside a transaction. Default: nothing (no samples).
    fn sample_changed(state: &mut Self::State, id: u32, sample: Option<u32>) {
        let _ = (state, id, sample);
    }
    /// Apply this device's observed SOUNDFONT reference for `id` (the value [`observe_soundfont`] returned),
    /// storing the handle in `state`. `soundfont` is `Some(handle)` to later [`resolve_soundfont`] when the
    /// `file` pointer targets a `SoundfontFileBox`, or `None` when unbound. Delivered on catch-up and on
    /// add / remove / repoint, only inside a transaction. Default: nothing (no soundfont).
    fn soundfont_changed(state: &mut Self::State, id: u32, soundfont: Option<u32>) {
        let _ = (state, id, soundfont);
    }
    /// Once per quantum, after all blocks (e.g. a feedback delay over the whole stereo `output`). Default: nothing.
    fn finish(state: &mut Self::State, output: [&mut [f32]; 2]) {
        let _ = (state, output);
    }
}

/// Dispatch ONE block's `events` (offset-sorted, within `[block.s0, block.s1)`) over the stereo `output`:
/// `process_audio` for each chunk between events, `handle_event` (or a Route-D param pull) at each offset.
/// Each chunk gets a cloned `block` with `s0`/`s1` rebased to `0`/`len`, `p0`/`p1` the chunk's pulse range,
/// and `flags` cleared after the first chunk. Host-independent (events are supplied), so a device's DSP is
/// unit-testable without the engine. Does not clear `output` or run `finish`.
#[inline]
pub fn dispatch_range<I: Instrument>(state: &mut I::State, output: [&mut [f32]; 2], events: &[EventRecord], block: &Block) {
    let [out_left, out_right] = output;
    let frames = out_left.len();
    let s0 = (block.s0 as usize).min(frames);
    let s1 = (block.s1 as usize).min(frames);
    let mut cursor = s0;
    let mut chunk_p0 = block.p0; // the pulse position at `cursor`
    let mut flags = block.flags; // one-shot flags belong to the first chunk only
    for event in events {
        let offset = (event.offset as usize).clamp(s0, s1);
        if offset > cursor {
            let sub = Block {index: block.index, flags, p0: chunk_p0, p1: event.position, s0: 0, s1: (offset - cursor) as u32, bpm: block.bpm};
            I::process_audio(state, [&mut out_left[cursor..offset], &mut out_right[cursor..offset]], &sub);
            cursor = offset;
            chunk_p0 = event.position;
            flags.clear_event_flags();
        }
        // A clock event (Route D) pulls the parameters changed at this position; a note event voices.
        if event.kind == EVENT_PARAM {
            apply_param_changes::<I::State>(state, event.position, I::parameter_changed);
        } else {
            I::handle_event(state, event);
        }
    }
    if cursor < s1 {
        let sub = Block {index: block.index, flags, p0: chunk_p0, p1: block.p1, s0: 0, s1: (s1 - cursor) as u32, bpm: block.bpm};
        I::process_audio(state, [&mut out_left[cursor..s1], &mut out_right[cursor..s1]], &sub);
    }
}

/// Order resolved records for `dispatch_range`: by sample offset, then at an equal offset note-off ->
/// param-update -> note-on, so a note starting at an update position sees the refreshed parameter.
fn record_rank(kind: u32) -> u8 {
    match kind {
        EVENT_NOTE_OFF | EVENT_CHOKE => 0, // releases first, so a choke at a position precedes any note-on there
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
    let Ports {output, state, blocks, event_scratch, ..} = ports;
    let [out_left, out_right] = output;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    // Go block by block (like `render_effect`), so each chunk's `process_audio` gets its own block. Per block:
    // PULL its notes (Route A) plus a param-update marker at each update position (Route D — INCLUSIVE seed,
    // STRICT advance, none when un-automated), resolve sample offsets, sort (off -> param -> on at a tie),
    // and dispatch. Then the once-per-quantum `finish`.
    for block in blocks {
        let mut count = pull_events(block.p0, block.p1, block.flags.0, event_scratch);
        let mut position = first_update_position(block.p0);
        while position < block.p1 && count < event_scratch.len() {
            event_scratch[count] = EventRecord {position, offset: 0, kind: EVENT_PARAM, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
            count += 1;
            position = next_update_position(position);
        }
        for record in &mut event_scratch[..count] {
            record.offset = pulse_to_offset(record.position);
        }
        event_scratch[..count].sort_unstable_by(|a, b| a.offset.cmp(&b.offset).then(record_rank(a.kind).cmp(&record_rank(b.kind))));
        dispatch_range::<I>(state, [&mut *out_left, &mut *out_right], &event_scratch[..count], block);
    }
    I::finish(state, [out_left, out_right]);
}

/// The device-SDK template for an AUDIO EFFECT (the TS `AudioEffectDeviceProcessor` analog). It reads one
/// input buffer and writes one output buffer, going block to block AND breaking each block at its clock
/// events: render up to the event, pull the parameters changed there (`parameter_changed`), then continue
/// (the TS `AudioProcessor` split loop). `State` is the effect's instance state (e.g. a filter's history).
pub trait AudioEffect {
    type State;
    /// Transform the stereo `input` (`[left, right]`) into `output` (`[left, right]`, same length) for one
    /// inter-event sub-chunk. `block` is THIS chunk's block: its `p0`/`p1` are the chunk's pulse range,
    /// `bpm`/`flags` carry over (one-shot flags cleared after the first chunk), and `s0`/`s1` are rebased to
    /// `0`/`len` to match the sliced buffers. An effect locks to tempo via `block`; one driven purely by
    /// automated parameters ignores it and reads what `parameter_changed` set. The sample rate is the device's
    /// own (it stashed `Ports::sample_rate`).
    /// Transform this sub-chunk's audio into `output` (`[left, right]`, the WHOLE quantum buffers). The device
    /// resolves its inputs by PORT id with [`resolve_input`] ([`MAIN_INPUT`] for the through-signal, any
    /// `bind_sidechain` port for analysis), and reads / writes in ABSOLUTE quantum coordinates: the range to
    /// process is `block.s0..block.s1`, and a resolved input's channels are indexed by the same `i`. `block`'s
    /// `p0`/`p1` are the chunk's pulse range, `bpm`/`flags` carry over. The sample rate is the device's own.
    fn process_audio(state: &mut Self::State, output: [&mut [f32]; 2], block: &Block);
    /// Register this device's automatable parameters with the host via [`bind_parameter`] (and any sidechain
    /// input ports via [`bind_sidechain`]), stashing the returned ids in `state`. Called once when the device
    /// is wired, also receiving the engine's `sample_rate` (stable for the device's life; stash it if the DSP
    /// needs it). Default: nothing (no params).
    fn init(state: &mut Self::State, sample_rate: f32) {
        let _ = (state, sample_rate);
    }
    /// Apply a parameter's new typed `value` for `id` (the value `bind_parameter` returned), storing it in
    /// `state`. `value` is a [`ParamValue`]: `Unit` is the uniform `0..1` automation value to MAP to the
    /// parameter's range; `Int` / `Float` / `Bool` are a box field's already-real value to use directly. Called
    /// for the initial value, on edits, and on automation. Default: nothing (no params).
    fn parameter_changed(state: &mut Self::State, id: u32, value: ParamValue) {
        let _ = (state, id, value);
    }
    /// Reset the effect's RUNTIME state to silence on a transport STOP: clear delay lines / reverb tails /
    /// filter history / detector + envelope state, so the next playback starts clean. Keep the bindings (param
    /// ids, resolved values, sample rate). Called outside render, never during `process`. Default: nothing.
    fn reset(state: &mut Self::State) {
        let _ = state;
    }
}

/// The per-quantum effect path a device calls from `process`: run the effect PER BLOCK, and within each block
/// split the sample range at the engine's update positions (Route D) — `process_audio` for the chunk before
/// each, refresh the parameters there — the TS `AudioProcessor` loop, with the split points from
/// `next_update_position` rather than injected events. The device resolves its OWN inputs by port id; this
/// template only resolves [`MAIN_INPUT`] to handle the degenerate cases (no upstream -> silence; not playing,
/// i.e. no transport blocks -> pass the input through). The sub-blocks carry ABSOLUTE `s0`/`s1`, so the device
/// reads / writes the whole-quantum buffers by absolute index and a resolved input lines up sample-for-sample.
pub fn render_effect<E: AudioEffect>(ports: Ports<E::State>) {
    let Ports {output, state, blocks, ..} = ports;
    let [out_left, out_right] = output;
    let frames = out_left.len();
    let Some(input) = resolve_input(MAIN_INPUT) else {
        out_left.fill(0.0);
        out_right.fill(0.0);
        return;
    };
    if blocks.is_empty() {
        out_left.copy_from_slice(&input.left()[..frames]);
        out_right.copy_from_slice(&input.right()[..frames]);
        return;
    }
    for block in blocks {
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
                let sub = Block {index: block.index, flags, p0: chunk_p0, p1: position, s0: cursor as u32, s1: offset as u32, bpm: block.bpm};
                E::process_audio(state, [&mut *out_left, &mut *out_right], &sub);
                cursor = offset;
                chunk_p0 = position;
                flags.clear_event_flags();
            }
            apply_param_changes::<E::State>(state, position, E::parameter_changed);
            position = next_update_position(position);
        }
        if cursor < s1 {
            let sub = Block {index: block.index, flags, p0: chunk_p0, p1: block.p1, s0: cursor as u32, s1: s1 as u32, bpm: block.bpm};
            E::process_audio(state, [&mut *out_left, &mut *out_right], &sub);
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
    /// returned ids in `state`. Called once when the device is wired, also receiving the engine's `sample_rate` (stable for the device's life; stash it if the DSP needs it). Default: nothing (no params).
    fn init(state: &mut Self::State, sample_rate: f32) {
        let _ = (state, sample_rate);
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
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
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

#[cfg(test)]
mod tests {
    //! The instrument dispatch (`dispatch_range`): each inter-event chunk gets its OWN cloned block, with
    //! `s0`/`s1` rebased to the slice, `p0`/`p1` the chunk's pulse range, `bpm` carried, and the one-shot
    //! flags cleared after the first chunk. A recording mock instrument captures what each chunk received.
    use super::{dispatch_range, Block, BlockFlags, EventRecord, Instrument, EVENT_NOTE_ON};

    struct Chunk {
        len: usize,
        p0: f64,
        p1: f64,
        bpm: f32,
        s0: u32,
        s1: u32,
        flags: u32
    }

    #[derive(Default)]
    struct Recorder {
        chunks: Vec<Chunk>,
        pitches: Vec<u32>
    }

    impl Instrument for Recorder {
        type State = Recorder;

        fn process_audio(state: &mut Recorder, output: [&mut [f32]; 2], block: &Block) {
            let [left, _right] = output;
            state.chunks.push(Chunk {
                len: left.len(), p0: block.p0, p1: block.p1, bpm: block.bpm,
                s0: block.s0, s1: block.s1, flags: block.flags.0
            });
        }

        fn handle_event(state: &mut Recorder, event: &EventRecord) {
            state.pitches.push(event.pitch);
        }
    }

    fn note_on(offset: u32, position: f64, pitch: u32) -> EventRecord {
        EventRecord {position, offset, kind: EVENT_NOTE_ON, id: 1, pitch, velocity: 1.0, cent: 0.0, duration: 0.0}
    }

    fn block(s0: u32, s1: u32, p0: f64, p1: f64, bpm: f32) -> Block {
        Block {index: 0, flags: BlockFlags(0), p0, p1, s0, s1, bpm}
    }

    #[test]
    fn a_note_splits_the_block_into_two_rebased_chunks() {
        let mut state = Recorder::default();
        let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
        // a 128-sample block at pulses [100, 228), 140 bpm; a note-on at sample 64 / pulse 164.
        let event = note_on(64, 164.0, 60);
        dispatch_range::<Recorder>(&mut state, [&mut left[..], &mut right[..]], &[event], &block(0, 128, 100.0, 228.0, 140.0));
        assert_eq!(state.chunks.len(), 2, "the note splits the block at its offset");
        let first = &state.chunks[0];
        assert_eq!(first.len, 64);
        assert_eq!((first.s0, first.s1), (0, 64), "rebased to the slice");
        assert_eq!(first.bpm, 140.0, "bpm carried");
        assert_eq!((first.p0, first.p1), (100.0, 164.0), "first chunk spans block start -> note");
        let second = &state.chunks[1];
        assert_eq!(second.len, 64);
        assert_eq!((second.p0, second.p1), (164.0, 228.0), "second chunk spans note -> block end");
        assert_eq!(state.pitches, vec![60], "the note is handled once, between the chunks");
    }

    #[test]
    fn no_events_is_one_full_chunk() {
        let mut state = Recorder::default();
        let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
        dispatch_range::<Recorder>(&mut state, [&mut left[..], &mut right[..]], &[], &block(0, 128, 10.0, 138.0, 120.0));
        assert_eq!(state.chunks.len(), 1);
        assert_eq!(state.chunks[0].len, 128);
        assert_eq!((state.chunks[0].p0, state.chunks[0].p1), (10.0, 138.0));
    }

    #[test]
    fn the_block_sample_range_is_respected() {
        // a block covering only samples [32, 96): one chunk, 64 long, rebased to 0..64.
        let mut state = Recorder::default();
        let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
        dispatch_range::<Recorder>(&mut state, [&mut left[..], &mut right[..]], &[], &block(32, 96, 0.0, 64.0, 120.0));
        assert_eq!(state.chunks.len(), 1);
        assert_eq!(state.chunks[0].len, 64);
        assert_eq!((state.chunks[0].s0, state.chunks[0].s1), (0, 64));
    }

    #[test]
    fn one_shot_flags_belong_to_the_first_chunk_only() {
        let mut state = Recorder::default();
        let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
        let flags = BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::DISCONTINUOUS);
        let block = Block {index: 0, flags, p0: 0.0, p1: 128.0, s0: 0, s1: 128, bpm: 120.0};
        dispatch_range::<Recorder>(&mut state, [&mut left[..], &mut right[..]], &[note_on(64, 64.0, 60)], &block);
        assert_eq!(state.chunks.len(), 2);
        assert!(state.chunks[0].flags & BlockFlags::DISCONTINUOUS != 0, "the first chunk keeps the one-shot flag");
        assert!(state.chunks[1].flags & BlockFlags::DISCONTINUOUS == 0, "later chunks have it cleared");
        assert!(state.chunks[1].flags & BlockFlags::TRANSPORTING != 0, "state flags persist");
    }
}

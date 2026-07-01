//! Apparat — a SCRIPTABLE instrument. Its DSP is user JavaScript run in the host's AudioWorklet; this Rust
//! side-module is a thin BRIDGE. Matching the TS `ApparatDeviceProcessor`, per block it delivers the block's
//! note-on/note-off events (offset-sorted) to the user `Processor` via `host_script_note_on`/`note_off`, then
//! runs ONE whole-block `process` via `host_script_audio` (the JS bridge zero-fills `[s0,s1)`, runs the user
//! `process(output, block)`, validates, and applies the SimpleLimiter). Samples declared with `@sample` live on
//! dynamic `WerkstattSampleBox` children under the `samples` hub (field 12); the engine resolves each child's
//! `file` and drives `sample_changed`, which the bridge turns into `proc.samples[label]`. All voice/sample state
//! lives in the user `Processor` JS-side; this crate keeps only the bridge handle.
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`,
//! `sample_changed(...)`, `reset(...)`, `observe_param_collection_field() -> 11`, `observe_sample_collection_field() -> 12`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{Block, EventRecord, Ports, ParamValue, DEVICE_KIND_INSTRUMENT, EVENT_NOTE_ON, EVENT_NOTE_OFF, EVENT_CHOKE, EVENT_PARAM};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

/// The bridge state (engine-allocated, zeroed): the device's box uuid and the JS-side bridge handle. No DSP /
/// voice state — it all lives in the user `Processor` on the JS side.
pub struct ApparatState {
    uuid: [u8; 16],
    handle: u32,
    sample_rate: f32
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ApparatState>() as u32
}

#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    11
}

#[no_mangle]
pub extern "C" fn observe_sample_collection_field() -> u32 {
    12
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe {
        abi::with_state::<ApparatState>(state_ptr, |state| {
            state.sample_rate = sample_rate;
            state.uuid = abi::self_uuid();
            state.handle = abi::script_create(&state.uuid, DEVICE_KIND_INSTRUMENT, state_ptr);
        })
    }
}

/// Forward a resolved parameter change to the user `Processor` (the JS bridge maps it via the `@param` mapping).
fn forward_param(state: &mut ApparatState, id: u32, value: ParamValue) {
    abi::script_param(state.handle, id, value);
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe {
        abi::with_state::<ApparatState>(state_ptr, |state| {
            forward_param(state, id, ParamValue::from_wire(kind, value));
        })
    }
}

/// A `@sample` slot's resolved handle (or `present == 0` to clear), keyed by the child's declaration `id`.
#[no_mangle]
pub extern "C" fn sample_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    unsafe {
        abi::with_state::<ApparatState>(state_ptr, |state| {
            abi::script_sample(state.handle, id, handle, present != 0);
        })
    }
}

/// Transport STOP: tell the user `Processor` to reset (drop voices).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state::<ApparatState>(state_ptr, |state| abi::script_reset(state.handle)) }
}

/// Sort key at an equal offset: releases (note-off / choke) before a parameter refresh before note-ons, so a
/// note starting at an update position sees the refreshed parameter and a choke precedes a re-trigger there
/// (mirrors `render_instrument`'s `record_rank`).
fn rank(kind: u32) -> u8 {
    match kind {
        EVENT_NOTE_OFF | EVENT_CHOKE => 0,
        EVENT_PARAM => 1,
        _ => 2
    }
}

/// Render one quantum: per block pull the notes AND append a parameter-update marker at each update position
/// (Route D), offset-sort the combined stream, then walk it — rendering the user `process` over the audio chunk
/// up to each event, delivering note-on/off at note events and refreshing automated `@param`s at the markers.
/// This splits the block at note offsets AND parameter epochs, mirroring `render_instrument`/`dispatch_range`.
#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<ApparatState>::from_descriptor(desc_ptr) };
    let Ports {output, state, blocks, event_scratch, ..} = ports;
    let [out_left, out_right] = output;
    let out_l = out_left.as_ptr() as u32;
    let out_r = out_right.as_ptr() as u32;
    let handle = state.handle;
    for block in blocks {
        let mut count = abi::pull_events(block.p0, block.p1, block.flags.0, event_scratch);
        let mut position = abi::first_update_position(block.p0);
        while position < block.p1 && count < event_scratch.len() {
            event_scratch[count] = EventRecord {position, offset: 0, kind: EVENT_PARAM, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
            count += 1;
            position = abi::next_update_position(position);
        }
        for record in &mut event_scratch[..count] {
            record.offset = abi::pulse_to_offset(record.position).clamp(block.s0, block.s1);
        }
        event_scratch[..count].sort_unstable_by(|a, b| a.offset.cmp(&b.offset).then(rank(a.kind).cmp(&rank(b.kind))));
        let mut cursor = block.s0;
        let mut chunk_p0 = block.p0;
        let mut flags = block.flags;
        for event in &event_scratch[..count] {
            if event.offset > cursor {
                abi::script_audio(handle, 0, 0, out_l, out_r,
                    &Block {index: block.index, flags, p0: chunk_p0, p1: event.position, s0: cursor, s1: event.offset, bpm: block.bpm});
                cursor = event.offset;
                chunk_p0 = event.position;
                flags.clear_event_flags();
            }
            match event.kind {
                EVENT_NOTE_ON => abi::script_note_on(handle, event.pitch, event.velocity, event.cent, event.id),
                EVENT_NOTE_OFF | EVENT_CHOKE => abi::script_note_off(handle, event.id),
                EVENT_PARAM => abi::apply_param_changes(state, event.position, forward_param),
                _ => {}
            }
        }
        abi::script_audio(handle, 0, 0, out_l, out_r,
            &Block {index: block.index, flags, p0: chunk_p0, p1: block.p1, s0: cursor, s1: block.s1, bpm: block.bpm});
    }
}

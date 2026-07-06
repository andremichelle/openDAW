//! Spielwerk — a SCRIPTABLE MIDI effect (note transformer). Its logic is a user JavaScript generator run in the
//! host's AudioWorklet; this Rust side-module is a thin BRIDGE. As a pull source, its `process_events` pulls its
//! own upstream for `[from, to)` ONCE (matching the TS `SpielwerkDeviceProcessor`, which runs the generator once
//! per range, not per update fragment) and hands the input events to the JS script bridge (`host_script_notes`),
//! which runs the user generator plus ALL the stateful note tracking (validation, the future-note scheduler, the
//! note-on/note-off correlation + retainer) and writes the resulting `EventRecord`s back. The bridge's tracking
//! state persists across pulls JS-side; this crate keeps only the bridge handle.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `process_events(...)`, `init(...)`,
//! `parameter_changed(...)`, `observe_param_collection_field() -> 11`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, ParamValue, DEVICE_KIND_MIDI_EFFECT};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

/// The on-stack scratch the device pulls its upstream into before bridging (the device gets a 256 KiB stack).
const PULL_SCRATCH: usize = 256;

const BLANK: EventRecord = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};

/// The bridge state (engine-allocated, zeroed): the device's box uuid and the JS-side bridge handle. The note
/// tracking (retainer, scheduler, correlation) lives JS-side keyed by this handle.
pub struct SpielwerkState {
    uuid: [u8; 16],
    handle: u32,
    sample_rate: f32
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    DEVICE_KIND_MIDI_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<SpielwerkState>() as u32
}

#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    11
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe {
        abi::with_state::<SpielwerkState>(state_ptr, |state| {
            state.sample_rate = sample_rate;
            state.uuid = abi::self_uuid();
            state.handle = abi::script_create(&state.uuid, DEVICE_KIND_MIDI_EFFECT, state_ptr);
        })
    }
}

/// Forward a resolved parameter change to the user `Processor` (the JS bridge maps it via the `@param` mapping).
fn forward_param(state: &mut SpielwerkState, id: u32, value: ParamValue) {
    abi::script_param(state.handle, id, value);
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe {
        abi::with_state::<SpielwerkState>(state_ptr, |state| {
            forward_param(state, id, ParamValue::from_wire(kind, value));
        })
    }
}

/// Pull-responder: pull the upstream notes for `[from, to)` ONCE into the stack scratch, then run the user
/// generator + tracking in the JS bridge, which writes the transformed notes into the host output buffer.
#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut SpielwerkState) };
    // Refresh any automated `@param`s at the range start before running the generator (it transforms the whole
    // `[from, to)` once, matching the TS `SpielwerkDeviceProcessor`, so the range-start value is the right grain).
    abi::apply_param_changes(state, from, forward_param);
    let mut scratch = [BLANK; PULL_SCRATCH];
    let pulled = abi::pull_events(from, to, flags, &mut scratch);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    abi::script_notes(state.handle, &scratch[..pulled], out, from, to, 0.0, flags, 0, 0) as u32
}

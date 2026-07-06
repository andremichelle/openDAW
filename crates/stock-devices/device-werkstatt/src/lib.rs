//! Werkstatt — a SCRIPTABLE audio effect. Its DSP is user JavaScript run in the host's AudioWorklet; this Rust
//! side-module is a thin BRIDGE. Per block it resolves the main input and hands the input + output buffer
//! offsets to the JS script bridge (`host_script_audio`), which runs the user `Processor.process(io, block)`
//! over the shared linear memory. All real state (the user processor instance, the hot-swap, validation) lives
//! JS-side; this crate only marshals offsets and forwards parameter changes. The script's parameters live on
//! dynamic `WerkstattParameterBox` children under the `parameters` hub (field 11); the engine observes that
//! collection and drives `parameter_changed` with each child's declaration index as the id.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(...)`, `observe_param_collection_field() -> 11`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{Block, Ports, ParamValue, DEVICE_KIND_AUDIO_EFFECT, MAIN_INPUT};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

/// The bridge state (engine-allocated, zeroed): the device's box uuid and the JS-side bridge handle. No DSP
/// state — it all lives in the user `Processor` on the JS side.
pub struct WerkstattState {
    uuid: [u8; 16],
    handle: u32,
    sample_rate: f32
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<WerkstattState>() as u32
}

/// The `parameters` hub field key — the engine observes its `WerkstattParameterBox` children and drives
/// `parameter_changed` per child (declaration index as id). Parallel to the `midi_effects_field()` convention.
#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    11
}

/// Boot: stash the sample rate, learn this device's box uuid, and create the JS-side script bridge keyed to it.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe {
        abi::with_state::<WerkstattState>(state_ptr, |state| {
            state.sample_rate = sample_rate;
            state.uuid = abi::self_uuid();
            state.handle = abi::script_create(&state.uuid, DEVICE_KIND_AUDIO_EFFECT, state_ptr);
        })
    }
}

/// Forward a resolved parameter change to the user `Processor` (the JS bridge maps it via the `@param` mapping).
fn forward_param(state: &mut WerkstattState, id: u32, value: ParamValue) {
    abi::script_param(state.handle, id, value);
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe {
        abi::with_state::<WerkstattState>(state_ptr, |state| {
            forward_param(state, id, ParamValue::from_wire(kind, value));
        })
    }
}

/// Render one quantum: resolve the through-input, then per block run the user `process` over the shared buffers,
/// SPLITTING the block at the device's parameter-update positions so an automated `@param` is refreshed between
/// sub-ranges (mirrors `render_effect`'s split loop — the script processes each sub-range whole). A device with
/// no automated parameter sees `first_update_position == INFINITY` and renders the block in one call.
#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<WerkstattState>::from_descriptor(desc_ptr) };
    let Ports {output, state, blocks, ..} = ports;
    let [out_left, out_right] = output;
    let out_l = out_left.as_ptr() as u32;
    let out_r = out_right.as_ptr() as u32;
    let (src_l, src_r) = match abi::resolve_input(MAIN_INPUT) {
        Some(input) => (input.left, input.right),
        None => {
            out_left.fill(0.0); // no upstream -> silence (matches the SDK's `render_effect`)
            out_right.fill(0.0);
            return;
        }
    };
    let handle = state.handle;
    for block in blocks {
        let mut sub_s0 = block.s0;
        let mut sub_p0 = block.p0;
        let mut flags = block.flags;
        let mut position = abi::first_update_position(block.p0);
        while position < block.p1 {
            let offset = abi::pulse_to_offset(position).clamp(block.s0, block.s1);
            if offset > sub_s0 {
                abi::script_audio(handle, src_l, src_r, out_l, out_r,
                    &Block {index: block.index, flags, p0: sub_p0, p1: position, s0: sub_s0, s1: offset, bpm: block.bpm});
                sub_s0 = offset;
                sub_p0 = position;
                flags.clear_event_flags();
            }
            abi::apply_param_changes(state, position, forward_param);
            position = abi::next_update_position(position);
        }
        abi::script_audio(handle, src_l, src_r, out_l, out_r,
            &Block {index: block.index, flags, p0: sub_p0, p1: block.p1, s0: sub_s0, s1: block.s1, bpm: block.bpm});
    }
}

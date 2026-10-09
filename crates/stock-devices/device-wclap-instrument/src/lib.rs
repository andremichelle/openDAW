//! The Wclap instrument device, the instrument twin of `device-wclap`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{AudioInputRef, Block, EventRecord, FieldValue, Instrument, ParamValue, Ports, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use wclap_common::WclapLink;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const AUDIO_INPUTS_FIELD: u16 = 15;
const AUDIO_INPUTS: usize = 8; // WASM CONTRACT: the `audio-inputs` array length of WclapInstrumentBox

pub struct WclapInstrumentState {
    link: WclapLink,
    input_ids: [u32; AUDIO_INPUTS]
}

/// The current chunk's part of a resolved input (its buffers are in absolute quantum coordinates).
fn chunk_of(input: &AudioInputRef, frames: usize) -> Option<[&[f32]; 2]> {
    let range = abi::chunk_start()..abi::chunk_start() + frames;
    let [left, right] = input.channels();
    Some([left.get(range.clone())?, right.get(range)?])
}

pub struct WclapInstrument;

impl Instrument for WclapInstrument {
    type State = WclapInstrumentState;

    fn init(state: &mut WclapInstrumentState, _sample_rate: f32) {
        state.link.init();
        for (index, id) in state.input_ids.iter_mut().enumerate() {
            *id = abi::bind_sidechain(&[AUDIO_INPUTS_FIELD, index as u16]);
        }
    }

    fn parameter_changed(state: &mut WclapInstrumentState, id: u32, value: ParamValue) {
        abi::wclap_param(state.link.bridge, id, value);
    }

    fn field_changed(state: &mut WclapInstrumentState, id: u32, value: FieldValue) {
        state.link.apply_field(id, value);
    }

    fn handle_event(state: &mut WclapInstrumentState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            abi::wclap_note(state.link.bridge, true, event.pitch, event.velocity);
        } else if event.kind == EVENT_NOTE_OFF {
            abi::wclap_note(state.link.bridge, false, event.pitch, event.velocity);
        }
    }

    fn process_audio(state: &mut WclapInstrumentState, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        let frames = out_left.len();
        for index in 1..AUDIO_INPUTS {
            let input = abi::resolve_input(state.input_ids[index]);
            if let Some(chunk) = input.as_ref().and_then(|input| chunk_of(input, frames)) {
                abi::wclap_input(state.link.bridge, index as u32, chunk);
            }
        }
        let main = abi::resolve_input(state.input_ids[0]);
        state.link.process_instrument(main.as_ref().and_then(|input| chunk_of(input, frames)), out_left, out_right, block);
    }

    fn reset(state: &mut WclapInstrumentState) {
        state.link.reset();
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<WclapInstrumentState>() as u32
}

/// WASM CONTRACT: `parameters` hub key 13, children bind `value` (4) and pass `clap-id` (3) as id.
#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    13
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<WclapInstrumentState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<WclapInstrument>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <WclapInstrument as Instrument>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <WclapInstrument as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <WclapInstrument as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <WclapInstrument as Instrument>::reset) }
}

#[no_mangle]
pub extern "C" fn terminate(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut WclapInstrumentState| state.link.release()) }
}

#[cfg(test)]
mod tests {
    use super::{WclapInstrument, WclapInstrumentState};
    use abi::{Block, Instrument};

    #[test]
    fn not_loaded_bridge_adds_nothing() {
        let mut state: WclapInstrumentState = unsafe { core::mem::zeroed() };
        WclapInstrument::init(&mut state, 48_000.0);
        let (mut out_left, mut out_right) = (vec![0.25f32; 128], vec![0.5f32; 128]);
        let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: 128, bpm: 120.0};
        state.link.process_instrument(None, &mut out_left, &mut out_right, &block);
        assert!(out_left.iter().all(|&sample| sample == 0.25));
        assert!(out_right.iter().all(|&sample| sample == 0.5));
    }
}

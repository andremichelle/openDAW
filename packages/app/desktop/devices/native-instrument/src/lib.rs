//! A native plugin instrument, hosted by the desktop engine process through the `host_native_*` imports.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{Block, EventRecord, FieldValue, Instrument, ParamValue, Ports, EVENT_NOTE_OFF, EVENT_NOTE_ON, PARAM_KIND_BOOL, PARAM_KIND_FLOAT, PARAM_KIND_INT, PARAM_KIND_UNIT};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn host_native_create(uuid_ptr: u32) -> u32;
    fn host_native_load(handle: u32, format_ptr: u32, format_len: u32, id_ptr: u32, id_len: u32);
    fn host_native_process(handle: u32, out0_ptr: u32, out1_ptr: u32, frames: u32, bpm: f32, position: f64, flags: u32) -> u32;
    fn host_native_note(handle: u32, on: u32, key: u32, velocity: f32);
    fn host_native_param(handle: u32, id: u32, kind: u32, value: f32, modulation: f32);
    fn host_native_state(handle: u32, bytes_ptr: u32, bytes_len: u32);
    fn host_native_reset(handle: u32);
    fn host_native_release(handle: u32);
}

const RENDER_QUANTUM: usize = 128;
const FORMAT_FIELD: [u16; 1] = [10];
const PLUGIN_ID_FIELD: [u16; 1] = [11];
const STATE_FIELD: [u16; 1] = [12];
const FORMAT_CAPACITY: usize = 16;
const PLUGIN_ID_CAPACITY: usize = 256;

pub struct NativeInstrumentState {
    bridge: u32,
    format_field_id: u32,
    plugin_id_field_id: u32,
    state_field_id: u32,
    format: [u8; FORMAT_CAPACITY],
    format_len: usize,
    plugin_id: [u8; PLUGIN_ID_CAPACITY],
    plugin_id_len: usize,
    scratch: [[f32; RENDER_QUANTUM]; 2]
}

impl NativeInstrumentState {
    fn load(&self) {
        #[cfg(target_family = "wasm")]
        unsafe {
            host_native_load(self.bridge, self.format.as_ptr() as u32, self.format_len as u32,
                             self.plugin_id.as_ptr() as u32, self.plugin_id_len as u32)
        }
    }

    fn run(&mut self, frames: usize, block: &Block) -> bool {
        #[cfg(target_family = "wasm")]
        {
            let [left, right] = &mut self.scratch;
            unsafe {
                host_native_process(self.bridge, left.as_mut_ptr() as u32, right.as_mut_ptr() as u32, frames as u32,
                                    block.bpm, block.p0, block.flags.0) != 0
            }
        }
        #[cfg(not(target_family = "wasm"))]
        { let _ = (frames, block); false }
    }
}

fn copy_into(target: &mut [u8], text: &str) -> usize {
    let bytes = text.as_bytes();
    let len = bytes.len().min(target.len());
    target[..len].copy_from_slice(&bytes[..len]);
    len
}

pub struct NativeInstrument;

impl Instrument for NativeInstrument {
    type State = NativeInstrumentState;

    fn init(state: &mut NativeInstrumentState, _sample_rate: f32) {
        #[cfg(target_family = "wasm")]
        { state.bridge = unsafe { host_native_create(abi::self_uuid().as_ptr() as u32) }; }
        state.format_field_id = abi::observe_field(&FORMAT_FIELD);
        state.plugin_id_field_id = abi::observe_field(&PLUGIN_ID_FIELD);
        state.state_field_id = abi::observe_field(&STATE_FIELD);
    }

    fn parameter_changed(state: &mut NativeInstrumentState, id: u32, value: ParamValue) {
        let (kind, base, modulation) = match value {
            ParamValue::Unit(unit) => (PARAM_KIND_UNIT, unit, f32::NAN),
            ParamValue::Int(int) => (PARAM_KIND_INT, int as f32, f32::NAN),
            ParamValue::Float(float) => (PARAM_KIND_FLOAT, float, f32::NAN),
            ParamValue::Bool(flag) => (PARAM_KIND_BOOL, if flag { 1.0 } else { 0.0 }, f32::NAN),
            ParamValue::Modulated {base, kind, sum} => (kind, base, sum)
        };
        #[cfg(target_family = "wasm")]
        unsafe { host_native_param(state.bridge, id, kind, base, modulation) }
        #[cfg(not(target_family = "wasm"))]
        { let _ = (state, id, kind, base, modulation); }
    }

    fn field_changed(state: &mut NativeInstrumentState, id: u32, value: FieldValue) {
        if id == state.state_field_id {
            let FieldValue::Bytes(bytes) = value else {return};
            #[cfg(target_family = "wasm")]
            unsafe { host_native_state(state.bridge, bytes.as_ptr() as u32, bytes.len() as u32) }
            #[cfg(not(target_family = "wasm"))]
            let _ = bytes;
            return;
        }
        let FieldValue::String(text) = value else {return};
        if id == state.format_field_id {
            state.format_len = copy_into(&mut state.format, text);
        } else if id == state.plugin_id_field_id {
            state.plugin_id_len = copy_into(&mut state.plugin_id, text);
        } else {
            return;
        }
        state.load();
    }

    fn handle_event(state: &mut NativeInstrumentState, event: &EventRecord) {
        let on = if event.kind == EVENT_NOTE_ON { true } else if event.kind == EVENT_NOTE_OFF { false } else { return };
        #[cfg(target_family = "wasm")]
        unsafe { host_native_note(state.bridge, on as u32, event.pitch, event.velocity) }
        #[cfg(not(target_family = "wasm"))]
        { let _ = (state, on); }
    }

    fn process_audio(state: &mut NativeInstrumentState, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        let frames = out_left.len().min(RENDER_QUANTUM);
        if !state.run(frames, block) {return}
        for index in 0..frames {
            out_left[index] += state.scratch[0][index];
            out_right[index] += state.scratch[1][index];
        }
    }

    fn reset(state: &mut NativeInstrumentState) {
        #[cfg(target_family = "wasm")]
        unsafe { host_native_reset(state.bridge) }
        #[cfg(not(target_family = "wasm"))]
        { let _ = state; }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<NativeInstrumentState>() as u32
}

/// WASM CONTRACT: `parameters` hub key 13, children bind `value` (4) and pass their id (3), as WclapParameterBox
#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    13
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<NativeInstrumentState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<NativeInstrument>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NativeInstrument as Instrument>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NativeInstrument as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <NativeInstrument as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <NativeInstrument as Instrument>::reset) }
}

#[no_mangle]
pub extern "C" fn terminate(state_ptr: u32) {
    #[cfg(target_family = "wasm")]
    unsafe { abi::with_state(state_ptr, |state: &mut NativeInstrumentState| host_native_release(state.bridge)) }
    #[cfg(not(target_family = "wasm"))]
    { let _ = state_ptr; }
}

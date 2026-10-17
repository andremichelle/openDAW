//! A native plugin audio effect, hosted by the desktop engine process through the `host_native_*` imports.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{AudioEffect, Block, FieldValue, ParamValue, Ports, PARAM_KIND_BOOL, PARAM_KIND_FLOAT, PARAM_KIND_INT, PARAM_KIND_UNIT};

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
    fn host_native_process_effect(handle: u32, in0_ptr: u32, in1_ptr: u32, out0_ptr: u32, out1_ptr: u32, frames: u32,
                                  bpm: f32, position: f64, flags: u32) -> u32;
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

pub struct NativeEffectState {
    bridge: u32,
    format_field_id: u32,
    plugin_id_field_id: u32,
    state_field_id: u32,
    format: [u8; FORMAT_CAPACITY],
    format_len: usize,
    plugin_id: [u8; PLUGIN_ID_CAPACITY],
    plugin_id_len: usize,
    scratch_in: [[f32; RENDER_QUANTUM]; 2],
    scratch_out: [[f32; RENDER_QUANTUM]; 2]
}

impl NativeEffectState {
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
            let [in_left, in_right] = &self.scratch_in;
            let [out_left, out_right] = &mut self.scratch_out;
            unsafe {
                host_native_process_effect(self.bridge, in_left.as_ptr() as u32, in_right.as_ptr() as u32,
                                           out_left.as_mut_ptr() as u32, out_right.as_mut_ptr() as u32, frames as u32,
                                           block.bpm, block.p0, block.flags.0) != 0
            }
        }
        #[cfg(not(target_family = "wasm"))]
        { let _ = (frames, block); false }
    }

    // the plugin's output, or the input unchanged while the plugin is not ready
    fn process_effect(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32],
                      s0: usize, s1: usize, block: &Block) {
        let frames = (s1 - s0).min(RENDER_QUANTUM);
        let s1 = s0 + frames;
        self.scratch_in[0][..frames].copy_from_slice(&in_left[s0..s1]);
        self.scratch_in[1][..frames].copy_from_slice(&in_right[s0..s1]);
        if self.run(frames, block) {
            out_left[s0..s1].copy_from_slice(&self.scratch_out[0][..frames]);
            out_right[s0..s1].copy_from_slice(&self.scratch_out[1][..frames]);
        } else {
            out_left[s0..s1].copy_from_slice(&in_left[s0..s1]);
            out_right[s0..s1].copy_from_slice(&in_right[s0..s1]);
        }
    }
}

fn copy_into(target: &mut [u8], text: &str) -> usize {
    let bytes = text.as_bytes();
    let len = bytes.len().min(target.len());
    target[..len].copy_from_slice(&bytes[..len]);
    len
}

fn apply_field(state: &mut NativeEffectState, id: u32, value: FieldValue) {
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

pub struct NativeEffect;

impl AudioEffect for NativeEffect {
    type State = NativeEffectState;

    fn init(state: &mut NativeEffectState, _sample_rate: f32) {
        #[cfg(target_family = "wasm")]
        { state.bridge = unsafe { host_native_create(abi::self_uuid().as_ptr() as u32) }; }
        state.format_field_id = abi::observe_field(&FORMAT_FIELD);
        state.plugin_id_field_id = abi::observe_field(&PLUGIN_ID_FIELD);
        state.state_field_id = abi::observe_field(&STATE_FIELD);
    }

    fn parameter_changed(state: &mut NativeEffectState, id: u32, value: ParamValue) {
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

    fn process_audio(state: &mut NativeEffectState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        state.process_effect(in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize, block);
    }

    fn reset(state: &mut NativeEffectState) {
        #[cfg(target_family = "wasm")]
        unsafe { host_native_reset(state.bridge) }
        #[cfg(not(target_family = "wasm"))]
        { let _ = state; }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<NativeEffectState>() as u32
}

/// WASM CONTRACT: `parameters` hub key 13, children bind `value` (4) and pass their id (3), as WclapParameterBox
#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    13
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<NativeEffectState>::from_descriptor(desc_ptr) };
    abi::render_effect::<NativeEffect>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NativeEffect as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NativeEffect as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| apply_field(state, id, FieldValue::from_wire(kind, bits, len))) }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <NativeEffect as AudioEffect>::reset) }
}

#[no_mangle]
pub extern "C" fn terminate(state_ptr: u32) {
    #[cfg(target_family = "wasm")]
    unsafe { abi::with_state(state_ptr, |state: &mut NativeEffectState| host_native_release(state.bridge)) }
    #[cfg(not(target_family = "wasm"))]
    { let _ = state_ptr; }
}

#[cfg(test)]
mod tests {
    use super::NativeEffectState;
    use abi::Block;

    #[test]
    fn passes_the_input_through_until_the_plugin_is_ready() {
        let mut state: NativeEffectState = unsafe { core::mem::zeroed() };
        let in_left: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();
        let in_right: Vec<f32> = (0..128).map(|i| (i as f32 * 0.07).cos()).collect();
        let (mut out_left, mut out_right) = (vec![0.0f32; 128], vec![0.0f32; 128]);
        let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 32, s1: 96, bpm: 120.0};
        state.process_effect(&in_left, &in_right, &mut out_left, &mut out_right, 32, 96, &block);
        assert_eq!(&out_left[32..96], &in_left[32..96]);
        assert_eq!(&out_right[32..96], &in_right[32..96]);
        assert!(out_left[..32].iter().all(|&sample| sample == 0.0));
    }
}

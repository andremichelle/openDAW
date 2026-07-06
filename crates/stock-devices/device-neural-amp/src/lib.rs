//! The NeuralAmp AUDIO-EFFECT device, a faithful port of the TS `NeuralAmpDeviceProcessor`'s WRAPPER: gains,
//! mono downmix, dry/wet mix, and lifecycle live here in Rust; the inference itself runs in the SAME
//! `@opendaw/nam-wasm` module (NeuralAmpModelerCore) the TS engine uses, instantiated next to the engine and
//! reached through the `host_nam_*` JS bridge (script-bridge style; see `packages/app/wasm/src/nam-bridge.ts`).
//! The model JSON travels in the box graph (`NeuralAmpModelBox`, content-addressed): the device observes its
//! `model` pointer (`[20]`) via `observe_target_string` and forwards the delivered JSON to the bridge.
//!
//! Parameters (`NeuralAmpDeviceBox`, mappings from the TS adapter): input-gain `[11]` and output-gain `[12]`
//! (decibel −72..0..12, applied via `db_to_gain`), mix `[14]` (unipolar). `mono` `[13]` is a plain bool FIELD
//! (not automatable), mirroring the TS `monoField.catchupAndSubscribe`.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(...)`, `field_changed(...)`, `reset(state_ptr)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, FieldValue, ParamValue, Ports};
use dsp::analyser::{AudioAnalyser, NUM_BINS};
use dsp::db_to_gain;
use math::value_mapping::{Decibel, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const RENDER_QUANTUM: usize = 128;

// The parameter key PATHs on the `NeuralAmpDeviceBox` (the stable schema keys).
const INPUT_GAIN_FIELD: [u16; 1] = [11];
const OUTPUT_GAIN_FIELD: [u16; 1] = [12];
const MONO_FIELD: [u16; 1] = [13];
const MIX_FIELD: [u16; 1] = [14];
const SPECTRUM_FIELD: [u16; 1] = [0xFFF]; // TS NeuralAmpDeviceBoxAdapter.spectrum
const MODEL_POINTER: [u16; 1] = [20];
// The `NeuralAmpModelBox` string field holding the `.nam` JSON (`model`, key 2), read off the pointer target.
const MODEL_JSON_KEY: u16 = 2;

// This device's value mappings, mirroring the TS adapter (`ValueMapping.decibel(-72, 0, 12)`, linear mix).
const GAIN_MAPPING: Decibel = Decibel::new(-72.0, 0.0, 12.0);
const MIX_MAPPING: Linear = Linear::unipolar();

/// The effect's per-instance state (engine-allocated, zeroed): the JS-bridge handle, the resolved parameter
/// values, the bind/observe ids, and the per-chunk scratch the bridge copies through (≤ one render quantum).
pub struct NeuralAmpState {
    bridge: u32,
    input_gain: f32,
    output_gain: f32,
    mix: f32,
    mono: bool,
    input_gain_id: u32,
    output_gain_id: u32,
    mix_id: u32,
    mono_field_id: u32,
    model_field_id: u32,
    scratch_in: [[f32; RENDER_QUANTUM]; 2],
    scratch_out: [[f32; RENDER_QUANTUM]; 2],
    // The editor's output spectrum (TS `adapter.spectrum` at `[0xFFF]`, decay 0.96): the analyser runs only
    // while the UI subscribes (`broadcast_active`), mirroring TS `#needsSpectrum`.
    analyser: AudioAnalyser,
    spectrum_id: u32,
    spectrum_ptr: u32
}

pub struct NeuralAmpDevice;

impl AudioEffect for NeuralAmpDevice {
    type State = NeuralAmpState;

    fn init(state: &mut NeuralAmpState, _sample_rate: f32) {
        // TS field initializers; the catch-up delivery then pushes the real box values over these.
        state.input_gain = 1.0;
        state.output_gain = 1.0;
        state.mix = 1.0;
        state.mono = true;
        state.bridge = abi::nam_create(&abi::self_uuid());
        state.input_gain_id = abi::bind_parameter(&INPUT_GAIN_FIELD);
        state.output_gain_id = abi::bind_parameter(&OUTPUT_GAIN_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
        state.mono_field_id = abi::observe_field(&MONO_FIELD);
        state.model_field_id = abi::observe_target_string(&MODEL_POINTER, MODEL_JSON_KEY);
        state.analyser.init(0.96); // TS: new AudioAnalyser({decay: 0.96})
        state.spectrum_id = abi::bind_broadcast(&SPECTRUM_FIELD, NUM_BINS as u32);
        state.spectrum_ptr = 0;
    }

    fn parameter_changed(state: &mut NeuralAmpState, id: u32, value: ParamValue) {
        if id == state.input_gain_id {
            state.input_gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.output_gain_id {
            state.output_gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.mix_id {
            state.mix = float_value(value, &MIX_MAPPING);
        }
    }

    fn reset(state: &mut NeuralAmpState) {
        abi::nam_reset(state.bridge);
    }

    fn process_audio(state: &mut NeuralAmpState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        process_chunk(state, in_left, in_right, out_left, out_right, s0, s1);
        if abi::broadcast_active(state.spectrum_id) {
            state.analyser.process(&out_left[s0..s1], &out_right[s0..s1]);
            if state.spectrum_ptr == 0 {
                state.spectrum_ptr = abi::broadcast_ptr(state.spectrum_id);
            }
            if state.spectrum_ptr != 0 {
                let spectrum = unsafe { core::slice::from_raw_parts_mut(state.spectrum_ptr as *mut f32, NUM_BINS) };
                spectrum.copy_from_slice(state.analyser.bins());
                state.analyser.decay = true;
            }
        }
    }
}

/// Apply one observed field: the `mono` bool lands in state and re-shapes the bridge's instances (the TS
/// `#onMonoChanged`); a model JSON delivery (empty = unbound) forwards to the bridge, which copies the bytes
/// out synchronously (the `&str` borrows the box graph only for this call). Public so native tests drive it.
pub fn apply_field(state: &mut NeuralAmpState, id: u32, value: FieldValue) {
    if id == state.mono_field_id {
        if let FieldValue::Bool(mono) = value {
            state.mono = mono;
            abi::nam_set_mono(state.bridge, mono);
        }
    } else if id == state.model_field_id {
        if let FieldValue::String(json) = value {
            abi::nam_load(state.bridge, json);
        }
    }
}

/// One chunk of the TS `processAudio`, over ABSOLUTE quantum coordinates `[s0, s1)`: gain-staged scratch in,
/// one bridge call (`channels` = 1 mono / 2 stereo), dry/wet mix out. A bridge that reports NOT LOADED (module
/// still fetching, no model, or the native stub) is the TS not-ready path: a plain passthrough copy, no gains,
/// no mix. Public so native tests drive it directly (the stub then proves the passthrough).
pub fn process_chunk(state: &mut NeuralAmpState, in_left: &[f32], in_right: &[f32],
                     out_left: &mut [f32], out_right: &mut [f32], s0: usize, s1: usize) {
    let frames = s1 - s0;
    let input_gain = state.input_gain;
    let output_gain = state.output_gain;
    let wet = state.mix;
    let dry = 1.0 - wet;
    let channels = if state.mono {1} else {2};
    if state.mono {
        for i in 0..frames {
            state.scratch_in[0][i] = (in_left[s0 + i] + in_right[s0 + i]) * 0.5 * input_gain;
        }
    } else {
        for i in 0..frames {
            state.scratch_in[0][i] = in_left[s0 + i] * input_gain;
            state.scratch_in[1][i] = in_right[s0 + i] * input_gain;
        }
    }
    let [scratch_out_left, scratch_out_right] = &mut state.scratch_out;
    let processed = abi::nam_process(state.bridge,
        [&state.scratch_in[0], &state.scratch_in[1]],
        [scratch_out_left, scratch_out_right], frames, channels);
    if !processed {
        for i in s0..s1 {
            out_left[i] = in_left[i];
            out_right[i] = in_right[i];
        }
        return;
    }
    if state.mono {
        for i in 0..frames {
            let wet_sample = state.scratch_out[0][i] * output_gain;
            out_left[s0 + i] = in_left[s0 + i] * dry + wet_sample * wet;
            out_right[s0 + i] = in_right[s0 + i] * dry + wet_sample * wet;
        }
    } else {
        for i in 0..frames {
            out_left[s0 + i] = in_left[s0 + i] * dry + state.scratch_out[0][i] * output_gain * wet;
            out_right[s0 + i] = in_right[s0 + i] * dry + state.scratch_out[1][i] * output_gain * wet;
        }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<NeuralAmpState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<NeuralAmpState>::from_descriptor(desc_ptr) };
    abi::render_effect::<NeuralAmpDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NeuralAmpDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NeuralAmpDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 | 1 => float_value(value, &GAIN_MAPPING),
        2 => float_value(value, &MIX_MAPPING),
        _ => f32::NAN
    }
}

/// Apply the observed `mono` bool field (`[13]`) or the model JSON read off the `model` pointer target
/// (`observe_target_string([20], 2)`), forwarding each to the JS bridge.
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut NeuralAmpState| {
            apply_field(state, id, FieldValue::from_wire(kind, bits, len));
        })
    }
}

/// Transport STOP: reset the nam instances' internal DSP state (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <NeuralAmpDevice as AudioEffect>::reset) }
}

/// This device's INSTANCE is dying (a genuine removal, never a chain-edit survivor): release the bridge's
/// nam instance(s), so removing/rebinding a NeuralAmp device no longer leaks its native nam instance(s).
#[no_mangle]
pub extern "C" fn terminate(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut NeuralAmpState| abi::nam_release(state.bridge)) }
}

#[cfg(test)]
mod tests {
    //! The inference runs in the JS-bridged nam module (covered by the wasm wiring/parity tests); natively the
    //! bridge stub reports "not loaded", so these tests prove the WRAPPER: the not-ready passthrough, the
    //! parameter routing with the adapter's exact mappings, and the mono/model field dispatch.
    use super::{apply_field, process_chunk, NeuralAmpDevice, NeuralAmpState, GAIN_MAPPING};
    use abi::{AudioEffect, FieldValue, ParamValue};
    use math::value_mapping::ValueMapping;

    fn state() -> NeuralAmpState {
        let mut state: NeuralAmpState = unsafe { core::mem::zeroed() };
        NeuralAmpDevice::init(&mut state, 48_000.0);
        // `init` binds ids off the (native-stub) host, all 0; assign distinct ids so routing is testable.
        state.input_gain_id = 1;
        state.output_gain_id = 2;
        state.mix_id = 3;
        state.mono_field_id = 10;
        state.model_field_id = 11;
        state
    }

    #[test]
    fn init_defaults_mirror_the_ts_field_initializers() {
        let state = state();
        assert_eq!((state.input_gain, state.output_gain, state.mix, state.mono), (1.0, 1.0, 1.0, true));
    }

    #[test]
    fn gain_parameters_map_decibel_then_convert_to_linear_gain() {
        let mut state = state();
        NeuralAmpDevice::parameter_changed(&mut state, 1, ParamValue::Unit(0.5));
        let expected = dsp::db_to_gain(GAIN_MAPPING.y(0.5));
        assert!((state.input_gain - expected).abs() < 1e-6, "unit 0.5 maps through decibel(-72, 0, 12) then dbToGain");
        assert!((GAIN_MAPPING.y(0.5) - 0.0).abs() < 1e-4, "the mapping's midpoint is 0 dB");
        NeuralAmpDevice::parameter_changed(&mut state, 2, ParamValue::Float(-6.0));
        assert!((state.output_gain - dsp::db_to_gain(-6.0)).abs() < 1e-6, "a real field value converts directly");
    }

    #[test]
    fn mix_parameter_is_unipolar() {
        let mut state = state();
        NeuralAmpDevice::parameter_changed(&mut state, 3, ParamValue::Unit(0.25));
        assert!((state.mix - 0.25).abs() < 1e-6);
    }

    #[test]
    fn mono_and_model_fields_dispatch_by_id() {
        let mut state = state();
        apply_field(&mut state, 10, FieldValue::Bool(false));
        assert!(!state.mono, "the mono field lands in state");
        apply_field(&mut state, 11, FieldValue::String("{}"));
        assert!(!state.mono, "a model delivery leaves mono untouched");
    }

    #[test]
    fn not_loaded_bridge_passes_the_input_through_unmixed() {
        // The native `nam_process` stub reports not-loaded, the TS not-ready path: output == input even with
        // gains/mix set to values that would otherwise change the signal.
        let mut state = state();
        NeuralAmpDevice::parameter_changed(&mut state, 1, ParamValue::Float(12.0));
        NeuralAmpDevice::parameter_changed(&mut state, 3, ParamValue::Float(0.5));
        let in_left: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();
        let in_right: Vec<f32> = (0..128).map(|i| (i as f32 * 0.07).cos()).collect();
        let (mut out_left, mut out_right) = (vec![0.0f32; 128], vec![0.0f32; 128]);
        process_chunk(&mut state, &in_left, &in_right, &mut out_left, &mut out_right, 32, 96);
        assert_eq!(&out_left[32..96], &in_left[32..96], "passthrough copies left");
        assert_eq!(&out_right[32..96], &in_right[32..96], "passthrough copies right");
        assert!(out_left[..32].iter().all(|&sample| sample == 0.0), "outside the chunk range stays untouched");
    }
}

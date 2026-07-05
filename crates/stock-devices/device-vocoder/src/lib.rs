//! The Vocoder AUDIO-EFFECT device, a faithful port of the TS `VocoderDeviceProcessor` over the shared
//! `dsp::vocoder` bank. The CARRIER is the main input (`resolve_input(MAIN_INPUT)`); the MODULATOR is chosen by
//! the `modulatorSource` string field: synthesised noise (white/pink/brown), the carrier itself ("self", a
//! multi-band gate), or an external sidechain ("external", `resolve_input(sidechain)`). `bandCount` (8/12/16)
//! is a non-param field too. The spectrum analyser + peak meters of the TS processor are UI-only and skipped.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(...)`, `init(...)`, `parameter_changed(...)`,
//! `field_changed(...)`, `reset(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, FieldValue, ParamValue, Ports, MAIN_INPUT};
use dsp::vocoder::{NoiseColor, NoiseGenerator, VocoderDsp};
use dsp::analyser::{AudioAnalyser, NUM_BINS};
use math::value_mapping::{Exponential, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const RENDER_QUANTUM: usize = 128;

// Automatable parameter field-keys (mirror VocoderDeviceBox).
const CARRIER_MIN_FIELD: [u16; 1] = [10];
const CARRIER_MAX_FIELD: [u16; 1] = [11];
const MODULATOR_MIN_FIELD: [u16; 1] = [12];
const MODULATOR_MAX_FIELD: [u16; 1] = [13];
const Q_MIN_FIELD: [u16; 1] = [14];
const Q_MAX_FIELD: [u16; 1] = [15];
const ENV_RELEASE_FIELD: [u16; 1] = [16];
const MIX_FIELD: [u16; 1] = [17];
const ENV_ATTACK_FIELD: [u16; 1] = [20];
const GAIN_FIELD: [u16; 1] = [21];
// Non-param fields + the sidechain port.
const BAND_COUNT_FIELD: [u16; 1] = [18];
const MODULATOR_SOURCE_FIELD: [u16; 1] = [19];
const MODULATOR_SPECTRUM_FIELD: [u16; 1] = [0xFFE]; // TS VocoderDeviceBoxAdapter.modulatorSpectrum
const CARRIER_SPECTRUM_FIELD: [u16; 1] = [0xFFF]; // TS VocoderDeviceBoxAdapter.carrierSpectrum
const SIDE_CHAIN_FIELD: [u16; 1] = [30];

// Parameter value-mappings (from VocoderDeviceBoxAdapter).
const FREQ_MAPPING: Exponential = Exponential {min: 20.0, max: 20000.0};
const Q_MAPPING: Exponential = Exponential {min: 1.0, max: 60.0};
const ATTACK_MAPPING: Exponential = Exponential {min: 0.1, max: 100.0}; // ms
const RELEASE_MAPPING: Exponential = Exponential {min: 1.0, max: 1000.0}; // ms
const GAIN_MAPPING: Linear = Linear {min: -20.0, max: 20.0}; // dB
const MIX_MAPPING: Linear = Linear::unipolar();

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    NoiseWhite,
    NoisePink,
    NoiseBrown,
    SelfMod,
    External
}

impl Mode {
    fn from_name(name: &str) -> Self {
        match name {
            "noise-white" => Mode::NoiseWhite,
            "noise-brown" => Mode::NoiseBrown,
            "self" => Mode::SelfMod,
            "external" => Mode::External,
            _ => Mode::NoisePink
        }
    }
}

/// One vocoder instance's state (engine-zeroed, initialised in place). Holds the filter bank, the noise source,
/// two modulator scratch buffers (noise fill / external silence fallback), the resolved parameter + field ids,
/// and the current modulator mode.
pub struct VocoderState {
    dsp: VocoderDsp,
    noise: NoiseGenerator,
    mod_l: [f32; RENDER_QUANTUM],
    mod_r: [f32; RENDER_QUANTUM],
    mode: Mode,
    carrier_min_id: u32,
    carrier_max_id: u32,
    modulator_min_id: u32,
    modulator_max_id: u32,
    q_min_id: u32,
    q_max_id: u32,
    env_release_id: u32,
    mix_id: u32,
    env_attack_id: u32,
    gain_id: u32,
    band_count_field_id: u32,
    modulator_source_field_id: u32,
    sidechain_id: u32,
    // The editor's spectra (one shared analyser, TS `#spectrumMode`): the MODULATOR tap at `[0xFFE]` (the
    // active modulator signal) or the CARRIER tap at `[0xFFF]` (the main input) — analysed only while the
    // UI subscribes; the modulator wins when both are watched.
    analyser: AudioAnalyser,
    mod_spectrum_id: u32,
    mod_spectrum_ptr: u32,
    car_spectrum_id: u32,
    car_spectrum_ptr: u32
}

pub struct Vocoder;

impl AudioEffect for Vocoder {
    type State = VocoderState;

    fn init(state: &mut VocoderState, sample_rate: f32) {
        state.dsp.init(sample_rate);
        state.noise = NoiseGenerator::default();
        state.mode = Mode::NoisePink; // the box default ("noise-pink"); field_changed refines it
        state.carrier_min_id = abi::bind_parameter(&CARRIER_MIN_FIELD);
        state.carrier_max_id = abi::bind_parameter(&CARRIER_MAX_FIELD);
        state.modulator_min_id = abi::bind_parameter(&MODULATOR_MIN_FIELD);
        state.modulator_max_id = abi::bind_parameter(&MODULATOR_MAX_FIELD);
        state.q_min_id = abi::bind_parameter(&Q_MIN_FIELD);
        state.q_max_id = abi::bind_parameter(&Q_MAX_FIELD);
        state.env_release_id = abi::bind_parameter(&ENV_RELEASE_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
        state.env_attack_id = abi::bind_parameter(&ENV_ATTACK_FIELD);
        state.gain_id = abi::bind_parameter(&GAIN_FIELD);
        state.band_count_field_id = abi::observe_field(&BAND_COUNT_FIELD);
        state.modulator_source_field_id = abi::observe_field(&MODULATOR_SOURCE_FIELD);
        state.sidechain_id = abi::bind_sidechain(&SIDE_CHAIN_FIELD);
        state.analyser.init(0.0);
        state.mod_spectrum_id = abi::bind_broadcast(&MODULATOR_SPECTRUM_FIELD, NUM_BINS as u32);
        state.mod_spectrum_ptr = 0;
        state.car_spectrum_id = abi::bind_broadcast(&CARRIER_SPECTRUM_FIELD, NUM_BINS as u32);
        state.car_spectrum_ptr = 0;
    }

    fn process_audio(state: &mut VocoderState, output: [&mut [f32]; 2], block: &Block) {
        let Some(carrier) = abi::resolve_input(MAIN_INPUT) else {return};
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        let car_l = carrier.left();
        let car_r = carrier.right();
        match state.mode {
            Mode::SelfMod => state.dsp.process_self(car_l, car_r, out_left, out_right, s0, s1),
            Mode::NoiseWhite | Mode::NoisePink | Mode::NoiseBrown => {
                let color = match state.mode {
                    Mode::NoiseWhite => NoiseColor::White,
                    Mode::NoiseBrown => NoiseColor::Brown,
                    _ => NoiseColor::Pink
                };
                state.noise.fill(color, &mut state.mod_l, s0, s1);
                state.dsp.process_mono_mod(car_l, car_r, &state.mod_l, out_left, out_right, s0, s1);
            }
            Mode::External => {
                if let Some(sidechain) = abi::resolve_input(state.sidechain_id) {
                    state.dsp.process_stereo_mod(car_l, car_r, sidechain.left(), sidechain.right(), out_left, out_right, s0, s1);
                } else {
                    // One-block silence fallback while the sidechain target resolves (mirrors the TS fallback).
                    for sample in &mut state.mod_l[s0..s1] {*sample = 0.0;}
                    for sample in &mut state.mod_r[s0..s1] {*sample = 0.0;}
                    state.dsp.process_stereo_mod(car_l, car_r, &state.mod_l, &state.mod_r, out_left, out_right, s0, s1);
                }
            }
        }
        let mod_active = abi::broadcast_active(state.mod_spectrum_id);
        let car_active = abi::broadcast_active(state.car_spectrum_id);
        if mod_active {
            match state.mode {
                Mode::NoiseWhite | Mode::NoisePink | Mode::NoiseBrown =>
                    state.analyser.process(&state.mod_l[s0..s1], &state.mod_l[s0..s1]),
                Mode::SelfMod => state.analyser.process(&car_l[s0..s1], &car_r[s0..s1]),
                Mode::External => {
                    if let Some(sidechain) = abi::resolve_input(state.sidechain_id) {
                        state.analyser.process(&sidechain.left()[s0..s1], &sidechain.right()[s0..s1]);
                    }
                }
            }
        } else if car_active {
            state.analyser.process(&car_l[s0..s1], &car_r[s0..s1]);
        }
        if mod_active {
            if state.mod_spectrum_ptr == 0 {
                state.mod_spectrum_ptr = abi::broadcast_ptr(state.mod_spectrum_id);
            }
            if state.mod_spectrum_ptr != 0 {
                let spectrum = unsafe { core::slice::from_raw_parts_mut(state.mod_spectrum_ptr as *mut f32, NUM_BINS) };
                spectrum.copy_from_slice(state.analyser.bins());
                state.analyser.decay = true;
            }
        }
        if car_active {
            if state.car_spectrum_ptr == 0 {
                state.car_spectrum_ptr = abi::broadcast_ptr(state.car_spectrum_id);
            }
            if state.car_spectrum_ptr != 0 {
                let spectrum = unsafe { core::slice::from_raw_parts_mut(state.car_spectrum_ptr as *mut f32, NUM_BINS) };
                spectrum.copy_from_slice(state.analyser.bins());
                state.analyser.decay = true;
            }
        }
    }

    fn parameter_changed(state: &mut VocoderState, id: u32, value: ParamValue) {
        if id == state.carrier_min_id {
            state.dsp.set_carrier_min_freq(float_value(value, &FREQ_MAPPING));
        } else if id == state.carrier_max_id {
            state.dsp.set_carrier_max_freq(float_value(value, &FREQ_MAPPING));
        } else if id == state.modulator_min_id {
            state.dsp.set_modulator_min_freq(float_value(value, &FREQ_MAPPING));
        } else if id == state.modulator_max_id {
            state.dsp.set_modulator_max_freq(float_value(value, &FREQ_MAPPING));
        } else if id == state.q_min_id {
            state.dsp.set_q_min(float_value(value, &Q_MAPPING));
        } else if id == state.q_max_id {
            state.dsp.set_q_max(float_value(value, &Q_MAPPING));
        } else if id == state.env_release_id {
            state.dsp.set_release_seconds(float_value(value, &RELEASE_MAPPING) * 0.001);
        } else if id == state.mix_id {
            state.dsp.set_mix(float_value(value, &MIX_MAPPING));
        } else if id == state.env_attack_id {
            state.dsp.set_attack_seconds(float_value(value, &ATTACK_MAPPING) * 0.001);
        } else if id == state.gain_id {
            state.dsp.set_gain_db(float_value(value, &GAIN_MAPPING));
        }
    }

    fn reset(state: &mut VocoderState) {
        state.dsp.reset();
        state.noise.reset();
        for sample in state.mod_l.iter_mut() {*sample = 0.0;}
        for sample in state.mod_r.iter_mut() {*sample = 0.0;}
    }
}

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<VocoderState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<VocoderState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Vocoder>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Vocoder as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Vocoder as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut VocoderState| {
            let value = FieldValue::from_wire(kind, bits, len);
            if id == state.modulator_source_field_id {
                if let FieldValue::String(name) = value {
                    state.mode = Mode::from_name(name);
                }
            } else if id == state.band_count_field_id {
                if let FieldValue::Int(count) = value {
                    state.dsp.set_band_count(count as usize);
                }
            }
        })
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Vocoder as AudioEffect>::reset) }
}

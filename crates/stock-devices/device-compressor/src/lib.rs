//! The Compressor AUDIO-EFFECT device (a feed-forward dynamics compressor with soft knee, crest-factor
//! auto-attack/release, auto-makeup, look-ahead, and an optional external sidechain), a faithful port of the TS
//! `CompressorDeviceProcessor` (CTAGDRC). The detection signal (sidechain when connected, else the input-gained
//! signal) drives a `GainComputer` -> `LevelDetector` chain; the resulting attenuation, plus makeup, is applied
//! to the (optionally look-ahead-delayed) signal and mixed against the dry.
//!
//! Parameters (`CompressorDeviceBox`): lookahead `[10]`, automakeup `[11]`, autoattack `[12]`, autorelease `[13]`
//! (bools); inputgain `[14]` (dB), threshold `[15]` (dB), ratio `[16]` (exp 1..24), knee `[17]` (dB), attack
//! `[18]` (ms), release `[19]` (ms), makeup `[20]` (dB), mix `[21]` (unipolar); side-chain `[30]` (pointer).
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, AudioEffect, Block, ParamValue, Ports, MAIN_INPUT};
use dsp::ctagdrc::{decibels_to_gain, DelayLine, GainComputer, LevelDetector, LookAhead, SmoothingFilter};
use dsp::{db_to_gain, gain_to_db};
use dsp::ramp::LinearRamp;
use dsp::RENDER_QUANTUM;
use math::value_mapping::{Exponential, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const LOOKAHEAD_FIELD: [u16; 1] = [10];
const AUTOMAKEUP_FIELD: [u16; 1] = [11];
const AUTOATTACK_FIELD: [u16; 1] = [12];
const AUTORELEASE_FIELD: [u16; 1] = [13];
const INPUTGAIN_FIELD: [u16; 1] = [14];
const THRESHOLD_FIELD: [u16; 1] = [15];
const RATIO_FIELD: [u16; 1] = [16];
const KNEE_FIELD: [u16; 1] = [17];
const ATTACK_FIELD: [u16; 1] = [18];
const RELEASE_FIELD: [u16; 1] = [19];
const MAKEUP_FIELD: [u16; 1] = [20];
const MIX_FIELD: [u16; 1] = [21];
const SIDE_CHAIN_FIELD: [u16; 1] = [30];
const EDITOR_FIELD: [u16; 1] = [0]; // live editor values at address.append(0): [input dB, reduction dB, output dB]

const INPUTGAIN_MAPPING: Linear = Linear {min: -30.0, max: 30.0};
const THRESHOLD_MAPPING: Linear = Linear {min: -60.0, max: 0.0};
const RATIO_MAPPING: Exponential = Exponential {min: 1.0, max: 24.0};
const KNEE_MAPPING: Linear = Linear {min: 0.0, max: 24.0};
const ATTACK_MAPPING: Linear = Linear {min: 0.0, max: 100.0};
const RELEASE_MAPPING: Linear = Linear {min: 5.0, max: 1500.0};
const MAKEUP_MAPPING: Linear = Linear {min: -40.0, max: 40.0};
const MIX_MAPPING: Linear = Linear::unipolar();

const LOOKAHEAD_SECONDS: f32 = 0.005;
const AUTO_MAKEUP_ALPHA: f32 = 0.03;

/// The compressor's per-instance state (engine-allocated, zeroed). The CTAGDRC blocks + scratch buffers are
/// built in `init`; the parameters mirror the box fields, `processing` is the TS `#processing` first-block flag.
pub struct CompressorState {
    smooth_input_gain: LinearRamp,
    ballistics: LevelDetector,
    gain_computer: GainComputer,
    delay: DelayLine,
    lookahead_processor: LookAhead,
    smoothed_auto_makeup: SmoothingFilter,
    sidechain_signal: [f32; RENDER_QUANTUM],
    original_left: [f32; RENDER_QUANTUM],
    original_right: [f32; RENDER_QUANTUM],
    lookahead: bool,
    automakeup: bool,
    autoattack: bool,
    autorelease: bool,
    attack_ms: f32,
    release_ms: f32,
    makeup: f32,
    mix: f32,
    processing: bool,
    lookahead_id: u32,
    automakeup_id: u32,
    autoattack_id: u32,
    autorelease_id: u32,
    inputgain_id: u32,
    threshold_id: u32,
    ratio_id: u32,
    knee_id: u32,
    attack_id: u32,
    release_id: u32,
    makeup_id: u32,
    mix_id: u32,
    sidechain_id: u32,
    // Live editor telemetry (TS `#editorValues` at address `[0]`): detection peak, last reduction, output
    // peak — the peaks hold with a 500 ms decay (TS `PEAK_DECAY_PER_SAMPLE`), written per block.
    editor_id: u32,
    editor_ptr: u32,
    editor_peak_decay: f32,
    inp_max: f32,
    out_max: f32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Compressor;

impl AudioEffect for Compressor {
    type State = CompressorState;

    fn init(state: &mut CompressorState, sample_rate: f32) {
        state.smooth_input_gain = LinearRamp::linear(sample_rate, 0.005);
        state.ballistics = LevelDetector::new(sample_rate);
        state.gain_computer = GainComputer::default();
        state.delay = DelayLine::new(sample_rate, LOOKAHEAD_SECONDS);
        state.lookahead_processor = LookAhead::new(sample_rate, LOOKAHEAD_SECONDS);
        state.smoothed_auto_makeup = SmoothingFilter::new(sample_rate);
        state.smoothed_auto_makeup.set_alpha(AUTO_MAKEUP_ALPHA);
        state.attack_ms = 2.0;
        state.release_ms = 140.0;
        state.makeup = 0.0;
        state.mix = 1.0;
        state.processing = false;
        state.lookahead_id = abi::bind_parameter(&LOOKAHEAD_FIELD);
        state.automakeup_id = abi::bind_parameter(&AUTOMAKEUP_FIELD);
        state.autoattack_id = abi::bind_parameter(&AUTOATTACK_FIELD);
        state.autorelease_id = abi::bind_parameter(&AUTORELEASE_FIELD);
        state.inputgain_id = abi::bind_parameter(&INPUTGAIN_FIELD);
        state.threshold_id = abi::bind_parameter(&THRESHOLD_FIELD);
        state.ratio_id = abi::bind_parameter(&RATIO_FIELD);
        state.knee_id = abi::bind_parameter(&KNEE_FIELD);
        state.attack_id = abi::bind_parameter(&ATTACK_FIELD);
        state.release_id = abi::bind_parameter(&RELEASE_FIELD);
        state.makeup_id = abi::bind_parameter(&MAKEUP_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
        state.sidechain_id = abi::bind_sidechain(&SIDE_CHAIN_FIELD);
        state.editor_id = abi::bind_broadcast(&EDITOR_FIELD, 3);
        state.editor_ptr = 0;
        state.editor_peak_decay = libm::expf(-1.0 / (sample_rate * 0.500));
        state.inp_max = 0.0;
        state.out_max = 0.0;
    }

    fn parameter_changed(state: &mut CompressorState, id: u32, value: ParamValue) {
        if id == state.lookahead_id {
            state.lookahead = bool_value(value);
        } else if id == state.automakeup_id {
            state.automakeup = bool_value(value);
        } else if id == state.autoattack_id {
            state.autoattack = bool_value(value);
            state.ballistics.set_auto_attack(state.autoattack);
            if !state.autoattack {
                state.ballistics.set_attack(state.attack_ms * 0.001);
            }
        } else if id == state.autorelease_id {
            state.autorelease = bool_value(value);
            state.ballistics.set_auto_release(state.autorelease);
            if !state.autorelease {
                state.ballistics.set_release(state.release_ms * 0.001);
            }
        } else if id == state.inputgain_id {
            state.smooth_input_gain.set(db_to_gain(float_value(value, &INPUTGAIN_MAPPING)), state.processing);
        } else if id == state.threshold_id {
            state.gain_computer.set_threshold(float_value(value, &THRESHOLD_MAPPING));
        } else if id == state.ratio_id {
            state.gain_computer.set_ratio(float_value(value, &RATIO_MAPPING));
        } else if id == state.knee_id {
            state.gain_computer.set_knee(float_value(value, &KNEE_MAPPING));
        } else if id == state.attack_id {
            state.attack_ms = float_value(value, &ATTACK_MAPPING);
            if !state.autoattack {
                state.ballistics.set_attack(state.attack_ms * 0.001);
            }
        } else if id == state.release_id {
            state.release_ms = float_value(value, &RELEASE_MAPPING);
            if !state.autorelease {
                state.ballistics.set_release(state.release_ms * 0.001);
            }
        } else if id == state.makeup_id {
            state.makeup = float_value(value, &MAKEUP_MAPPING);
        } else if id == state.mix_id {
            state.mix = float_value(value, &MIX_MAPPING);
        }
    }

    fn reset(state: &mut CompressorState) {
        state.processing = false;
    }

    fn process_audio(state: &mut CompressorState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(MAIN_INPUT) else {return};
        let sidechain = abi::resolve_input(state.sidechain_id);
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        // 1) input gain
        for i in s0..s1 {
            let gain = state.smooth_input_gain.move_and_get();
            out_left[i] = in_left[i] * gain;
            out_right[i] = in_right[i] * gain;
        }
        // 2) detection signal: max |L|,|R| of the sidechain if connected, else of the input-gained signal
        match &sidechain {
            Some(sc) => {
                let [sc_left, sc_right] = sc.channels();
                for i in s0..s1 {
                    state.sidechain_signal[i] = libm::fabsf(sc_left[i]).max(libm::fabsf(sc_right[i]));
                }
            }
            None => {
                for i in s0..s1 {
                    state.sidechain_signal[i] = libm::fabsf(out_left[i]).max(libm::fabsf(out_right[i]));
                }
            }
        }
        // Track the detection-signal peak for the editor display (TS `#inpMax`, 500 ms decay).
        for &peak in &state.sidechain_signal[s0..s1] {
            if state.inp_max <= peak {
                state.inp_max = peak;
            } else {
                state.inp_max *= state.editor_peak_decay;
            }
        }
        // 3) crest-factor auto-ballistics, static compression curve, then smoothing ballistics
        state.ballistics.process_crest_factor(&state.sidechain_signal, s0, s1);
        state.gain_computer.apply_compression_to_buffer(&mut state.sidechain_signal, s0, s1);
        state.ballistics.apply_ballistics(&mut state.sidechain_signal, s0, s1);
        let red_min = state.sidechain_signal[s1 - 1]; // TS `#redMin`: the block's last smoothed reduction (dB)
        // 4) auto makeup (mean attenuation, sign-flipped, smoothed)
        let mut sum = 0.0f32;
        for &sample in &state.sidechain_signal[s0..s1] {
            sum += sample;
        }
        state.smoothed_auto_makeup.process(-sum / (s1 - s0) as f32);
        let auto_makeup = if state.automakeup {state.smoothed_auto_makeup.get_state()} else {0.0};
        // 5) look-ahead: delay the signal and fade in the reduction so it lands before the transient
        if state.lookahead {
            state.delay.process([out_left, out_right], s0, s1);
            state.lookahead_processor.process(&mut state.sidechain_signal, s0, s1);
        }
        // 6) makeup + convert to a linear gain
        let makeup = state.makeup;
        for i in s0..s1 {
            state.sidechain_signal[i] = decibels_to_gain(state.sidechain_signal[i] + makeup + auto_makeup);
        }
        // 7) keep the (delayed) dry signal, apply the reduction, then dry/wet mix
        for i in s0..s1 {
            state.original_left[i] = out_left[i];
            state.original_right[i] = out_right[i];
            out_left[i] *= state.sidechain_signal[i];
            out_right[i] *= state.sidechain_signal[i];
        }
        let mix = state.mix;
        for i in s0..s1 {
            let left = out_left[i] * mix + state.original_left[i] * (1.0 - mix);
            let right = out_right[i] * mix + state.original_right[i] * (1.0 - mix);
            let peak = libm::fabsf(left).max(libm::fabsf(right));
            if state.out_max <= peak {
                state.out_max = peak;
            } else {
                state.out_max *= state.editor_peak_decay;
            }
            out_left[i] = left;
            out_right[i] = right;
        }
        if state.editor_ptr == 0 {
            state.editor_ptr = abi::broadcast_ptr(state.editor_id);
        }
        if state.editor_ptr != 0 {
            let editor = unsafe { core::slice::from_raw_parts_mut(state.editor_ptr as *mut f32, 3) };
            editor[0] = gain_to_db(state.inp_max);
            editor[1] = red_min;
            editor[2] = gain_to_db(state.out_max);
        }
        state.processing = true;
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<CompressorState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<CompressorState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Compressor>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Compressor as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Compressor as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Transport STOP: clear the runtime state (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Compressor as AudioEffect>::reset) }
}

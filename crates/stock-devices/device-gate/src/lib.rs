//! The Gate, a noise gate AUDIO EFFECT with an optional sidechain detector, a faithful port of the TS
//! `GateDeviceProcessor`. It passes the main input through, scaled by a gain that opens when the DETECTOR
//! (the sidechain when one is connected, else the main input) rises above a threshold and closes — down to a
//! floor — when it falls below the return threshold and the hold time elapses. The detector is a peak follower
//! with a fixed 10 ms decay; the open/closed target is smoothed by attack / release coefficients.
//!
//! The detector is resolved through the unified input PORT model: `resolve_input(MAIN_INPUT)` is the
//! through-signal it outputs, `resolve_input(sidechain)` the analysis input it detects on when present. So the
//! Gate is a sidechain effect with NO sidechain argument in `process_audio` — it asks for its ports by id, the
//! same way a sampler resolves a sample.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(state_ptr, id, kind, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, AudioEffect, Block, ParamValue, Ports, MAIN_INPUT};
use math::{db_to_gain, gain_to_db};
use math::value_mapping::{Decibel, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

// The Gate box's field-key paths: threshold `[10]` (dB), return `[11]` (dB), attack `[12]` (ms), hold `[13]`
// (ms), release `[14]` (ms), floor `[15]` (dB), inverse `[16]` (bool), and the SIDE-CHAIN pointer `[30]`.
const THRESHOLD_FIELD: [u16; 1] = [10];
const RETURN_FIELD: [u16; 1] = [11];
const ATTACK_FIELD: [u16; 1] = [12];
const HOLD_FIELD: [u16; 1] = [13];
const RELEASE_FIELD: [u16; 1] = [14];
const FLOOR_FIELD: [u16; 1] = [15];
const INVERSE_FIELD: [u16; 1] = [16];
const SIDE_CHAIN_FIELD: [u16; 1] = [30];
const EDITOR_FIELD: [u16; 1] = [0]; // live editor values at address.append(0): [input dB, output dB, envelope dB]

// The AUTOMATION value mappings, mirrored from the TS GateDeviceBoxAdapter (the source of truth, NOT the box
// schema constraints): threshold / return / attack / hold / release are linear, floor is a 3-point decibel
// curve (mid -12 dB at 50%), so the floor automation matches TS sample-for-sample.
const THRESHOLD_MAPPING: Linear = Linear {min: -80.0, max: 0.0};
const RETURN_MAPPING: Linear = Linear {min: 0.0, max: 24.0};
const ATTACK_MAPPING: Linear = Linear {min: 0.0, max: 1000.0};
const HOLD_MAPPING: Linear = Linear {min: 0.0, max: 500.0};
const RELEASE_MAPPING: Linear = Linear {min: 1.0, max: 2000.0};
const FLOOR_MAPPING: Decibel = Decibel::new(-72.0, -12.0, 0.0);

const PEAK_DECAY_SECONDS: f32 = 0.010; // the detector's peak-hold decay time constant (TS PEAK_DECAY_PER_SAMPLE)

/// One-pole smoothing coefficient `exp(-1 / (sample_rate * seconds))`; `seconds == 0` yields `0` (instant).
fn coefficient(sample_rate: f32, seconds: f32) -> f32 {
    libm::expf(-1.0 / (sample_rate * seconds))
}

/// The Gate's per-instance state, from the engine-allocated (zeroed) block: the real parameter values, the
/// values derived from them (recomputed only when a parameter changed), the running detector / envelope state,
/// the sample rate, and the parameter / sidechain ids the engine pushes against.
pub struct GateState {
    threshold_db: f32,
    return_db: f32,
    attack_ms: f32,
    hold_ms: f32,
    release_ms: f32,
    floor_db: f32,
    inverse: bool,
    threshold_gain: f32,
    return_threshold_gain: f32,
    floor_gain: f32,
    hold_samples: f32,
    attack_coeff: f32,
    release_coeff: f32,
    peak_decay: f32,
    dirty: bool,
    inp_max: f32,    // the peak follower's current level
    gate_open: bool, // the gate state-machine output (before smoothing)
    hold_counter: f32,
    envelope: f32,   // the smoothed 0..1 open amount
    out_max: f32,    // the output peak follower for the editor display (TS `#outMax`)
    editor_id: u32,  // live editor broadcast at `[0]`: [input dB, output dB, envelope dB]
    editor_ptr: u32,
    sample_rate: f32,
    threshold_id: u32,
    return_id: u32,
    attack_id: u32,
    hold_id: u32,
    release_id: u32,
    floor_id: u32,
    inverse_id: u32,
    sidechain_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Gate;

impl AudioEffect for Gate {
    type State = GateState;

    fn init(state: &mut GateState, sample_rate: f32) {
        state.sample_rate = sample_rate;
        state.peak_decay = coefficient(sample_rate, PEAK_DECAY_SECONDS);
        // TS box defaults; the engine pushes the real values right after via `parameter_changed`.
        state.threshold_db = -6.0;
        state.return_db = 0.0;
        state.attack_ms = 1.0;
        state.hold_ms = 50.0;
        state.release_ms = 100.0;
        state.floor_db = -72.0;
        state.inverse = false;
        state.envelope = 0.0;
        state.inp_max = 0.0;
        state.gate_open = false;
        state.hold_counter = 0.0;
        state.dirty = true;
        state.threshold_id = abi::bind_parameter(&THRESHOLD_FIELD);
        state.return_id = abi::bind_parameter(&RETURN_FIELD);
        state.attack_id = abi::bind_parameter(&ATTACK_FIELD);
        state.hold_id = abi::bind_parameter(&HOLD_FIELD);
        state.release_id = abi::bind_parameter(&RELEASE_FIELD);
        state.floor_id = abi::bind_parameter(&FLOOR_FIELD);
        state.inverse_id = abi::bind_parameter(&INVERSE_FIELD);
        state.sidechain_id = abi::bind_sidechain(&SIDE_CHAIN_FIELD);
        state.editor_id = abi::bind_broadcast(&EDITOR_FIELD, 3);
        state.editor_ptr = 0;
        state.out_max = 0.0;
    }

    fn process_audio(state: &mut GateState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(MAIN_INPUT) else {return};
        // Detect on the sidechain when it is connected, else on the main input (TS `sideChain.nonEmpty()`).
        let detector = abi::resolve_input(state.sidechain_id).unwrap_or(input);
        let [out_left, out_right] = output;
        Gate::dsp(state, input.left(), input.right(), detector.left(), detector.right(), out_left, out_right,
            block.s0 as usize, block.s1 as usize);
    }

    fn parameter_changed(state: &mut GateState, id: u32, value: ParamValue) {
        if id == state.threshold_id {
            state.threshold_db = float_value(value, &THRESHOLD_MAPPING);
            state.dirty = true;
        } else if id == state.return_id {
            state.return_db = float_value(value, &RETURN_MAPPING);
            state.dirty = true;
        } else if id == state.attack_id {
            state.attack_ms = float_value(value, &ATTACK_MAPPING);
            state.dirty = true;
        } else if id == state.hold_id {
            state.hold_ms = float_value(value, &HOLD_MAPPING);
            state.dirty = true;
        } else if id == state.release_id {
            state.release_ms = float_value(value, &RELEASE_MAPPING);
            state.dirty = true;
        } else if id == state.floor_id {
            state.floor_db = float_value(value, &FLOOR_MAPPING);
            state.dirty = true;
        } else if id == state.inverse_id {
            state.inverse = bool_value(value);
        }
    }

    fn reset(state: &mut GateState) {
        state.envelope = 0.0;
        state.inp_max = 0.0;
        state.gate_open = false;
        state.hold_counter = 0.0;
    }
}

impl Gate {
    /// The pure per-range DSP (unit-tested directly), ported to the letter from the TS process loop. `det_*` is
    /// the detector (sidechain or main); `in_*` the signal that is output, scaled by the gate gain. Indexes
    /// `[s0, s1)` in absolute quantum coordinates; the detector / envelope state persists across calls.
    #[allow(clippy::too_many_arguments)]
    fn dsp(state: &mut GateState, in_left: &[f32], in_right: &[f32], det_left: &[f32], det_right: &[f32],
           out_left: &mut [f32], out_right: &mut [f32], s0: usize, s1: usize) {
        if state.dirty {
            state.threshold_gain = db_to_gain(state.threshold_db);
            state.return_threshold_gain = db_to_gain(state.threshold_db - state.return_db);
            state.floor_gain = db_to_gain(state.floor_db);
            state.hold_samples = state.hold_ms * 0.001 * state.sample_rate;
            state.attack_coeff = coefficient(state.sample_rate, state.attack_ms * 0.001);
            state.release_coeff = coefficient(state.sample_rate, state.release_ms * 0.001);
            state.dirty = false;
        }
        for index in s0..s1 {
            let level = det_left[index].abs().max(det_right[index].abs());
            if state.inp_max <= level {
                state.inp_max = level;
            } else {
                state.inp_max *= state.peak_decay;
            }
            if state.inp_max >= state.threshold_gain {
                state.gate_open = true;
                state.hold_counter = state.hold_samples;
            } else if state.gate_open && state.hold_counter > 0.0 {
                state.hold_counter -= 1.0;
            } else if state.inp_max < state.return_threshold_gain {
                state.gate_open = false;
            }
            let target = if state.inverse != state.gate_open {1.0} else {0.0};
            if target > state.envelope {
                state.envelope = state.attack_coeff * state.envelope + (1.0 - state.attack_coeff) * target;
            } else {
                state.envelope = state.release_coeff * state.envelope + (1.0 - state.release_coeff) * target;
            }
            let gain = state.floor_gain + (1.0 - state.floor_gain) * state.envelope;
            let left = in_left[index] * gain;
            let right = in_right[index] * gain;
            out_left[index] = left;
            out_right[index] = right;
            let out_peak = left.abs().max(right.abs());
            if state.out_max <= out_peak {
                state.out_max = out_peak;
            } else {
                state.out_max *= state.peak_decay;
            }
        }
        if state.editor_ptr == 0 {
            state.editor_ptr = abi::broadcast_ptr(state.editor_id);
        }
        if state.editor_ptr != 0 {
            let editor = unsafe { core::slice::from_raw_parts_mut(state.editor_ptr as *mut f32, 3) };
            editor[0] = gain_to_db(state.inp_max);
            editor[1] = gain_to_db(state.out_max);
            editor[2] = gain_to_db(state.envelope);
        }
    }
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<GateState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<GateState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Gate>(ports);
}

/// Boot hook: bind this device's parameters + its sidechain port with the host, and stash the sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Gate as AudioEffect>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Gate as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &THRESHOLD_MAPPING),
        1 => float_value(value, &RETURN_MAPPING),
        2 => float_value(value, &ATTACK_MAPPING),
        3 => float_value(value, &HOLD_MAPPING),
        4 => float_value(value, &RELEASE_MAPPING),
        5 => float_value(value, &FLOOR_MAPPING),
        6 => if bool_value(value) {1.0} else {0.0},
        _ => f32::NAN
    }
}

/// Transport STOP: clear the detector / envelope so the gate starts closed and silent next playback.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Gate as AudioEffect>::reset(state)) }
}

#[cfg(test)]
mod tests {
    //! The gate DSP: a loud detector opens the gate (the signal passes), a quiet detector closes it (the signal
    //! drops toward the floor). Driven directly, since `resolve_input` has no host on native.
    use super::*;

    const SR: f32 = 48_000.0;

    fn state_for_test() -> GateState {
        let mut state: GateState = unsafe { core::mem::zeroed() };
        state.sample_rate = SR;
        state.peak_decay = coefficient(SR, PEAK_DECAY_SECONDS);
        state.threshold_db = -20.0;
        state.return_db = 6.0;
        state.attack_ms = 0.5;
        state.hold_ms = 5.0;
        state.release_ms = 5.0;
        state.floor_db = -60.0;
        state.inverse = false;
        state.dirty = true;
        state
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample * sample).sum()
    }

    #[test]
    fn opens_on_a_loud_detector_and_closes_on_a_quiet_one() {
        let frames = 8_000;
        let signal = vec![0.5f32; frames]; // the through-signal (DC)
        // The detector is loud for the first half (gate opens), silent for the second (gate closes).
        let mut detector = vec![0.0f32; frames];
        for sample in detector.iter_mut().take(frames / 2) {
            *sample = 0.8;
        }
        let (mut out_left, mut out_right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let mut state = state_for_test();
        Gate::dsp(&mut state, &signal, &signal, &detector, &detector, &mut out_left, &mut out_right, 0, frames);
        let open = energy(&out_left[frames / 4..frames / 2]); // settled, gate open
        let closed = energy(&out_left[frames * 3 / 4..frames]); // settled, gate closed
        assert!(open > energy(&signal[frames / 4..frames / 2]) * 0.8, "the signal passes while the detector is loud");
        assert!(closed < open * 0.05, "the signal is strongly attenuated once the detector goes quiet");
    }

    #[test]
    fn inverse_flips_the_gate() {
        let frames = 8_000;
        let signal = vec![0.5f32; frames];
        let mut detector = vec![0.0f32; frames];
        for sample in detector.iter_mut().take(frames / 2) {
            *sample = 0.8;
        }
        let (mut out_left, mut out_right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let mut state = state_for_test();
        state.inverse = true;
        Gate::dsp(&mut state, &signal, &signal, &detector, &detector, &mut out_left, &mut out_right, 0, frames);
        let loud_detector = energy(&out_left[frames / 4..frames / 2]); // inverse: closed while detector loud
        let quiet_detector = energy(&out_left[frames * 3 / 4..frames]); // inverse: open while detector quiet
        assert!(loud_detector < quiet_detector * 0.05, "inverse closes the gate when the detector is loud");
    }
}

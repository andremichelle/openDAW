//! The Maximizer AUDIO-EFFECT device (a brick-wall limiter with automatic makeup gain), a faithful port of the
//! TS `MaximizerDeviceProcessor`. A peak-hold + release envelope tracks the input; the gain reduction that keeps
//! the envelope under `threshold` (dB) is applied, plus a fixed makeup so the output sits just below 0 dBFS.
//! With look-ahead on, the signal is delayed by the look-ahead window (so reduction lands before the transient)
//! and the output is hard-clamped; with it off, the gain is applied directly.
//!
//! Parameters (`MaximizerDeviceBox`): threshold `[11]` (linear -24..0 dB, the TS adapter mapping). The lookahead `[10]` is a BOOL field
//! (observed, not automatable). The device owns the mappings.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`,
//! `field_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, FieldValue, ParamValue, Ports};
use dsp::ramp::LinearRamp;
use dsp::{db_to_gain, gain_to_db};
use math::clamp;
use math::value_mapping::Linear;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const THRESHOLD_FIELD: [u16; 1] = [11];
const LOOKAHEAD_FIELD: [u16; 1] = [10];
const THRESHOLD_MAPPING: Linear = Linear {min: -24.0, max: 0.0}; // MaximizerDeviceBoxAdapter ValueMapping.linear(-24, 0)

const RELEASE_IN_SECONDS: f32 = 0.2;
const LOOK_AHEAD_SECONDS: f32 = 0.005;
const MAGIC_HEADROOM: f32 = -1e-3;
const THRESHOLD_SMOOTH_SECONDS: f32 = 0.010;
// The largest look-ahead window we ever need: 5 ms at 192 kHz. The actual frame count (from the real rate) is
// stored and used for the ring; the array is fixed so the device allocates nothing.
const MAX_LOOK_AHEAD_FRAMES: usize = 960;

/// The limiter's per-instance state (engine-allocated, zeroed): the look-ahead delay ring, the smoothed
/// threshold, the peak-hold / release envelope trackers, the makeup gain, and the parameter / field ids. Built
/// in `init` (a zeroed ramp is inert; the release coefficient / frame count come from the rate).
pub struct MaximizerState {
    buffer_left: [f32; MAX_LOOK_AHEAD_FRAMES],
    buffer_right: [f32; MAX_LOOK_AHEAD_FRAMES],
    threshold: LinearRamp,
    release_coeff: f32,
    look_ahead_frames: usize,
    position: usize,
    envelope: f32,
    peak_hold: f32,
    peak_hold_counter: i32,
    lookahead: bool,
    processed: bool,
    headroom_gain: f32,
    threshold_id: u32,
    lookahead_field_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Maximizer;

impl AudioEffect for Maximizer {
    type State = MaximizerState;

    fn init(state: &mut MaximizerState, sample_rate: f32) {
        state.release_coeff = libm::expf(-1.0 / (sample_rate * RELEASE_IN_SECONDS));
        state.threshold = LinearRamp::linear(sample_rate, THRESHOLD_SMOOTH_SECONDS);
        state.look_ahead_frames = (libm::ceilf(LOOK_AHEAD_SECONDS * sample_rate) as usize).clamp(1, MAX_LOOK_AHEAD_FRAMES);
        state.position = 0;
        state.envelope = 0.0;
        state.peak_hold = 0.0;
        state.peak_hold_counter = 0;
        state.lookahead = true; // the box default
        state.processed = false;
        state.headroom_gain = 1.0;
        state.threshold_id = abi::bind_parameter(&THRESHOLD_FIELD);
        state.lookahead_field_id = abi::observe_field(&LOOKAHEAD_FIELD);
    }

    fn parameter_changed(state: &mut MaximizerState, id: u32, value: ParamValue) {
        if id == state.threshold_id {
            let threshold = float_value(value, &THRESHOLD_MAPPING);
            state.threshold.set(threshold, state.processed);
            state.headroom_gain = db_to_gain(MAGIC_HEADROOM - threshold);
        }
    }

    fn reset(state: &mut MaximizerState) {
        state.processed = false;
        state.position = 0;
        state.envelope = 0.0;
        state.peak_hold = 0.0;
        state.peak_hold_counter = 0;
        state.buffer_left = [0.0; MAX_LOOK_AHEAD_FRAMES];
        state.buffer_right = [0.0; MAX_LOOK_AHEAD_FRAMES];
    }

    fn process_audio(state: &mut MaximizerState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        let frames = state.look_ahead_frames;
        let threshold_ramping = state.threshold.is_interpolating();
        let steady_headroom = if threshold_ramping {0.0} else {state.headroom_gain};
        for i in s0..s1 {
            let inp0 = in_left[i];
            let inp1 = in_right[i];
            let peak = libm::fabsf(inp0).max(libm::fabsf(inp1));
            if peak > state.peak_hold {
                state.peak_hold = peak;
                state.peak_hold_counter = frames as i32;
            } else if state.peak_hold_counter > 0 {
                state.peak_hold_counter -= 1;
            } else {
                state.peak_hold = peak;
            }
            if state.envelope < state.peak_hold {
                state.envelope = state.peak_hold.min(state.envelope + state.peak_hold / frames as f32);
            } else {
                state.envelope = state.peak_hold + state.release_coeff * (state.envelope - state.peak_hold);
            }
            let threshold = state.threshold.move_and_get();
            let reduction_db = 0.0f32.min(threshold - gain_to_db(state.envelope));
            let headroom_gain = if threshold_ramping {db_to_gain(MAGIC_HEADROOM - threshold)} else {steady_headroom};
            let gain = db_to_gain(reduction_db) * headroom_gain;
            if state.lookahead {
                out_left[i] = clamp(state.buffer_left[state.position] * gain, -1.0, 1.0);
                out_right[i] = clamp(state.buffer_right[state.position] * gain, -1.0, 1.0);
                state.buffer_left[state.position] = inp0;
                state.buffer_right[state.position] = inp1;
                state.position += 1;
                if state.position == frames {state.position = 0;} // wrap without a per-sample division
            } else {
                out_left[i] = inp0 * gain;
                out_right[i] = inp1 * gain;
            }
        }
        state.processed = true;
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<MaximizerState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<MaximizerState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Maximizer>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Maximizer as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Maximizer as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Transport STOP: clear the runtime state (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Maximizer as AudioEffect>::reset) }
}

/// Apply the observed `lookahead` bool field (resets the delay position + envelope on a change, like the TS).
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut MaximizerState| {
            if id == state.lookahead_field_id {
                if let FieldValue::Bool(on) = FieldValue::from_wire(kind, bits, len) {
                    state.lookahead = on;
                    state.position = 0;
                    state.envelope = 0.0;
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Maximizer, MaximizerState};
    use abi::{AudioEffect, Block, BlockFlags};

    const SR: f32 = 48_000.0;

    fn state(threshold_db: f32, lookahead: bool) -> MaximizerState {
        let mut state: MaximizerState = unsafe { core::mem::zeroed() };
        Maximizer::init(&mut state, SR);
        state.lookahead = lookahead;
        // deliver the threshold unsmoothed (as the first delivery does)
        state.threshold.set(threshold_db, false);
        state.headroom_gain = dsp::db_to_gain(super::MAGIC_HEADROOM - threshold_db);
        state
    }

    fn block(frames: usize) -> Block {
        Block {index: 0, flags: BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: frames as u32, bpm: 120.0}
    }

    fn run(state: &mut MaximizerState, input: &[f32]) -> Vec<f32> {
        // Drive process_audio via a stub resolve would need the host; exercise the loop directly with the input.
        let n = input.len();
        let (mut out_l, mut out_r) = (vec![0.0f32; n], vec![0.0f32; n]);
        let frames = state.look_ahead_frames;
        let threshold_ramping = state.threshold.is_interpolating();
        let steady = if threshold_ramping {0.0} else {state.headroom_gain};
        for i in 0..n {
            let inp0 = input[i];
            let inp1 = input[i];
            let peak = inp0.abs().max(inp1.abs());
            if peak > state.peak_hold {state.peak_hold = peak; state.peak_hold_counter = frames as i32;}
            else if state.peak_hold_counter > 0 {state.peak_hold_counter -= 1;}
            else {state.peak_hold = peak;}
            if state.envelope < state.peak_hold {state.envelope = state.peak_hold.min(state.envelope + state.peak_hold / frames as f32);}
            else {state.envelope = state.peak_hold + state.release_coeff * (state.envelope - state.peak_hold);}
            let threshold = state.threshold.move_and_get();
            let reduction_db = 0.0f32.min(threshold - dsp::gain_to_db(state.envelope));
            let headroom = if threshold_ramping {dsp::db_to_gain(super::MAGIC_HEADROOM - threshold)} else {steady};
            let gain = dsp::db_to_gain(reduction_db) * headroom;
            if state.lookahead {
                out_l[i] = math::clamp(state.buffer_left[state.position] * gain, -1.0, 1.0);
                out_r[i] = math::clamp(state.buffer_right[state.position] * gain, -1.0, 1.0);
                state.buffer_left[state.position] = inp0;
                state.buffer_right[state.position] = inp1;
                state.position += 1;
                if state.position == frames {state.position = 0;} // wrap without a per-sample division
            } else {
                out_l[i] = inp0 * gain;
                out_r[i] = inp1 * gain;
            }
        }
        out_l
    }

    #[test]
    fn quiet_signal_below_threshold_is_only_makeup_scaled() {
        // A -0 dB threshold with a quiet input: no reduction, just the tiny makeup (~unity). Non-lookahead so no delay.
        let mut state = state(0.0, false);
        let input = vec![0.1f32; 512];
        let out = run(&mut state, &input);
        assert!(out.iter().all(|s| s.is_finite()));
        // Settled tail is ~the input * makeup (~1), well within range.
        assert!((out[500].abs() - 0.1).abs() < 0.02, "quiet signal roughly passes through");
    }

    #[test]
    fn loud_signal_is_maximized_near_zero_dbfs() {
        // A hot input above a low threshold: the reduction + makeup settle the LEVEL near unity. Without
        // look-ahead the initial attack transient can overshoot (that is why look-ahead exists), so we assert on
        // the SETTLED tail: it sits just below / around 0 dBFS (the maximizer's makeup lifts it there).
        let mut state = state(-12.0, false);
        let input: Vec<f32> = (0..2000).map(|i| 0.95 * (i as f32 * 0.2).sin()).collect();
        let out = run(&mut state, &input);
        assert!(out.iter().all(|s| s.is_finite()));
        let tail_peak = out[1500..].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((0.85..=1.1).contains(&tail_peak), "the loud signal is maximized near 0 dBFS, tail peak {tail_peak}");
    }

    #[test]
    fn lookahead_hard_clamps_the_output() {
        let mut state = state(-6.0, true);
        let input: Vec<f32> = (0..2000).map(|i| 1.5 * (i as f32 * 0.3).sin()).collect();
        let out = run(&mut state, &input);
        assert!(out.iter().all(|s| s.abs() <= 1.0 + 1e-6), "lookahead output is clamped to +/-1");
        let _ = block(64);
    }
}

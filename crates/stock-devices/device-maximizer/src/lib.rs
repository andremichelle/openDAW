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
use dsp::meter::StereoMeter;
use dsp::ramp::LinearRamp;
use dsp::{db_to_gain, gain_to_db};
use math::clamp;
use math::value_mapping::Linear;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const THRESHOLD_FIELD: [u16; 1] = [11];
const LOOKAHEAD_FIELD: [u16; 1] = [10];
const REDUCTION_FIELD: [u16; 1] = [0]; // live reduction (dB, min-held) at address.append(0)
const INPUT_PEAKS_FIELD: [u16; 1] = [1]; // input peak/rms meter at address.append(1) (TS `#inputPeaks`)
const THRESHOLD_MAPPING: Linear = Linear {min: -24.0, max: 0.0}; // MaximizerDeviceBoxAdapter ValueMapping.linear(-24, 0)

const RELEASE_IN_SECONDS: f32 = 0.2;
const LOOK_AHEAD_SECONDS: f32 = 0.005;
const MAGIC_HEADROOM: f32 = -1e-3;
const THRESHOLD_SMOOTH_SECONDS: f32 = 0.010;
// Crossfade window for toggling look-ahead (the toggle changes the output latency, so fade instead of jump, #79).
const LOOKAHEAD_CROSSFADE_SECONDS: f32 = 0.015;
// The largest look-ahead window we ever need: 5 ms at 192 kHz. The actual frame count (from the real rate) is
// stored and used for the ring; the array is fixed so the device allocates nothing.
const MAX_LOOK_AHEAD_FRAMES: usize = 960;
const SMOOTHING_PASSES: usize = 3; // together they span the look-ahead, so the gain arrives before the peak
const MAX_SMOOTHING_FRAMES: usize = MAX_LOOK_AHEAD_FRAMES / SMOOTHING_PASSES;

/// The largest of the last `size` values, in constant time per value on average (a monotonic queue).
struct PeakWindow {
    peaks: [f32; MAX_LOOK_AHEAD_FRAMES + 1],
    ages: [u32; MAX_LOOK_AHEAD_FRAMES + 1],
    head: usize,
    length: usize,
    now: u32,
    size: usize
}

impl PeakWindow {
    fn init(&mut self, size: usize) {
        self.size = size.clamp(1, MAX_LOOK_AHEAD_FRAMES + 1);
        self.reset();
    }

    fn reset(&mut self) {
        self.head = 0;
        self.length = 0;
        self.now = 0;
    }

    fn process(&mut self, peak: f32) -> f32 {
        let capacity = self.peaks.len();
        if self.length > 0 && self.now.wrapping_sub(self.ages[self.head]) >= self.size as u32 {
            self.head = (self.head + 1) % capacity;
            self.length -= 1;
        }
        while self.length > 0 && self.peaks[(self.head + self.length - 1) % capacity] <= peak {
            self.length -= 1;
        }
        let tail = (self.head + self.length) % capacity;
        self.peaks[tail] = peak;
        self.ages[tail] = self.now;
        self.length += 1;
        self.now = self.now.wrapping_add(1);
        self.peaks[self.head]
    }
}

/// A moving average of the last `size` values, zero before any input (no reduction).
struct MovingAverage {
    values: [f32; MAX_SMOOTHING_FRAMES],
    sum: f64,
    position: usize,
    size: usize
}

impl MovingAverage {
    fn init(&mut self, size: usize) {
        self.size = size.clamp(1, MAX_SMOOTHING_FRAMES);
        self.reset();
    }

    fn reset(&mut self) {
        self.values = [0.0; MAX_SMOOTHING_FRAMES];
        self.sum = 0.0;
        self.position = 0;
    }

    fn process(&mut self, value: f32) -> f32 {
        self.sum += value as f64 - self.values[self.position] as f64;
        self.values[self.position] = value;
        self.position += 1;
        if self.position == self.size {self.position = 0;}
        (self.sum / self.size as f64) as f32
    }
}

/// The limiter's per-instance state (engine-allocated, zeroed): the look-ahead delay ring, the smoothed
/// threshold, the peak-hold / release envelope trackers, the makeup gain, and the parameter / field ids. Built
/// in `init` (a zeroed ramp is inert; the release coefficient / frame count come from the rate).
pub struct MaximizerState {
    buffer_left: [f32; MAX_LOOK_AHEAD_FRAMES],
    buffer_right: [f32; MAX_LOOK_AHEAD_FRAMES],
    threshold: LinearRamp,
    lookahead_mix: LinearRamp, // crossfade 0 (off) .. 1 (on) so a look-ahead toggle ramps across the latency change
    release_coeff: f32,
    look_ahead_frames: usize,
    smoothing: [MovingAverage; SMOOTHING_PASSES],
    position: usize,
    envelope: f32,
    peak_window: PeakWindow,
    lookahead: bool,
    processed: bool,
    headroom_gain: f32,
    threshold_id: u32,
    lookahead_field_id: u32,
    // Live telemetry: the min-held reduction at `[0]` (TS resets it per UI tick; here per block — the UI
    // samples the last block's min) and the INPUT peak/rms meter at `[1]` (TS `#inputPeaks`).
    reduction_id: u32,
    reduction_ptr: u32,
    reduction_min: f32,
    input_meter: StereoMeter,
    input_peaks_id: u32,
    input_peaks_ptr: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Maximizer;

impl AudioEffect for Maximizer {
    type State = MaximizerState;

    fn init(state: &mut MaximizerState, sample_rate: f32) {
        state.release_coeff = libm::expf(-1.0 / (sample_rate * RELEASE_IN_SECONDS));
        state.threshold = LinearRamp::linear(sample_rate, THRESHOLD_SMOOTH_SECONDS);
        state.lookahead_mix = LinearRamp::linear(sample_rate, LOOKAHEAD_CROSSFADE_SECONDS);
        state.lookahead_mix.set(1.0, false); // lookahead defaults on; the field catch-up re-sets the real value
        state.look_ahead_frames = (libm::ceilf(LOOK_AHEAD_SECONDS * sample_rate) as usize).clamp(1, MAX_LOOK_AHEAD_FRAMES);
        let smoothing_frames = (state.look_ahead_frames / SMOOTHING_PASSES).max(1);
        for average in &mut state.smoothing {
            average.init(smoothing_frames);
        }
        state.position = 0;
        state.envelope = 0.0;
        state.peak_window.init(state.look_ahead_frames + 1);
        state.lookahead = true; // the box default
        state.processed = false;
        state.headroom_gain = 1.0;
        state.threshold_id = abi::bind_parameter(&THRESHOLD_FIELD);
        state.lookahead_field_id = abi::observe_field(&LOOKAHEAD_FIELD);
        abi::set_latency(state.look_ahead_frames as u32);
        state.reduction_id = abi::bind_broadcast(&REDUCTION_FIELD, 1);
        state.reduction_ptr = 0;
        state.reduction_min = 0.0;
        state.input_meter.init(sample_rate);
        state.input_peaks_id = abi::bind_broadcast(&INPUT_PEAKS_FIELD, 4);
        state.input_peaks_ptr = 0;
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
        state.peak_window.reset();
        for average in &mut state.smoothing {
            average.reset();
        }
        state.buffer_left = [0.0; MAX_LOOK_AHEAD_FRAMES];
        state.buffer_right = [0.0; MAX_LOOK_AHEAD_FRAMES];
        state.lookahead_mix.set(if state.lookahead {1.0} else {0.0}, false);
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
            let peak_hold = state.peak_window.process(peak);
            state.envelope = if state.envelope < peak_hold {
                peak_hold
            } else {
                peak_hold + state.release_coeff * (state.envelope - peak_hold)
            };
            let threshold = state.threshold.move_and_get();
            let mut reduction_db = 0.0f32.min(threshold - gain_to_db(state.envelope));
            for average in &mut state.smoothing {
                reduction_db = average.process(reduction_db);
            }
            if reduction_db < state.reduction_min {
                state.reduction_min = reduction_db;
            }
            let headroom_gain = if threshold_ramping {db_to_gain(MAGIC_HEADROOM - threshold)} else {steady_headroom};
            let gain = db_to_gain(reduction_db) * headroom_gain;
            // Same gain, applied to the immediate signal (off) or the look-ahead-delayed + clamped signal (on).
            // The ring advances EVERY sample so it never goes stale, and `lookahead_mix` crossfades the two paths
            // when the toggle flips (#79), instead of the old hard switch + ring reset.
            let off0 = inp0 * gain;
            let off1 = inp1 * gain;
            let on0 = clamp(state.buffer_left[state.position] * gain, -1.0, 1.0);
            let on1 = clamp(state.buffer_right[state.position] * gain, -1.0, 1.0);
            state.buffer_left[state.position] = inp0;
            state.buffer_right[state.position] = inp1;
            state.position += 1;
            if state.position == frames {state.position = 0;} // wrap without a per-sample division
            let blend = state.lookahead_mix.move_and_get();
            out_left[i] = off0 * (1.0 - blend) + on0 * blend;
            out_right[i] = off1 * (1.0 - blend) + on1 * blend;
        }
        if state.reduction_ptr == 0 {
            state.reduction_ptr = abi::broadcast_ptr(state.reduction_id);
        }
        if state.reduction_ptr != 0 {
            unsafe { *(state.reduction_ptr as *mut f32) = state.reduction_min; }
            state.reduction_min = 0.0;
        }
        if state.input_peaks_ptr == 0 {
            state.input_peaks_ptr = abi::broadcast_ptr(state.input_peaks_id);
        }
        if state.input_peaks_ptr != 0 {
            let values = unsafe { core::slice::from_raw_parts_mut(state.input_peaks_ptr as *mut f32, 4) };
            state.input_meter.process(&in_left[s0..s1], &in_right[s0..s1], values);
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
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Maximizer as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &THRESHOLD_MAPPING),
        _ => f32::NAN
    }
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
                    state.lookahead_mix.set(if on {1.0} else {0.0}, state.processed);
                    abi::set_latency(if on {state.look_ahead_frames as u32} else {0});
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Maximizer, MaximizerState, MovingAverage, PeakWindow};
    use abi::{AudioEffect, Block, BlockFlags};

    const SR: f32 = 48_000.0;

    #[test]
    fn smoothing_fits_the_look_ahead_at_every_rate() {
        for sample_rate in [22_050.0f32, 44_100.0, 48_000.0, 88_200.0, 96_000.0, 192_000.0] {
            let mut state: MaximizerState = unsafe { core::mem::zeroed() };
            Maximizer::init(&mut state, sample_rate);
            let total: usize = state.smoothing.iter().map(|average| average.size).sum();
            assert!(total <= state.look_ahead_frames, "{sample_rate} Hz");
            assert!(total + 3 > state.look_ahead_frames, "{sample_rate} Hz");
        }
    }

    #[test]
    fn peak_window_matches_a_brute_force_maximum() {
        for size in [1usize, 2, 7, 241, 961] {
            let mut window: PeakWindow = unsafe { core::mem::zeroed() };
            window.init(size);
            let mut seed = 12345u32;
            let values: Vec<f32> = (0..20_000).map(|index| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                match index / 5000 {
                    0 => (seed >> 16) as f32 / 65536.0,
                    1 => 1.0 - index as f32 * 1e-5,
                    2 => index as f32 * 1e-5,
                    _ => 0.5
                }
            }).collect();
            for (index, value) in values.iter().enumerate() {
                let expected = values[(index + 1).saturating_sub(size)..=index].iter().fold(0.0f32, |max, entry| max.max(*entry));
                assert_eq!(window.process(*value), expected, "size {size} index {index}");
            }
        }
    }

    #[test]
    fn peak_window_reset_forgets() {
        let mut window: PeakWindow = unsafe { core::mem::zeroed() };
        window.init(10);
        window.process(1.0);
        window.reset();
        assert_eq!(window.process(0.25), 0.25);
    }

    #[test]
    fn moving_average_settles_and_does_not_drift() {
        let mut average: MovingAverage = unsafe { core::mem::zeroed() };
        average.init(24);
        assert_eq!(average.process(-24.0), -1.0);
        for index in 0..10_000_000 {
            average.process(-(index % 97) as f32 * 0.137);
        }
        let settled = (0..24).fold(0.0, |_, _| average.process(-6.0));
        assert!((settled + 6.0).abs() < 1e-6, "settled at {settled}");
    }

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
        Block {index: 0, flags: BlockFlags(0), p0: 0.0, p1: 0.0, anchor: 0.0, anchor_frame: 0, s0: 0, s1: frames as u32, bpm: 120.0}
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
            let peak_hold = state.peak_window.process(peak);
            state.envelope = if state.envelope < peak_hold {peak_hold} else {peak_hold + state.release_coeff * (state.envelope - peak_hold)};
            let threshold = state.threshold.move_and_get();
            let mut reduction_db = 0.0f32.min(threshold - dsp::gain_to_db(state.envelope));
            for average in &mut state.smoothing {
                reduction_db = average.process(reduction_db);
            }
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

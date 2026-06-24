//! The Tidal auto-pan / tremolo as a runtime-loadable AUDIO-EFFECT device, a faithful port of the TS
//! `TidalDeviceProcessor`. A tempo-synced LFO (`dsp::tidal::TidalComputer`, shaped by depth / slope /
//! symmetry) modulates the gain of each channel; a per-channel phase `offset` moves left and right apart,
//! so the effect auto-pans. The LFO phase is driven by the song position (`block.p0 + i * delta`), so it
//! locks to tempo. Each channel's gain is one-pole smoothed (`dsp::smooth::Smooth`).
//!
//! The parameters are the `TidalDeviceBox` fields (all float32): slope `[10]` (bipolar), symmetry `[11]`
//! (unipolar), rate `[20]` (an index into the rate-fraction table), depth `[21]` (unipolar), offset `[22]`
//! and channel-offset `[23]` (degrees, -180..180). The device owns the mappings; the host is mapping-agnostic.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr)`,
//! `parameter_changed(state_ptr, id, kind, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, ParamValue, Ports};
use dsp::ppqn;
use dsp::smooth::Smooth;
use dsp::tidal::TidalComputer;
use math::value_mapping::{Linear, LinearInteger, ValueMapping};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The parameter field-key PATHs on the `TidalDeviceBox` (the stable schema keys, passed to the host as-is).
const SLOPE_FIELD: [u16; 1] = [10];
const SYMMETRY_FIELD: [u16; 1] = [11];
const RATE_FIELD: [u16; 1] = [20];
const DEPTH_FIELD: [u16; 1] = [21];
const OFFSET_FIELD: [u16; 1] = [22];
const CHANNEL_OFFSET_FIELD: [u16; 1] = [23];

// This device's value mappings (uniform 0..1 -> the parameter's real value), mirroring the TS adapter.
const SLOPE_MAPPING: Linear = Linear::bipolar();
const SYMMETRY_MAPPING: Linear = Linear::unipolar();
const DEPTH_MAPPING: Linear = Linear::unipolar();
const OFFSET_MAPPING: Linear = Linear {min: -180.0, max: 180.0};
const CHANNEL_OFFSET_MAPPING: Linear = Linear {min: -180.0, max: 180.0};
// The rate parameter selects a fraction by INDEX. The TS uses `values(RateFractions.map((_, i) => i))`; over
// contiguous indices that is exactly a linear-integer map onto `0 ..= len - 1`.
const RATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: RATE_FRACTIONS.len() as i32 - 1};

// The rate fractions (numerator, denominator), `TidalDeviceBoxAdapter.RateFractions` in DESCENDING value
// order (which is also the order they are declared, since they decrease monotonically). The rate parameter
// indexes this table. A fraction's period in pulses is `floor(BAR / denominator) * numerator` (PPQN.fromSignature).
const RATE_FRACTIONS: [(i32, i32); 17] = [
    (1, 1), (1, 2), (1, 3), (1, 4), (3, 16), (1, 6), (1, 8), (3, 32), (1, 12),
    (1, 16), (3, 64), (1, 24), (1, 32), (1, 48), (1, 64), (1, 96), (1, 128)
];
const SMOOTH_TIME_SECONDS: f64 = 0.003; // the TS gain smoother's time constant

/// The effect's per-instance state, interpreted from the engine-allocated (zeroed) block: the shaped LFO, a
/// one-pole gain smoother per channel, the current parameter values (`depth` / `slope` / `symmetry` reshape
/// the LFO, so `needs_update` marks them stale), the device's sample rate, and the parameter ids `init` got
/// back. Valid when zeroed (silent-ish) until the engine pushes the defaults.
pub struct TidalState {
    computer: TidalComputer,
    smooth: [Smooth; 2],
    sample_rate: f32,
    depth: f32,
    slope: f32,
    symmetry: f32,
    offset_degrees: f32,
    channel_offset_degrees: f32,
    rate_index: i32,
    needs_update: bool,
    slope_id: u32,
    symmetry_id: u32,
    rate_index_id: u32,
    depth_id: u32,
    offset_degrees_id: u32,
    channel_offset_degrees_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Tidal;

impl AudioEffect for Tidal {
    type State = TidalState;

    fn init(state: &mut TidalState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life
        state.slope_id = abi::bind_parameter(&SLOPE_FIELD);
        state.symmetry_id = abi::bind_parameter(&SYMMETRY_FIELD);
        state.rate_index_id = abi::bind_parameter(&RATE_FIELD);
        state.depth_id = abi::bind_parameter(&DEPTH_FIELD);
        state.offset_degrees_id = abi::bind_parameter(&OFFSET_FIELD);
        state.channel_offset_degrees_id = abi::bind_parameter(&CHANNEL_OFFSET_FIELD);
        state.needs_update = true; // recompute the LFO shape on the first block
    }

    fn parameter_changed(state: &mut TidalState, id: u32, value: ParamValue) {
        // depth / slope / symmetry reshape the LFO (recomputed lazily on the next block); rate / offset /
        // channel-offset are read per sample, so they only update the stored value.
        if id == state.slope_id {
            state.slope = float_value(value, &SLOPE_MAPPING);
            state.needs_update = true;
        } else if id == state.symmetry_id {
            state.symmetry = float_value(value, &SYMMETRY_MAPPING);
            state.needs_update = true;
        } else if id == state.depth_id {
            state.depth = float_value(value, &DEPTH_MAPPING);
            state.needs_update = true;
        } else if id == state.offset_degrees_id {
            state.offset_degrees = float_value(value, &OFFSET_MAPPING);
        } else if id == state.channel_offset_degrees_id {
            state.channel_offset_degrees = float_value(value, &CHANNEL_OFFSET_MAPPING);
        } else if id == state.rate_index_id {
            state.rate_index = match value {
                ParamValue::Unit(unit) => RATE_MAPPING.y(unit),
                ParamValue::Float(real) => real as i32,
                _ => panic!("tidal rate expects a unit or float value")
            };
        }
    }

    fn process_audio(state: &mut TidalState, input: [&[f32]; 2], output: [&mut [f32]; 2], block: &Block) {
        let [in_left, in_right] = input;
        let [out_left, out_right] = output;
        if state.needs_update {
            state.computer.set(state.depth as f64, state.slope as f64, state.symmetry as f64);
            state.needs_update = false;
        }
        let smooth_coeff = Smooth::coefficient(SMOOTH_TIME_SECONDS, state.sample_rate as f64);
        let delta = ppqn::samples_to_pulses(1.0, block.bpm, state.sample_rate); // pulses advanced per sample
        let index = state.rate_index.clamp(0, RATE_FRACTIONS.len() as i32 - 1) as usize;
        let (numerator, denominator) = RATE_FRACTIONS[index];
        let rate_inverse = 1.0 / ppqn::from_signature(numerator, denominator);
        let offset0 = state.offset_degrees as f64 / 360.0;
        let offset1 = offset0 + state.channel_offset_degrees as f64 / 360.0;
        for sample in 0..out_left.len() {
            let position = block.p0 + sample as f64 * delta;
            // `compute` takes the fractional part of the phase itself, so no floor is needed here.
            let gain_left = state.smooth[0].process(smooth_coeff, state.computer.compute(position * rate_inverse + offset0));
            let gain_right = state.smooth[1].process(smooth_coeff, state.computer.compute(position * rate_inverse + offset1));
            out_left[sample] = in_left[sample] * gain_left as f32;
            out_right[sample] = in_right[sample] * gain_right as f32;
        }
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
    core::mem::size_of::<TidalState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<TidalState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Tidal>(ports);
}

/// Boot hook: bind this device's parameters with the host (it records their field-paths and returns an id
/// each) and stash the (stable) sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Tidal as AudioEffect>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back. The
/// `kind` tag tells the SDK how to type the f32 `value` into a `ParamValue`.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Tidal as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[cfg(test)]
mod tests {
    //! The Tidal modulation (driven via the ABI's `AudioEffect`): a DC input is shaped by the LFO gain, so
    //! the output traces the LFO; a per-channel offset moves left and right apart (auto-pan). In-crate so it
    //! can set the private state.
    use super::{Tidal, TidalState};
    use abi::{AudioEffect, Block, BlockFlags};

    const SR: f32 = 48_000.0;

    fn state() -> TidalState {
        let mut state: TidalState = unsafe { core::mem::zeroed() };
        state.sample_rate = SR;
        // A symmetric, full-depth triangle at the default quarter-note rate (index 3).
        state.depth = 1.0;
        state.slope = 0.0;
        state.symmetry = 0.5;
        state.rate_index = 3;
        state.needs_update = true;
        state
    }

    // One block covering `frames` samples starting at pulse `p0`, at `bpm`.
    fn block(p0: f64, frames: usize, bpm: f32) -> Block {
        Block {index: 0, flags: BlockFlags(0), p0, p1: p0 + frames as f64, s0: 0, s1: frames as u32, bpm}
    }

    #[test]
    fn modulates_a_dc_input_with_the_lfo() {
        // A quarter note at 120 bpm is 960 pulses = 0.5 s = 24000 samples. Over one full period the gain
        // should reach near its trough (~0) and near its peak (~1), so a DC input is clearly modulated.
        let mut state = state();
        let frames = 24_000;
        let input = vec![1.0f32; frames];
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        Tidal::process_audio(&mut state, [&input, &input], [&mut left, &mut right], &block(0.0, frames, 120.0));
        let min = left.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = left.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(min < 0.1, "the trough nearly closes the gain");
        assert!(max > 0.9, "the peak nearly opens it");
    }

    #[test]
    fn a_channel_offset_pans_left_and_right_apart() {
        // With a 90-degree channel offset the two channels are a quarter-period apart, so their gains differ.
        let mut state = state();
        state.channel_offset_degrees = 90.0;
        let frames = 2_000;
        let input = vec![1.0f32; frames];
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        Tidal::process_audio(&mut state, [&input, &input], [&mut left, &mut right], &block(0.0, frames, 120.0));
        assert!(left != right, "a channel offset separates the two channels");
    }

    #[test]
    fn zero_depth_passes_the_signal_through() {
        let mut state = state();
        state.depth = 0.0;
        state.needs_update = true;
        let frames = 1_000;
        let input = vec![0.7f32; frames];
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        Tidal::process_audio(&mut state, [&input, &input], [&mut left, &mut right], &block(0.0, frames, 120.0));
        // The gain is a constant 1.0, smoothed from 0, so it converges to the input; the tail is unchanged.
        assert!((left[frames - 1] - 0.7).abs() < 1.0e-3, "full pass-through once the smoother settles");
    }
}

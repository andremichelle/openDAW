//! The StereoTool AUDIO-EFFECT device. It applies a
//! ramped 2x2 stereo mixing matrix built from volume (dB), panning, stereo width, per-channel invert, and a
//! left/right swap, under a selectable pan law (linear / equal-power). An optional fixed 2 Hz high-pass removes
//! DC after the matrix. The matrix is recomputed only when a parameter changes, then glides via
//! `StereoMatrixRamp`.
//!
//! Parameters (`StereoToolDeviceBox`): volume `[10]` (decibel -72/0/12), panning `[11]` (bipolar), stereo `[12]`
//! (bipolar), invert-l `[13]`, invert-r `[14]`, swap `[15]`, dc-remove `[16]` (bools). The panning-mixing `[20]`
//! is an INT field (0 = Linear, 1 = EqualPower; observed, not automatable). The device owns the mappings.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`,
//! `field_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, AudioEffect, Block, FieldValue, ParamValue, Ports};
use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor, BUTTERWORTH_Q};
use dsp::db_to_gain;
use dsp::panning::{Mixing, StereoParams};
use dsp::ramp::{LinearRamp, StereoMatrixRamp};
use math::value_mapping::{Decibel, Linear};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const VOLUME_FIELD: [u16; 1] = [10];
const PANNING_FIELD: [u16; 1] = [11];
const STEREO_FIELD: [u16; 1] = [12];
const INVERT_L_FIELD: [u16; 1] = [13];
const INVERT_R_FIELD: [u16; 1] = [14];
const SWAP_FIELD: [u16; 1] = [15];
const DC_REMOVE_FIELD: [u16; 1] = [16];
const PANNING_MIXING_FIELD: [u16; 1] = [20];

const VOLUME_MAPPING: Decibel = Decibel::new(-72.0, 0.0, 12.0);
const PANNING_MAPPING: Linear = Linear::bipolar();
const STEREO_MAPPING: Linear = Linear::bipolar();

const SMOOTH_SECONDS: f32 = 0.005; // the TS `Ramp.stereoMatrix` default glide time
const DC_REMOVE_CUTOFF_HZ: f64 = 2.0;

/// The effect's per-instance state (engine-allocated, zeroed): the ramped matrix (built in `init`), the current
/// stereo params + pan law, a `needs_update` flag (recompute the matrix on the next block after any change), the
/// TS `#processed` flag (the first delivery jumps, later edits glide), and the parameter / field ids.
pub struct StereoToolState {
    matrix: StereoMatrixRamp,
    params: StereoParams,
    mixing: Mixing,
    needs_update: bool,
    processed: bool,
    dc_remove: bool,
    dc_remove_mix: LinearRamp,
    dc_remove_coeff: BiquadCoeff,
    dc_remove_filters: [BiquadMono; 2],
    volume_id: u32,
    panning_id: u32,
    stereo_id: u32,
    invert_l_id: u32,
    invert_r_id: u32,
    swap_id: u32,
    dc_remove_id: u32,
    panning_mixing_field_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct StereoTool;

impl AudioEffect for StereoTool {
    type State = StereoToolState;

    fn init(state: &mut StereoToolState, sample_rate: f32) {
        state.matrix = StereoMatrixRamp::stereo_matrix(sample_rate, SMOOTH_SECONDS);
        state.params = StereoParams::default();
        state.mixing = Mixing::Linear; // the box default (Mixing.Linear); field_changed refines it
        state.needs_update = true;
        state.processed = false;
        state.dc_remove = false;
        state.dc_remove_mix = LinearRamp::linear(sample_rate, SMOOTH_SECONDS);
        state.dc_remove_coeff = BiquadCoeff::new();
        state.dc_remove_coeff.set_highpass_params(DC_REMOVE_CUTOFF_HZ / sample_rate as f64, BUTTERWORTH_Q);
        state.dc_remove_filters = [BiquadMono::new(), BiquadMono::new()];
        state.volume_id = abi::bind_parameter(&VOLUME_FIELD);
        state.panning_id = abi::bind_parameter(&PANNING_FIELD);
        state.stereo_id = abi::bind_parameter(&STEREO_FIELD);
        state.invert_l_id = abi::bind_parameter(&INVERT_L_FIELD);
        state.invert_r_id = abi::bind_parameter(&INVERT_R_FIELD);
        state.swap_id = abi::bind_parameter(&SWAP_FIELD);
        state.dc_remove_id = abi::bind_parameter(&DC_REMOVE_FIELD);
        state.panning_mixing_field_id = abi::observe_field(&PANNING_MIXING_FIELD);
    }

    fn parameter_changed(state: &mut StereoToolState, id: u32, value: ParamValue) {
        if id == state.volume_id {
            state.params.gain = db_to_gain(float_value(value, &VOLUME_MAPPING));
        } else if id == state.panning_id {
            state.params.panning = float_value(value, &PANNING_MAPPING);
        } else if id == state.stereo_id {
            state.params.stereo = float_value(value, &STEREO_MAPPING);
        } else if id == state.invert_l_id {
            state.params.invert_l = bool_value(value);
        } else if id == state.invert_r_id {
            state.params.invert_r = bool_value(value);
        } else if id == state.swap_id {
            state.params.swap = bool_value(value);
        } else if id == state.dc_remove_id {
            let enabled = bool_value(value);
            if enabled != state.dc_remove {
                state.dc_remove = enabled;
                if enabled && state.dc_remove_mix.get() == 0.0 {
                    state.dc_remove_filters[0].reset();
                    state.dc_remove_filters[1].reset();
                }
                state.dc_remove_mix.set(if enabled {1.0} else {0.0}, state.processed);
            }
            return;
        } else {
            return;
        }
        state.needs_update = true;
    }

    fn reset(state: &mut StereoToolState) {
        state.processed = false;
        state.dc_remove_filters[0].reset();
        state.dc_remove_filters[1].reset();
        state.dc_remove_mix.set(if state.dc_remove {1.0} else {0.0}, false);
    }

    fn process_audio(state: &mut StereoToolState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        if state.needs_update {
            state.matrix.update(&state.params, state.mixing, state.processed);
            state.needs_update = false;
        }
        state.matrix.process_frames(in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize);
        if state.dc_remove || state.dc_remove_mix.is_interpolating() || state.dc_remove_mix.get() > 0.0 {
            let [left_filter, right_filter] = &mut state.dc_remove_filters;
            for sample in block.s0 as usize..block.s1 as usize {
                let dry_left = out_left[sample];
                let dry_right = out_right[sample];
                let wet_left = left_filter.process_frame(&state.dc_remove_coeff, dry_left as f64) as f32;
                let wet_right = right_filter.process_frame(&state.dc_remove_coeff, dry_right as f64) as f32;
                let wet = state.dc_remove_mix.move_and_get();
                out_left[sample] = dry_left * (1.0 - wet) + wet_left * wet;
                out_right[sample] = dry_right * (1.0 - wet) + wet_right * wet;
            }
            if !state.dc_remove && !state.dc_remove_mix.is_interpolating() {
                left_filter.reset();
                right_filter.reset();
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
    core::mem::size_of::<StereoToolState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<StereoToolState>::from_descriptor(desc_ptr) };
    abi::render_effect::<StereoTool>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <StereoTool as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <StereoTool as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &VOLUME_MAPPING),
        1 => float_value(value, &PANNING_MAPPING),
        2 => float_value(value, &STEREO_MAPPING),
        3..=6 => if bool_value(value) {1.0} else {0.0},
        _ => f32::NAN
    }
}

/// Transport STOP: clear the runtime state (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <StereoTool as AudioEffect>::reset) }
}

/// Apply the observed `panning-mixing` int field (0 = Linear, 1 = EqualPower).
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut StereoToolState| {
            if id == state.panning_mixing_field_id {
                if let FieldValue::Int(mode) = FieldValue::from_wire(kind, bits, len) {
                    state.mixing = if mode == 1 {Mixing::EqualPower} else {Mixing::Linear};
                    state.needs_update = true;
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    //! The StereoTool DSP driven directly (setting the private state). f32 audio, mirroring the TS math.
    use super::{StereoTool, StereoToolState, DC_REMOVE_CUTOFF_HZ};
    use abi::{AudioEffect, ParamValue};
    use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor, BUTTERWORTH_Q};
    use dsp::panning::Mixing;
    use dsp::ramp::{LinearRamp, StereoMatrixRamp};

    const SR: f32 = 48_000.0;

    fn state() -> StereoToolState {
        let mut state: StereoToolState = unsafe { core::mem::zeroed() };
        state.matrix = StereoMatrixRamp::stereo_matrix(SR, 0.005);
        state.mixing = Mixing::Linear;
        state.needs_update = true;
        state.dc_remove_mix = LinearRamp::linear(SR, 0.005);
        state.dc_remove_coeff = BiquadCoeff::new();
        state.dc_remove_coeff.set_highpass_params(DC_REMOVE_CUTOFF_HZ / SR as f64, BUTTERWORTH_Q);
        state.dc_remove_filters = [BiquadMono::new(), BiquadMono::new()];
        state
    }

    fn run(state: &mut StereoToolState, in_left: &[f32], in_right: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = in_left.len();
        let (mut out_left, mut out_right) = (vec![0.0f32; n], vec![0.0f32; n]);
        if state.needs_update {
            state.matrix.update(&state.params, state.mixing, state.processed);
            state.needs_update = false;
        }
        state.matrix.process_frames(in_left, in_right, &mut out_left, &mut out_right, 0, n);
        if state.dc_remove || state.dc_remove_mix.is_interpolating() || state.dc_remove_mix.get() > 0.0 {
            let [left_filter, right_filter] = &mut state.dc_remove_filters;
            for sample in 0..n {
                let dry_left = out_left[sample];
                let dry_right = out_right[sample];
                let wet_left = left_filter.process_frame(&state.dc_remove_coeff, dry_left as f64) as f32;
                let wet_right = right_filter.process_frame(&state.dc_remove_coeff, dry_right as f64) as f32;
                let wet = state.dc_remove_mix.move_and_get();
                out_left[sample] = dry_left * (1.0 - wet) + wet_left * wet;
                out_right[sample] = dry_right * (1.0 - wet) + wet_right * wet;
            }
            if !state.dc_remove && !state.dc_remove_mix.is_interpolating() {
                left_filter.reset();
                right_filter.reset();
            }
        }
        state.processed = true;
        (out_left, out_right)
    }

    #[test]
    fn unity_passes_stereo_through() {
        let mut state = state();
        state.params.gain = 1.0;
        let (left, right) = run(&mut state, &[0.5, -0.2], &[0.3, 0.8]);
        assert!((left[0] - 0.5).abs() < 1e-6 && (right[0] - 0.3).abs() < 1e-6, "identity pass-through");
    }

    #[test]
    fn swap_exchanges_the_channels() {
        let mut state = state();
        state.params.gain = 1.0;
        state.params.swap = true;
        let (left, right) = run(&mut state, &[0.5], &[0.9]);
        assert!((left[0] - 0.9).abs() < 1e-6 && (right[0] - 0.5).abs() < 1e-6, "swap exchanges L and R");
    }

    #[test]
    fn full_mono_sums_the_channels_equally() {
        let mut state = state();
        state.params.gain = 1.0;
        state.params.stereo = -1.0; // fully mono
        let (left, right) = run(&mut state, &[1.0], &[0.0]);
        assert!((left[0] - right[0]).abs() < 1e-6, "mono: both channels identical");
    }

    #[test]
    fn invert_left_negates_the_left_channel() {
        let mut state = state();
        state.params.gain = 1.0;
        state.params.invert_l = true;
        let (left, _right) = run(&mut state, &[0.4], &[0.0]);
        assert!((left[0] + 0.4).abs() < 1e-6, "left channel is inverted");
    }

    #[test]
    fn dc_remove_rejects_a_constant_offset() {
        let mut state = state();
        state.params.gain = 1.0;
        state.dc_remove = true;
        state.dc_remove_mix.set(1.0, false);
        let dc = vec![0.5; SR as usize * 3];
        let (left, right) = run(&mut state, &dc, &dc);
        assert!(left.last().unwrap().abs() < 1e-4, "left DC settles near zero");
        assert!(right.last().unwrap().abs() < 1e-4, "right DC settles near zero");
    }

    #[test]
    fn dc_remove_parameter_toggles_the_filter() {
        let mut state = state();
        state.dc_remove_id = 42;
        <StereoTool as AudioEffect>::parameter_changed(&mut state, 42, ParamValue::Unit(1.0));
        assert!(state.dc_remove);
        <StereoTool as AudioEffect>::parameter_changed(&mut state, 42, ParamValue::Unit(0.0));
        assert!(!state.dc_remove);
    }

    #[test]
    fn disabling_dc_remove_crossfades_without_an_output_step() {
        let mut state = state();
        state.params.gain = 1.0;
        state.dc_remove_id = 42;
        <StereoTool as AudioEffect>::parameter_changed(&mut state, 42, ParamValue::Unit(1.0));
        let dc = vec![0.5; SR as usize * 3];
        let (settled, _) = run(&mut state, &dc, &dc);
        let before_toggle = *settled.last().unwrap();

        <StereoTool as AudioEffect>::parameter_changed(&mut state, 42, ParamValue::Unit(0.0));
        let transition_input = vec![0.5; 512];
        let (transition, _) = run(&mut state, &transition_input, &transition_input);

        let mut previous = before_toggle;
        let mut largest_step = 0.0f32;
        for sample in transition {
            largest_step = largest_step.max((sample - previous).abs());
            previous = sample;
        }
        assert!(largest_step < 0.01, "DC bypass transition step is bounded: {largest_step}");
        assert!((previous - 0.5).abs() < 1e-6, "bypass settles on the dry signal");
    }

    #[test]
    fn re_enabling_dc_remove_uses_fresh_filter_history() {
        let mut toggled = state();
        toggled.params.gain = 1.0;
        toggled.dc_remove_id = 42;
        <StereoTool as AudioEffect>::parameter_changed(&mut toggled, 42, ParamValue::Unit(1.0));
        let dc = vec![0.5; SR as usize];
        let _ = run(&mut toggled, &dc, &dc);
        <StereoTool as AudioEffect>::parameter_changed(&mut toggled, 42, ParamValue::Unit(0.0));
        let transition = vec![0.5; 512];
        let _ = run(&mut toggled, &transition, &transition);
        <StereoTool as AudioEffect>::parameter_changed(&mut toggled, 42, ParamValue::Unit(1.0));

        let mut fresh = state();
        fresh.params.gain = 1.0;
        fresh.dc_remove_id = 42;
        let _ = run(&mut fresh, &[0.5], &[0.5]);
        <StereoTool as AudioEffect>::parameter_changed(&mut fresh, 42, ParamValue::Unit(1.0));

        let input = [0.5, -0.25, 0.75, 0.0];
        let (toggled_left, toggled_right) = run(&mut toggled, &input, &input);
        let (fresh_left, fresh_right) = run(&mut fresh, &input, &input);
        for (toggled, fresh) in toggled_left.iter().chain(&toggled_right).zip(fresh_left.iter().chain(&fresh_right)) {
            assert!((toggled - fresh).abs() < 1e-6, "re-enabled filter matches a fresh filter");
        }
    }

    #[test]
    fn reset_clears_dc_remove_filter_history() {
        let mut reset_state = state();
        reset_state.params.gain = 1.0;
        reset_state.dc_remove = true;
        reset_state.dc_remove_mix.set(1.0, false);
        let dc = vec![0.5; SR as usize];
        let _ = run(&mut reset_state, &dc, &dc);
        <StereoTool as AudioEffect>::reset(&mut reset_state);

        let mut fresh = state();
        fresh.params.gain = 1.0;
        fresh.dc_remove = true;
        fresh.dc_remove_mix.set(1.0, false);
        let input = [0.5, -0.25, 0.75, 0.0];
        let (reset_left, reset_right) = run(&mut reset_state, &input, &input);
        let (fresh_left, fresh_right) = run(&mut fresh, &input, &input);

        for (reset, fresh) in reset_left.iter().chain(&reset_right).zip(fresh_left.iter().chain(&fresh_right)) {
            assert!((reset - fresh).abs() < 1e-6, "reset filter matches a fresh filter");
        }
    }

    #[test]
    fn dc_remove_preserves_audible_band_gain() {
        let mut state = state();
        state.params.gain = 1.0;
        state.dc_remove = true;
        let tone: Vec<f32> = (0..SR as usize)
            .map(|sample| (core::f32::consts::TAU * 1_000.0 * sample as f32 / SR).sin())
            .collect();
        let (left, _) = run(&mut state, &tone, &tone);
        let start = tone.len() / 2;
        let rms = |values: &[f32]| (values.iter().map(|value| value * value).sum::<f32>() / values.len() as f32).sqrt();
        let gain = rms(&left[start..]) / rms(&tone[start..]);
        assert!((gain - 1.0).abs() < 1e-4, "1 kHz gain remains unity: {gain}");
    }
}

//! The Waveshaper AUDIO-EFFECT device, a faithful port of the TS `WaveshaperDeviceProcessor`. The input is
//! scaled by a smoothed input gain (dB), pushed through a selectable transfer function
//! (`dsp::waveshaper::Equation`), then blended back against the dry signal by a smoothed mix, the wet side
//! scaled by a smoothed output gain (dB). All per-sample control values glide with a `LinearRamp`, so a
//! parameter edit does not click.
//!
//! Parameters (`WaveshaperDeviceBox`): input-gain `[11]` (linear 0..40 dB), output-gain `[12]` (linear
//! -24..24 dB), mix `[13]` (unipolar). The `equation` `[10]` is a STRING field (observed, not automatable).
//! The device owns the mappings; the host is mapping-agnostic.
//!
//! Exports: `kind()` (audio effect), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(...)`, `field_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, FieldValue, ParamValue, Ports};
use dsp::db_to_gain;
use dsp::ramp::LinearRamp;
use dsp::waveshaper::{self, Equation};
use math::value_mapping::Linear;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The parameter / field key PATHs on the `WaveshaperDeviceBox` (the stable schema keys).
const EQUATION_FIELD: [u16; 1] = [10];
const INPUT_GAIN_FIELD: [u16; 1] = [11];
const OUTPUT_GAIN_FIELD: [u16; 1] = [12];
const MIX_FIELD: [u16; 1] = [13];

// This device's value mappings (uniform 0..1 -> the parameter's real value), mirroring the TS adapter.
const INPUT_GAIN_MAPPING: Linear = Linear {min: 0.0, max: 40.0};
const OUTPUT_GAIN_MAPPING: Linear = Linear {min: -24.0, max: 24.0};
const MIX_MAPPING: Linear = Linear::unipolar();

const SMOOTH_SECONDS: f32 = 0.005; // the TS `Ramp.linear` default glide time

/// The effect's per-instance state (engine-allocated, zeroed): the three smoothed control values, the current
/// transfer function, the parameter / field ids `init` got back, and whether a block has been processed yet
/// (the first parameter delivery jumps; later edits glide — the TS `#processed` flag). The `LinearRamp`s are
/// built in `init` (a zeroed ramp has length 0).
pub struct WaveshaperState {
    smooth_input_gain: LinearRamp,
    smooth_output_gain: LinearRamp,
    smooth_mix: LinearRamp,
    equation: Equation,
    processed: bool,
    input_gain_id: u32,
    output_gain_id: u32,
    mix_id: u32,
    equation_field_id: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Waveshaper;

impl AudioEffect for Waveshaper {
    type State = WaveshaperState;

    fn init(state: &mut WaveshaperState, sample_rate: f32) {
        state.smooth_input_gain = LinearRamp::linear(sample_rate, SMOOTH_SECONDS);
        state.smooth_output_gain = LinearRamp::linear(sample_rate, SMOOTH_SECONDS);
        state.smooth_mix = LinearRamp::linear(sample_rate, SMOOTH_SECONDS);
        state.equation = Equation::HardClip; // the box default ("hardclip"); field_changed refines it
        state.processed = false;
        state.input_gain_id = abi::bind_parameter(&INPUT_GAIN_FIELD);
        state.output_gain_id = abi::bind_parameter(&OUTPUT_GAIN_FIELD);
        state.mix_id = abi::bind_parameter(&MIX_FIELD);
        state.equation_field_id = abi::observe_field(&EQUATION_FIELD);
    }

    fn parameter_changed(state: &mut WaveshaperState, id: u32, value: ParamValue) {
        // input / output gain are decibels -> a linear gain; mix is unipolar. Each glides (or jumps before the
        // first block) exactly like the TS smoothers.
        if id == state.input_gain_id {
            state.smooth_input_gain.set(db_to_gain(float_value(value, &INPUT_GAIN_MAPPING)), state.processed);
        } else if id == state.output_gain_id {
            state.smooth_output_gain.set(db_to_gain(float_value(value, &OUTPUT_GAIN_MAPPING)), state.processed);
        } else if id == state.mix_id {
            state.smooth_mix.set(float_value(value, &MIX_MAPPING), state.processed);
        }
    }

    fn reset(state: &mut WaveshaperState) {
        state.processed = false;
    }

    fn process_audio(state: &mut WaveshaperState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        Waveshaper::dsp(state, in_left, in_right, out_left, out_right, block.s0 as usize, block.s1 as usize);
        state.processed = true;
    }
}

impl Waveshaper {
    /// The pure per-range DSP (unit-tested directly). Fuses the TS processor's four passes into one loop: each
    /// smoother advances once per sample (identical values to the separate passes), the wet side is
    /// `shape(dry * input_gain) * output_gain`, mixed against the dry `src` by the smoothed wet/dry.
    fn dsp(state: &mut WaveshaperState, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], s0: usize, s1: usize) {
        let equation = state.equation;
        for sample in s0..s1 {
            let input_gain = state.smooth_input_gain.move_and_get();
            let dry_left = in_left[sample];
            let dry_right = in_right[sample];
            let wet_left = waveshaper::Equation::apply(equation, dry_left * input_gain);
            let wet_right = waveshaper::Equation::apply(equation, dry_right * input_gain);
            let output_gain = state.smooth_output_gain.move_and_get();
            let wet = state.smooth_mix.move_and_get();
            let dry = 1.0 - wet;
            out_left[sample] = dry_left * dry + wet_left * output_gain * wet;
            out_right[sample] = dry_right * dry + wet_right * output_gain * wet;
        }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<WaveshaperState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<WaveshaperState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Waveshaper>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Waveshaper as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Waveshaper as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Transport STOP: clear the runtime state (mirrors the TS processor's `reset`).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Waveshaper as AudioEffect>::reset) }
}

/// Apply the observed `equation` string field (its name resolves to a transfer function). By the id
/// `observe_field` returned; `len` is the string byte length.
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state: &mut WaveshaperState| {
            if id == state.equation_field_id {
                if let FieldValue::String(name) = FieldValue::from_wire(kind, bits, len) {
                    state.equation = Equation::from_name(name);
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    //! The Waveshaper DSP driven directly (setting the private state). f32 audio, mirroring the TS math.
    use super::{Waveshaper, WaveshaperState};
    use dsp::ramp::LinearRamp;
    use dsp::waveshaper::Equation;

    const SR: f32 = 48_000.0;

    fn state(equation: Equation, input_gain: f32, output_gain: f32, mix: f32) -> WaveshaperState {
        let mut state: WaveshaperState = unsafe { core::mem::zeroed() };
        state.smooth_input_gain = LinearRamp::linear(SR, 0.005);
        state.smooth_output_gain = LinearRamp::linear(SR, 0.005);
        state.smooth_mix = LinearRamp::linear(SR, 0.005);
        state.smooth_input_gain.set(input_gain, false); // jump (unsmoothed), as the first delivery does
        state.smooth_output_gain.set(output_gain, false);
        state.smooth_mix.set(mix, false);
        state.equation = equation;
        state
    }

    fn run(state: &mut WaveshaperState, input: &[f32]) -> Vec<f32> {
        let (mut left, mut right) = (vec![0.0f32; input.len()], vec![0.0f32; input.len()]);
        Waveshaper::dsp(state, input, input, &mut left, &mut right, 0, input.len());
        left
    }

    #[test]
    fn full_wet_hardclip_clamps_the_boosted_signal() {
        // Unity input gain, unity output gain, full wet, hardclip: values above 1 clamp to 1.
        let mut state = state(Equation::HardClip, 1.0, 1.0, 1.0);
        let out = run(&mut state, &[2.0, -2.0, 0.5]);
        assert_eq!(out, vec![1.0, -1.0, 0.5]);
    }

    #[test]
    fn dry_mix_passes_the_source_through_untouched() {
        // mix = 0 -> pure dry, so the shaper / gains are bypassed regardless of equation.
        let mut state = state(Equation::HardClip, 4.0, 8.0, 0.0);
        let out = run(&mut state, &[0.7, -0.3, 0.9]);
        for (got, want) in out.iter().zip([0.7, -0.3, 0.9]) {
            assert!((got - want).abs() < 1e-6, "dry pass-through: {got} vs {want}");
        }
    }

    #[test]
    fn input_gain_drives_harder_into_the_shaper() {
        // A small input hard-clips only when the input gain pushes it past unity.
        let mut soft = state(Equation::HardClip, 1.0, 1.0, 1.0);
        assert!((run(&mut soft, &[0.5])[0] - 0.5).abs() < 1e-6, "0.5 * 1 stays below the clip");
        let mut hot = state(Equation::HardClip, 4.0, 1.0, 1.0);
        assert_eq!(run(&mut hot, &[0.5])[0], 1.0, "0.5 * 4 = 2 clamps to 1");
    }

    #[test]
    fn output_gain_scales_the_wet_signal() {
        // tanh(0) = 0, so use a non-zero input; output gain 0.5 halves the wet result.
        let mut unity = state(Equation::Tanh, 1.0, 1.0, 1.0);
        let mut halved = state(Equation::Tanh, 1.0, 0.5, 1.0);
        let a = run(&mut unity, &[0.8])[0];
        let b = run(&mut halved, &[0.8])[0];
        assert!((b - a * 0.5).abs() < 1e-6, "output gain scales the wet output");
    }

    #[test]
    fn mix_blends_dry_and_wet_linearly() {
        // Half wet = average of dry source and the fully-wet result.
        let src = 2.0f32;
        let mut wet = state(Equation::HardClip, 1.0, 1.0, 1.0);
        let full_wet = run(&mut wet, &[src])[0]; // 1.0
        let mut half = state(Equation::HardClip, 1.0, 1.0, 0.5);
        let blended = run(&mut half, &[src])[0];
        assert!((blended - (src * 0.5 + full_wet * 0.5)).abs() < 1e-6);
    }
}

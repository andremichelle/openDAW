//! The Autotune AUDIO-EFFECT device: real-time pitch correction. `dsp::autotune::Autotune` (the
//! control core) detects the input's fundamental, snaps it to the key/scale, and glides the
//! correction; the audible shift runs through the zero-alloc `dsp::psola::Psola` (TD-PSOLA — pitch
//! changes with no doppler / speed-wobble). Per block: feed the input to the core, hand PSOLA the
//! detected period plus `core.current_semitones()` (correction + manual shift), then render.
//!
//! Parameters (`AutotuneDeviceBox`): key `[10]` (linear-integer 0..11, root pitch class), scale `[11]`
//! (linear-integer 0..7, adapter order Chrom/Major/Minor/MajPent/MinPent/Blues/Dorian/Mixo),
//! amount `[12]` (unipolar correction depth, square-law tapered), retune `[13]` (unipolar natural→hard-tune: glide speed +
//! vibrato-flatten depth),
//! shift `[14]` (linear -12..12 semitones, applied additively after the snap), smooth `[15]` (unipolar
//! damping of the correction ratio: rounds note-change transitions, does NOT flatten vibrato — that is the
//! retune knob).

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, AudioEffect, Block, ParamValue, Ports};
use dsp::autotune::Autotune;
use dsp::psola::Psola;
use math::value_mapping::{Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const KEY_FIELD: [u16; 1] = [10];
const SCALE_FIELD: [u16; 1] = [11];
const AMOUNT_FIELD: [u16; 1] = [12];
const RETUNE_FIELD: [u16; 1] = [13];
const SHIFT_FIELD: [u16; 1] = [14];
const SMOOTH_FIELD: [u16; 1] = [15];
const TUNER_FIELD: [u16; 1] = [0]; // live tuner telemetry broadcast at address.append(0): [detected_midi, target_note, voiced]

const KEY_MAPPING: LinearInteger = LinearInteger {min: 0, max: 11};
const SCALE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 7};
const AMOUNT_MAPPING: Linear = Linear::unipolar();
const RETUNE_MAPPING: Linear = Linear::unipolar();
const SHIFT_MAPPING: Linear = Linear {min: -12.0, max: 12.0};
const SMOOTH_MAPPING: Linear = Linear::unipolar();

pub struct AutotuneState {
    dsp: Psola,
    core: Autotune,
    key_id: u32,
    scale_id: u32,
    amount_id: u32,
    retune_id: u32,
    shift_id: u32,
    smooth_id: u32,
    tuner_id: u32,
    tuner_ptr: u32
}

pub struct AutotuneDevice;

impl AudioEffect for AutotuneDevice {
    type State = AutotuneState;

    fn init(state: &mut AutotuneState, sample_rate: f32) {
        state.dsp.prepare(sample_rate);
        state.core.prepare(sample_rate);
        state.key_id = abi::bind_parameter(&KEY_FIELD);
        state.scale_id = abi::bind_parameter(&SCALE_FIELD);
        state.amount_id = abi::bind_parameter(&AMOUNT_FIELD);
        state.retune_id = abi::bind_parameter(&RETUNE_FIELD);
        state.shift_id = abi::bind_parameter(&SHIFT_FIELD);
        state.smooth_id = abi::bind_parameter(&SMOOTH_FIELD);
        state.tuner_id = abi::bind_broadcast(&TUNER_FIELD, 3);
    }

    fn parameter_changed(state: &mut AutotuneState, id: u32, value: ParamValue) {
        if id == state.key_id {
            state.core.set_key(int_value(value, &KEY_MAPPING));
        } else if id == state.scale_id {
            state.core.set_scale(int_value(value, &SCALE_MAPPING));
        } else if id == state.amount_id {
            state.core.set_amount(float_value(value, &AMOUNT_MAPPING));
        } else if id == state.retune_id {
            state.core.set_retune(float_value(value, &RETUNE_MAPPING));
        } else if id == state.shift_id {
            state.core.set_shift(float_value(value, &SHIFT_MAPPING));
        } else if id == state.smooth_id {
            state.core.set_smooth(float_value(value, &SMOOTH_MAPPING));
        }
    }

    fn reset(state: &mut AutotuneState) {
        state.dsp.reset();
        state.core.reset();
    }

    fn process_audio(state: &mut AutotuneState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (from, to) = (block.s0 as usize, block.s1 as usize);
        state.core.feed(in_left, in_right, from, to);
        state.dsp.set_period(state.core.current_period_samples());
        state.dsp.set_ratio_semitones(state.core.current_semitones());
        state.dsp.process(in_left, in_right, out_left, out_right, from, to);
        if state.tuner_ptr == 0 {
            state.tuner_ptr = abi::broadcast_ptr(state.tuner_id);
        }
        if state.tuner_ptr != 0 {
            let tuner = unsafe { core::slice::from_raw_parts_mut(state.tuner_ptr as *mut f32, 3) };
            tuner[0] = state.core.detected_midi();
            tuner[1] = state.core.target_note();
            tuner[2] = if state.core.is_voiced() {1.0} else {0.0};
        }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<AutotuneState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<AutotuneState>::from_descriptor(desc_ptr) };
    abi::render_effect::<AutotuneDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <AutotuneDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <AutotuneDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => int_value(value, &KEY_MAPPING) as f32,
        1 => int_value(value, &SCALE_MAPPING) as f32,
        2 => float_value(value, &AMOUNT_MAPPING),
        3 => float_value(value, &RETUNE_MAPPING),
        4 => float_value(value, &SHIFT_MAPPING),
        5 => float_value(value, &SMOOTH_MAPPING),
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <AutotuneDevice as AudioEffect>::reset) }
}

#[cfg(test)]
mod tests {
    use super::{AutotuneDevice, AutotuneState};
    use abi::{AudioEffect, ParamValue};

    extern crate alloc;
    use alloc::boxed::Box;
    use alloc::vec;

    fn state() -> Box<AutotuneState> {
        let mut state: Box<AutotuneState> = unsafe { Box::new(core::mem::zeroed()) };
        AutotuneDevice::init(&mut state, 48_000.0);
        state.key_id = 1;
        state.scale_id = 2;
        state.amount_id = 3;
        state.retune_id = 4;
        state.shift_id = 5;
        state.smooth_id = 6;
        state
    }


    // Mirror `process_audio` without the engine: feed the core, hand PSOLA the period + ratio, render.
    fn render_block(state: &mut AutotuneState, input: &[f32], left: &mut [f32], right: &mut [f32], from: usize, to: usize) {
        state.core.feed(input, input, from, to);
        state.dsp.set_period(state.core.current_period_samples());
        state.dsp.set_ratio_semitones(state.core.current_semitones());
        state.dsp.process(input, input, left, right, from, to);
    }

    // The output frequency over the settled tail, via zero crossings.
    fn tail_frequency(left: &[f32], sample_rate: f32) -> f32 {
        let tail = &left[left.len() / 2..];
        let mut crossings: alloc::vec::Vec<usize> = alloc::vec::Vec::new();
        for index in 1..tail.len() {
            if tail[index - 1] <= 0.0 && tail[index] > 0.0 {crossings.push(index);}
        }
        assert!(crossings.len() > 8, "not enough crossings");
        let spans: f32 = crossings.windows(2).map(|pair| (pair[1] - pair[0]) as f32).sum();
        sample_rate / (spans / (crossings.len() - 1) as f32)
    }

    fn render(state: &mut AutotuneState, input: &[f32]) -> alloc::vec::Vec<f32> {
        let frames = input.len();
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let mut offset = 0usize;
        while offset < frames {
            let end = core::cmp::min(offset + 128, frames);
            render_block(state, input, &mut left, &mut right, offset, end);
            offset = end;
        }
        left
    }

    fn tone(frequency_hz: f32, sample_rate: f32, frames: usize) -> alloc::vec::Vec<f32> {
        (0..frames).map(|index| 0.5 * libm::sinf(2.0 * math::PI * frequency_hz * index as f32 / sample_rate)).collect()
    }

    // Harmonic-rich tone (like real audio) — unlike a pure sine it does not self-cancel under a full-octave shift.
    fn rich(frequency_hz: f32, sample_rate: f32, frames: usize) -> alloc::vec::Vec<f32> {
        let mut phase = 0.0f32;
        (0..frames).map(|_| {
            phase += 2.0 * math::PI * frequency_hz / sample_rate;
            (1..=6).map(|harmonic| libm::sinf(harmonic as f32 * phase) / harmonic as f32).sum::<f32>() * 0.3
        }).collect()
    }

    #[test]
    fn amount_zero_preserves_the_pitch() {
        let sample_rate = 48_000.0f32;
        let mut state = state();
        let amount = state.amount_id;
        AutotuneDevice::parameter_changed(&mut state, amount, ParamValue::Float(0.0));
        let left = render(&mut state, &tone(220.0, sample_rate, 24_000));
        assert!((tail_frequency(&left, sample_rate) - 220.0).abs() < 6.0, "amount 0 must keep the input pitch");
    }

    #[test]
    fn full_shift_raises_by_an_octave() {
        let sample_rate = 48_000.0f32;
        let mut state = state();
        let (amount, shift) = (state.amount_id, state.shift_id);
        AutotuneDevice::parameter_changed(&mut state, amount, ParamValue::Float(0.0)); // shift only
        AutotuneDevice::parameter_changed(&mut state, shift, ParamValue::Float(12.0));
        let left = render(&mut state, &rich(220.0, sample_rate, 24_000));
        assert!((tail_frequency(&left, sample_rate) - 440.0).abs() < 12.0, "+12 st must double the pitch");
    }

    #[test]
    fn detuned_tone_is_corrected_to_the_scale_note() {
        let sample_rate = 48_000.0f32;
        let mut state = state();
        let (key, retune, smooth) = (state.key_id, state.retune_id, state.smooth_id);
        AutotuneDevice::parameter_changed(&mut state, key, ParamValue::Int(9)); // A
        AutotuneDevice::parameter_changed(&mut state, retune, ParamValue::Float(1.0));
        AutotuneDevice::parameter_changed(&mut state, smooth, ParamValue::Float(0.0));
        let left = render(&mut state, &tone(430.0, sample_rate, 48_000));
        let frequency = tail_frequency(&left, sample_rate);
        assert!((frequency - 440.0).abs() < 8.0, "expected ~440Hz (430 corrected to A), measured {frequency}");
    }
}

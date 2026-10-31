// Mastering device for openDAW, applying a stored Matchering analysis.
// Contains a port of Matchering's limiter: Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the GNU General
// Public License as published by the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details. You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

//! The Mastering AUDIO-EFFECT device. Applies a stored analysis: the mid and side matching curves `[22]`/`[23]`
//! become linear-phase FIRs at the engine rate, run by `dsp::convolution::Convolver` on mid/side, then the match
//! gain `[20]`, the Hyrax limiter and the final amplitude `[21]`. Final touch parameters: amount `[10]` (blend with
//! the dry signal delayed to the FIR center), gain `[11]`, width `[12]` (side level), ceiling `[13]` (limiter
//! threshold); limiter `[14]` is a plain field. The latency is constant: half the FIR plus the limiter lookahead.

#![cfg_attr(target_family = "wasm", no_std)]

pub mod hyrax;

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, FieldValue, ParamValue, Ports};
use dsp::convolution::Convolver;
use dsp::db_to_gain;
use dsp::rfft::FftTables;
use math::value_mapping::Linear;
use hyrax::Hyrax;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const AMOUNT_FIELD: [u16; 1] = [10];
const GAIN_FIELD: [u16; 1] = [11];
const WIDTH_FIELD: [u16; 1] = [12];
const CEILING_FIELD: [u16; 1] = [13];
const LIMITER_FIELD: [u16; 1] = [14];
const MATCH_GAIN_FIELD: [u16; 1] = [20];
const FINAL_AMPLITUDE_FIELD: [u16; 1] = [21];
const MID_CURVE_FIELD: [u16; 1] = [22];
const SIDE_CURVE_FIELD: [u16; 1] = [23];

const AMOUNT_MAPPING: Linear = Linear::unipolar(); // MasteringDeviceBoxAdapter ValueMapping.unipolar()
const GAIN_MAPPING: Linear = Linear {min: -12.0, max: 12.0};
const WIDTH_MAPPING: Linear = Linear {min: 0.0, max: 2.0};
const CEILING_MAPPING: Linear = Linear {min: -6.0, max: 0.0};

pub const CURVE_RATE: f32 = 44100.0;
pub const CURVE_TAPS: usize = 4096;
pub const CURVE_BINS: usize = CURVE_TAPS / 2 + 1;
pub const MAX_TAPS: usize = 16384;
const DRY_RING: usize = MAX_TAPS;
const LOAD_BUDGET: usize = 2;

/// Matchering's 4096 taps at 44.1 kHz, scaled by the nearest power of two so the resolution stays alike.
pub fn taps_for(sample_rate: f32) -> usize {
    let octaves = libm::roundf(libm::log2f(sample_rate / CURVE_RATE)).max(0.0) as u32;
    (CURVE_TAPS << octaves).min(MAX_TAPS)
}

pub struct FirScratch {
    tables: FftTables<{MAX_TAPS / 2 + 1}>,
    spec_re: [f32; MAX_TAPS / 2 + 1],
    spec_im: [f32; MAX_TAPS / 2 + 1],
    scratch_re: [f32; MAX_TAPS / 2],
    scratch_im: [f32; MAX_TAPS / 2]
}

impl FirScratch {
    /// Matchering's FIR (`irfft`, `ifftshift`, Hann) of `curve` (44.1 kHz bins) at `taps` for `sample_rate`.
    pub fn build(&mut self, curve: &[f32], taps: usize, sample_rate: f32, output: &mut [f32]) {
        if self.tables.size() != taps {self.tables.init(taps);}
        let bins = taps / 2 + 1;
        let bin_width = CURVE_RATE / CURVE_TAPS as f32;
        for bin in 0..bins {
            let position = bin as f32 * sample_rate / taps as f32 / bin_width;
            let index = (position as usize).min(CURVE_BINS - 1);
            let next = (index + 1).min(CURVE_BINS - 1);
            let fraction = (position - index as f32).min(1.0);
            self.spec_re[bin] = curve[index] + (curve[next] - curve[index]) * fraction;
            self.spec_im[bin] = 0.0;
        }
        let (spec_re, spec_im) = (&self.spec_re[..bins], &self.spec_im[..bins]);
        let shifted = &mut output[..taps];
        self.tables.inverse(spec_re, spec_im, shifted, &mut self.scratch_re, &mut self.scratch_im);
        shifted.rotate_left(taps / 2);
        for (index, value) in shifted.iter_mut().enumerate() {
            let phase = 2.0 * core::f64::consts::PI * index as f64 / (taps - 1) as f64;
            *value *= (0.5 - 0.5 * libm::cos(phase)) as f32;
        }
    }
}

pub struct MasteringState {
    convolver: Convolver,
    hyrax: Hyrax,
    scratch: FirScratch,
    mid_curve: [f32; CURVE_BINS],
    side_curve: [f32; CURVE_BINS],
    mid_fir: [f32; MAX_TAPS],
    side_fir: [f32; MAX_TAPS],
    dry: [[f32; DRY_RING]; 2],
    dry_position: usize,
    has_mid: bool,
    has_side: bool,
    analysed: bool,
    taps: usize,
    sample_rate: f32,
    amount: f32,
    gain: f32,
    width: f32,
    limiter: bool,
    match_gain: f32,
    final_amplitude: f32,
    amount_id: u32,
    gain_id: u32,
    width_id: u32,
    ceiling_id: u32,
    limiter_id: u32,
    match_gain_id: u32,
    final_amplitude_id: u32,
    mid_curve_id: u32,
    side_curve_id: u32
}

pub struct MasteringDevice;

fn read_curve(bytes: &[u8], curve: &mut [f32; CURVE_BINS]) -> bool {
    if bytes.len() != CURVE_BINS * 4 {return false;}
    for (value, chunk) in curve.iter_mut().zip(bytes.chunks_exact(4)) {
        *value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
    }
    true
}

impl MasteringDevice {
    fn rebuild(state: &mut MasteringState) {
        state.analysed = state.has_mid && state.has_side;
        if !state.analysed {
            state.convolver.unload();
            return;
        }
        let taps = state.taps;
        state.scratch.build(&state.mid_curve, taps, state.sample_rate, &mut state.mid_fir);
        state.scratch.build(&state.side_curve, taps, state.sample_rate, &mut state.side_fir);
        state.convolver.begin_load(&state.mid_fir[..taps], &state.side_fir[..taps], true, false, false, 1.0);
    }

    pub fn field_changed(state: &mut MasteringState, id: u32, value: FieldValue) {
        match value {
            FieldValue::Bool(flag) if id == state.limiter_id => state.limiter = flag,
            FieldValue::Float(real) if id == state.match_gain_id => state.match_gain = real,
            FieldValue::Float(real) if id == state.final_amplitude_id => state.final_amplitude = real,
            FieldValue::Bytes(bytes) if id == state.mid_curve_id => {
                state.has_mid = read_curve(bytes, &mut state.mid_curve);
                Self::rebuild(state);
            }
            FieldValue::Bytes(bytes) if id == state.side_curve_id => {
                state.has_side = read_curve(bytes, &mut state.side_curve);
                Self::rebuild(state);
            }
            _ => {}
        }
    }

    pub fn latency(state: &MasteringState) -> usize {state.taps / 2 + state.hyrax.latency()}
}

impl AudioEffect for MasteringDevice {
    type State = MasteringState;

    fn init(state: &mut MasteringState, sample_rate: f32) {
        state.convolver.init();
        state.convolver.wet_gain = 1.0;
        state.convolver.dry_gain = 0.0;
        state.hyrax.init(sample_rate, db_to_gain(-0.0162) as f64);
        state.sample_rate = sample_rate;
        state.taps = taps_for(sample_rate);
        state.amount = 1.0;
        state.gain = 1.0;
        state.width = 1.0;
        state.limiter = true;
        state.match_gain = 1.0;
        state.final_amplitude = 1.0;
        state.amount_id = abi::bind_parameter(&AMOUNT_FIELD);
        state.gain_id = abi::bind_parameter(&GAIN_FIELD);
        state.width_id = abi::bind_parameter(&WIDTH_FIELD);
        state.ceiling_id = abi::bind_parameter(&CEILING_FIELD);
        state.limiter_id = abi::observe_field(&LIMITER_FIELD);
        state.match_gain_id = abi::observe_field(&MATCH_GAIN_FIELD);
        state.final_amplitude_id = abi::observe_field(&FINAL_AMPLITUDE_FIELD);
        state.mid_curve_id = abi::observe_field(&MID_CURVE_FIELD);
        state.side_curve_id = abi::observe_field(&SIDE_CURVE_FIELD);
        abi::set_latency(Self::latency(state) as u32);
    }

    fn parameter_changed(state: &mut MasteringState, id: u32, value: ParamValue) {
        if id == state.amount_id {
            state.amount = float_value(value, &AMOUNT_MAPPING);
        } else if id == state.gain_id {
            state.gain = db_to_gain(float_value(value, &GAIN_MAPPING));
        } else if id == state.width_id {
            state.width = float_value(value, &WIDTH_MAPPING);
        } else if id == state.ceiling_id {
            state.hyrax.set_threshold(db_to_gain(float_value(value, &CEILING_MAPPING)) as f64);
        }
    }

    fn reset(state: &mut MasteringState) {
        state.convolver.clear_runtime();
        state.hyrax.clear();
        state.dry.iter_mut().for_each(|channel| channel.fill(0.0));
    }

    fn process_audio(state: &mut MasteringState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else { return };
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        if s0 == 0 && state.convolver.loading() {
            let taps = state.taps;
            state.convolver.load_step(&state.mid_fir[..taps], &state.side_fir[..taps], LOAD_BUDGET);
        }
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let mut mid = [0.0f32; dsp::convolution::BLOCK];
        let mut side = [0.0f32; dsp::convolution::BLOCK];
        for index in s0..s1 {
            mid[index] = (in_left[index] + in_right[index]) * 0.5;
            side[index] = mid[index] - in_right[index];
        }
        if state.analysed {
            state.convolver.process(&mid, &side, out_left, out_right, s0, s1);
        }
        let delay = state.taps / 2;
        let amount = if state.analysed {state.amount} else {0.0};
        let gain = state.gain * state.match_gain;
        for index in s0..s1 {
            let write = state.dry_position & (DRY_RING - 1);
            let read = state.dry_position.wrapping_sub(delay) & (DRY_RING - 1);
            state.dry[0][write] = mid[index];
            state.dry[1][write] = side[index];
            state.dry_position = state.dry_position.wrapping_add(1);
            let (dry_mid, dry_side) = (state.dry[0][read], state.dry[1][read]);
            let wet_mid = if state.analysed {out_left[index]} else {0.0};
            let wet_side = if state.analysed {out_right[index]} else {0.0};
            let mid = amount * wet_mid + (1.0 - amount) * dry_mid;
            let side = state.width * (amount * wet_side + (1.0 - amount) * dry_side);
            out_left[index] = (mid + side) * gain;
            out_right[index] = (mid - side) * gain;
        }
        state.hyrax.process(&mut out_left[s0..s1], &mut out_right[s0..s1], state.limiter);
        if state.limiter && state.final_amplitude != 1.0 {
            for index in s0..s1 {
                out_left[index] *= state.final_amplitude;
                out_right[index] *= state.final_amplitude;
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<MasteringState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<MasteringState>::from_descriptor(desc_ptr) };
    abi::render_effect::<MasteringDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state: &mut MasteringState| <MasteringDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <MasteringDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    let value = unsafe { FieldValue::from_wire(kind, bits, len) };
    unsafe { abi::with_state(state_ptr, |state| MasteringDevice::field_changed(state, id, value)) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &AMOUNT_MAPPING),
        1 => float_value(value, &GAIN_MAPPING),
        2 => float_value(value, &WIDTH_MAPPING),
        3 => float_value(value, &CEILING_MAPPING),
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <MasteringDevice as AudioEffect>::reset) }
}

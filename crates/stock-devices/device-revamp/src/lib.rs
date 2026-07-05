//! The Revamp 7-band parametric EQ AUDIO-EFFECT device, a faithful port of the TS `RevampDeviceProcessor`.
//! Realizes `RevampDeviceBox`. The bands, in signal order, are:
//! high-pass, low-shelf, low-bell, mid-bell, high-bell, high-shelf, low-pass. Each enabled band filters the
//! previous band's output (a chain); if no band is enabled the input passes through. The high-pass and low-pass
//! are cascaded `BiquadStack`s (1..4 sections, from the `order` field); the five middle bands are single
//! `BiquadMono` biquads. A biquad per channel keeps its own history.
//!
//! Parameters per band (`RevampDeviceBox` sub-objects HP=10, LSh=11, LB=12, MB=13, HB=14, HSh=15, LP=16): each
//! has enabled `[b,1]` (bool) + frequency `[b,10]` (exp 20..20000 Hz); Pass bands add order `[b,11]` (int 0..3 ->
//! 1..4 sections) + q `[b,12]` (exp 0.01..10); Shelf bands add gain `[b,11]` (linear -24..24 dB); Bell bands add
//! gain `[b,11]` + q `[b,12]`. Coefficients are recomputed on any change; the host is mapping-agnostic.
//!
//! Exports: `kind()` (effect), `state_size()`, `process(desc_ptr)`, `init(...)`, `parameter_changed(...)`,
//! `reset(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, int_value, AudioEffect, Block, ParamValue, Ports};
use dsp::analyser::{AudioAnalyser, NUM_BINS};
use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor, BiquadStack};
use math::value_mapping::{Exponential, Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// Band signal-order indices.
const HP: usize = 0;
const LOW_SHELF: usize = 1;
const LOW_BELL: usize = 2;
const MID_BELL: usize = 3;
const HIGH_BELL: usize = 4;
const HIGH_SHELF: usize = 5;
const LP: usize = 6;

// Per-band field key PATHs: [band-object key, field key]. enabled=1, frequency=10, order/gain=11, q=12.
const EN: [[u16; 2]; 7] = [[10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [15, 1], [16, 1]];
const FREQ: [[u16; 2]; 7] = [[10, 10], [11, 10], [12, 10], [13, 10], [14, 10], [15, 10], [16, 10]];
const GAIN_LOW_SHELF: [u16; 2] = [11, 11];
const GAIN_LOW_BELL: [u16; 2] = [12, 11];
const GAIN_MID_BELL: [u16; 2] = [13, 11];
const GAIN_HIGH_BELL: [u16; 2] = [14, 11];
const GAIN_HIGH_SHELF: [u16; 2] = [15, 11];
const Q_HP: [u16; 2] = [10, 12];
const Q_LOW_BELL: [u16; 2] = [12, 12];
const Q_MID_BELL: [u16; 2] = [13, 12];
const Q_HIGH_BELL: [u16; 2] = [14, 12];
const Q_LP: [u16; 2] = [16, 12];
const ORDER_HP: [u16; 2] = [10, 11];
const ORDER_LP: [u16; 2] = [16, 11];
const SPECTRUM_FIELD: [u16; 1] = [0xFFF]; // TS RevampDeviceBoxAdapter.spectrum

// Value mappings (uniform 0..1 -> real), mirroring the schema constraints. Static field values arrive as the
// already-real value (used directly); these map an AUTOMATED unit value.
const FREQ_MAPPING: Exponential = Exponential {min: 20.0, max: 20_000.0};
const Q_MAPPING: Exponential = Exponential {min: 0.01, max: 10.0};
const GAIN_MAPPING: Linear = Linear {min: -24.0, max: 24.0};
const ORDER_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};

const NONE: u32 = u32::MAX;

/// The EQ's per-instance state (engine-allocated, zeroed): the 7 band coefficients + enabled flags, the current
/// freq/gain/q per band (kept to recompute a coefficient when any of its params changes), the per-channel biquad
/// processors (HP/LP are cascaded stacks, built in `init`), and the parameter ids.
pub struct RevampState {
    sample_rate: f32,
    coeff: [BiquadCoeff; 7],
    enabled: [bool; 7],
    freq: [f32; 7],
    gain: [f32; 7],
    q: [f32; 7],
    hp: [BiquadStack; 2],
    low_shelf: [BiquadMono; 2],
    low_bell: [BiquadMono; 2],
    mid_bell: [BiquadMono; 2],
    high_bell: [BiquadMono; 2],
    high_shelf: [BiquadMono; 2],
    lp: [BiquadStack; 2],
    enabled_id: [u32; 7],
    freq_id: [u32; 7],
    gain_id: [u32; 7],
    q_id: [u32; 7],
    order_hp_id: u32,
    order_lp_id: u32,
    // The editor's output spectrum (TS `adapter.spectrum` at `[0xFFF]`): the analyser runs (and the bins are
    // copied) only while the UI subscribes (`broadcast_active`), mirroring TS `#needsSpectrum`.
    analyser: AudioAnalyser,
    spectrum_id: u32,
    spectrum_ptr: u32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Revamp;

impl Revamp {
    /// Recompute one band's biquad coefficient from its current freq / gain / q (frequency normalised by the
    /// sample rate, as the TS does). Mirrors the band-specific `setXxxParams` calls in `parameterChanged`.
    fn recompute(state: &mut RevampState, band: usize) {
        let frequency = (state.freq[band] / state.sample_rate) as f64;
        let gain = state.gain[band] as f64;
        let q = state.q[band] as f64;
        match band {
            HP => state.coeff[HP].set_highpass_params(frequency, q),
            LOW_SHELF => state.coeff[LOW_SHELF].set_low_shelf_params(frequency, gain),
            LOW_BELL | MID_BELL | HIGH_BELL => state.coeff[band].set_peaking_params(frequency, q, gain),
            HIGH_SHELF => state.coeff[HIGH_SHELF].set_high_shelf_params(frequency, gain),
            LP => state.coeff[LP].set_lowpass_params(frequency, q),
            _ => {}
        }
    }

    /// Run one channel through the enabled bands in order: the first enabled band filters the input into the
    /// output, each later enabled band filters the output in place. No enabled band -> pass the input through.
    fn process_channel(coeff: &[BiquadCoeff; 7], enabled: &[bool; 7], bands: [&mut dyn BiquadProcessor; 7],
                       input: &[f32], output: &mut [f32], s0: usize, s1: usize) {
        let mut first = true;
        for band in 0..7 {
            if !enabled[band] {
                continue;
            }
            if first {
                bands[band].process(&coeff[band], input, output, s0, s1);
                first = false;
            } else {
                bands[band].process_in_place(&coeff[band], output, s0, s1);
            }
        }
        if first {
            output[s0..s1].copy_from_slice(&input[s0..s1]);
        }
    }
}

impl AudioEffect for Revamp {
    type State = RevampState;

    fn init(state: &mut RevampState, sample_rate: f32) {
        state.sample_rate = sample_rate;
        state.hp = [BiquadStack::new(4), BiquadStack::new(4)];
        state.lp = [BiquadStack::new(4), BiquadStack::new(4)];
        state.gain_id = [NONE; 7];
        state.q_id = [NONE; 7];
        for band in 0..7 {
            state.enabled_id[band] = abi::bind_parameter(&EN[band]);
            state.freq_id[band] = abi::bind_parameter(&FREQ[band]);
        }
        state.gain_id[LOW_SHELF] = abi::bind_parameter(&GAIN_LOW_SHELF);
        state.gain_id[LOW_BELL] = abi::bind_parameter(&GAIN_LOW_BELL);
        state.gain_id[MID_BELL] = abi::bind_parameter(&GAIN_MID_BELL);
        state.gain_id[HIGH_BELL] = abi::bind_parameter(&GAIN_HIGH_BELL);
        state.gain_id[HIGH_SHELF] = abi::bind_parameter(&GAIN_HIGH_SHELF);
        state.q_id[HP] = abi::bind_parameter(&Q_HP);
        state.q_id[LOW_BELL] = abi::bind_parameter(&Q_LOW_BELL);
        state.q_id[MID_BELL] = abi::bind_parameter(&Q_MID_BELL);
        state.q_id[HIGH_BELL] = abi::bind_parameter(&Q_HIGH_BELL);
        state.q_id[LP] = abi::bind_parameter(&Q_LP);
        state.order_hp_id = abi::bind_parameter(&ORDER_HP);
        state.order_lp_id = abi::bind_parameter(&ORDER_LP);
        state.analyser.init(0.0);
        state.spectrum_id = abi::bind_broadcast(&SPECTRUM_FIELD, NUM_BINS as u32);
        state.spectrum_ptr = 0;
    }

    fn parameter_changed(state: &mut RevampState, id: u32, value: ParamValue) {
        if id == state.order_hp_id {
            let order = int_value(value, &ORDER_MAPPING) + 1; // zero-based -> 1..4 sections
            state.hp[0].set_order(order as usize);
            state.hp[1].set_order(order as usize);
            return;
        }
        if id == state.order_lp_id {
            let order = int_value(value, &ORDER_MAPPING) + 1;
            state.lp[0].set_order(order as usize);
            state.lp[1].set_order(order as usize);
            return;
        }
        for band in 0..7 {
            if id == state.enabled_id[band] {
                state.enabled[band] = bool_value(value);
                return;
            }
            if id == state.freq_id[band] {
                state.freq[band] = float_value(value, &FREQ_MAPPING);
                Revamp::recompute(state, band);
                return;
            }
            if id == state.gain_id[band] {
                state.gain[band] = float_value(value, &GAIN_MAPPING);
                Revamp::recompute(state, band);
                return;
            }
            if id == state.q_id[band] {
                state.q[band] = float_value(value, &Q_MAPPING);
                Revamp::recompute(state, band);
                return;
            }
        }
    }

    fn reset(state: &mut RevampState) {
        state.hp[0].reset();
        state.hp[1].reset();
        state.low_shelf[0].reset();
        state.low_shelf[1].reset();
        state.low_bell[0].reset();
        state.low_bell[1].reset();
        state.mid_bell[0].reset();
        state.mid_bell[1].reset();
        state.high_bell[0].reset();
        state.high_bell[1].reset();
        state.high_shelf[0].reset();
        state.high_shelf[1].reset();
        state.lp[0].reset();
        state.lp[1].reset();
    }

    fn process_audio(state: &mut RevampState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        let coeff = state.coeff;
        let enabled = state.enabled;
        {
            let bands: [&mut dyn BiquadProcessor; 7] = [
                &mut state.hp[0], &mut state.low_shelf[0], &mut state.low_bell[0], &mut state.mid_bell[0],
                &mut state.high_bell[0], &mut state.high_shelf[0], &mut state.lp[0]];
            Revamp::process_channel(&coeff, &enabled, bands, in_left, out_left, s0, s1);
        }
        {
            let bands: [&mut dyn BiquadProcessor; 7] = [
                &mut state.hp[1], &mut state.low_shelf[1], &mut state.low_bell[1], &mut state.mid_bell[1],
                &mut state.high_bell[1], &mut state.high_shelf[1], &mut state.lp[1]];
            Revamp::process_channel(&coeff, &enabled, bands, in_right, out_right, s0, s1);
        }
        if abi::broadcast_active(state.spectrum_id) {
            state.analyser.process(&out_left[s0..s1], &out_right[s0..s1]);
            if state.spectrum_ptr == 0 {
                state.spectrum_ptr = abi::broadcast_ptr(state.spectrum_id);
            }
            if state.spectrum_ptr != 0 {
                let spectrum = unsafe { core::slice::from_raw_parts_mut(state.spectrum_ptr as *mut f32, NUM_BINS) };
                spectrum.copy_from_slice(state.analyser.bins());
                state.analyser.decay = true;
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
    core::mem::size_of::<RevampState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<RevampState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Revamp>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Revamp as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Revamp as AudioEffect>::reset(state)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Revamp as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[cfg(test)]
mod tests {
    //! The 7-band EQ driven directly (setting the private state). f32 audio path (biquads are f64 internally),
    //! mirroring the TS. Exercises the band chain, enabled gating, and per-band coefficient computation.
    use super::{Revamp, RevampState, HP, LOW_BELL, LP, HIGH_SHELF};
    use dsp::biquad::{BiquadProcessor, BiquadStack};

    const SR: f32 = 48_000.0;

    fn state() -> RevampState {
        let mut state: RevampState = unsafe { core::mem::zeroed() };
        state.sample_rate = SR;
        state.hp = [BiquadStack::new(2), BiquadStack::new(2)];
        state.lp = [BiquadStack::new(2), BiquadStack::new(2)];
        state
    }

    fn run(state: &mut RevampState, input: &[f32]) -> Vec<f32> {
        let n = input.len();
        let coeff = state.coeff;
        let enabled = state.enabled;
        let (mut out_left, mut out_right) = (vec![0.0f32; n], vec![0.0f32; n]);
        {
            let bands: [&mut dyn BiquadProcessor; 7] = [
                &mut state.hp[0], &mut state.low_shelf[0], &mut state.low_bell[0], &mut state.mid_bell[0],
                &mut state.high_bell[0], &mut state.high_shelf[0], &mut state.lp[0]];
            Revamp::process_channel(&coeff, &enabled, bands, input, &mut out_left, 0, n);
        }
        {
            let bands: [&mut dyn BiquadProcessor; 7] = [
                &mut state.hp[1], &mut state.low_shelf[1], &mut state.low_bell[1], &mut state.mid_bell[1],
                &mut state.high_bell[1], &mut state.high_shelf[1], &mut state.lp[1]];
            Revamp::process_channel(&coeff, &enabled, bands, input, &mut out_right, 0, n);
        }
        out_left
    }

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|s| s * s).sum()
    }

    fn nyquist(len: usize) -> Vec<f32> {
        (0..len).map(|i| if i % 2 == 0 {1.0} else {-1.0}).collect()
    }

    #[test]
    fn all_bands_disabled_passes_through() {
        let mut state = state(); // enabled all false
        let input = nyquist(256);
        let out = run(&mut state, &input);
        assert_eq!(out, input, "no band enabled -> exact pass-through");
    }

    #[test]
    fn enabled_low_pass_attenuates_nyquist() {
        let mut state = state();
        state.enabled[LP] = true;
        state.freq[LP] = 300.0;
        state.q[LP] = 0.707;
        Revamp::recompute(&mut state, LP);
        let input = nyquist(512);
        let out = run(&mut state, &input);
        assert!(energy(&out) < energy(&input) * 0.05, "the enabled low-pass strongly cuts the Nyquist tone");
    }

    #[test]
    fn a_disabled_low_pass_does_not_filter() {
        // The bug the stub had: it always applied the low-pass. With the band DISABLED the signal must pass.
        let mut state = state();
        state.enabled[LP] = false;
        state.freq[LP] = 300.0; // configured but off
        state.q[LP] = 0.707;
        Revamp::recompute(&mut state, LP);
        let input = nyquist(512);
        let out = run(&mut state, &input);
        assert_eq!(out, input, "a disabled low-pass leaves the signal untouched");
    }

    #[test]
    fn a_low_bell_boost_lifts_energy_near_its_frequency() {
        // A +12 dB bell at ~1 kHz on a 1 kHz-ish tone raises its level vs bypass.
        let bell_at = |db: f32| {
            let mut state = state();
            state.enabled[LOW_BELL] = true;
            state.freq[LOW_BELL] = 1000.0;
            state.gain[LOW_BELL] = db;
            state.q[LOW_BELL] = 1.0;
            Revamp::recompute(&mut state, LOW_BELL);
            // a ~1 kHz sine at 48k
            let input: Vec<f32> = (0..2048).map(|i| (i as f32 * 1000.0 / SR * core::f32::consts::TAU).sin()).collect();
            energy(&run(&mut state, &input))
        };
        assert!(bell_at(12.0) > bell_at(0.0) * 1.5, "a +12 dB bell boosts the tone at its centre");
    }

    #[test]
    fn multiple_bands_chain() {
        // High-shelf + low-bell both enabled: the output differs from either alone (they compose in series).
        let mut state = state();
        state.enabled[HIGH_SHELF] = true;
        state.freq[HIGH_SHELF] = 4000.0;
        state.gain[HIGH_SHELF] = 6.0;
        Revamp::recompute(&mut state, HIGH_SHELF);
        state.enabled[HP] = true;
        state.freq[HP] = 200.0;
        state.q[HP] = 0.707;
        Revamp::recompute(&mut state, HP);
        state.hp[0].set_order(2);
        state.hp[1].set_order(2);
        let input = nyquist(512);
        let out = run(&mut state, &input);
        assert!(out.iter().all(|s| s.is_finite()), "the chained bands stay finite");
        assert!(out != input, "the chain alters the signal");
    }
}

//! A minimal AUDIO-EFFECT device, the first proof of the effect path (Route B): a PIC side module the
//! engine loads and wires AFTER an instrument (instrument output -> this effect's input -> the bus). It
//! reads its one input buffer and writes its one output buffer through a one-pole low-pass whose cutoff is
//! swept by a sine LFO, so the filter audibly MOVES on the signal (a slow auto-wah). The coefficient is
//! derived from a cutoff frequency and the SAMPLE RATE (not a fixed constant), so it behaves the same at
//! any rate. Proves the host's `PluginAudioEffect` bridge: input-buffer read, output write, per-instance
//! state block (the filter memory + LFO phase), and graph ordering. It plays no notes and pulls no events.
//!
//! Exports: `kind()` (effect), `state_size()`, `process(desc_ptr)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::Ports;
use dsp::{fast_sin, PI};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const TAU: f32 = 2.0 * PI;
const CUTOFF_CENTER_HZ: f32 = 600.0;
const CUTOFF_DEPTH_HZ: f32 = 520.0; // sweeps the cutoff over ~80..1120 Hz
const MAX_COEFF: f32 = 0.99; // clamp the one-pole coefficient below 1 for stability
const LFO_PERIOD_PULSES: f64 = abi::PPQN_QUARTER * 2.0; // one cutoff sweep per half-note -> synced to bpm

/// The effect's per-instance state, interpreted from the engine-allocated (zeroed) block: the filter's
/// last output sample, carried across quanta. The LFO phase is NOT stored — it is derived from the song
/// position, so the sweep is phase-locked to the timeline. Valid when zeroed.
pub struct LowpassState {
    z1: f32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Lowpass;

impl abi::AudioEffect for Lowpass {
    type State = LowpassState;

    fn process_audio(state: &mut LowpassState, input: &[f32], output: &mut [f32], sample_rate: f32, bpm: f32, position: f64) {
        // One-pole low-pass `y += a*(x - y)`, coefficient from the cutoff and the SAMPLE RATE
        // (`a = 2*PI*fc/fs`). The cutoff is swept by a sine LFO whose phase is a function of the musical
        // POSITION, so the sweep is locked to the tempo (one cycle per `LFO_PERIOD_PULSES`) and to the song.
        let pulses_per_sample = f64::from(bpm) * abi::PPQN_QUARTER / 60.0 / f64::from(sample_rate);
        let mut pulse = position;
        let mut z1 = state.z1;
        for (sample, target) in input.iter().zip(output.iter_mut()) {
            let ratio = pulse / LFO_PERIOD_PULSES;
            let phase01 = ratio - (ratio as i64 as f64); // fractional cycle in [0, 1)
            let mut phase = phase01 as f32 * TAU;
            if phase > PI {
                phase -= TAU;
            }
            let cutoff = CUTOFF_CENTER_HZ + CUTOFF_DEPTH_HZ * fast_sin(phase);
            let coeff = (TAU * cutoff / sample_rate).min(MAX_COEFF);
            z1 += coeff * (*sample - z1);
            *target = z1;
            pulse += pulses_per_sample;
        }
        state.z1 = z1;
    }
}

/// What the host wires this device as (read at load): an audio effect that transforms its input.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block. The filter state is a single
/// sample, so the size does not depend on `sample_rate`; the parameter keeps the ABI uniform with devices
/// whose state IS rate-sized.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<LowpassState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<LowpassState>::from_descriptor(desc_ptr) };
    abi::render_effect::<Lowpass>(ports);
}

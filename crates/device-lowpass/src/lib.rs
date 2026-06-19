//! A minimal AUDIO-EFFECT device, the first proof of the effect path (Route B): a PIC side module the
//! engine loads and wires AFTER an instrument (instrument output -> this effect's input -> the bus). It
//! reads its one input buffer and writes its one output buffer through a one-pole low-pass filter, so the
//! sound audibly darkens, proving the host's `PluginAudioEffect` bridge: input-buffer read, output write,
//! per-instance state block, and graph ordering. It plays no notes and pulls no events.
//!
//! Exports: `kind()` (effect), `state_size()`, `process(desc_ptr)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::Ports;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// One-pole low-pass smoothing coefficient `y += a * (x - y)`. Fixed (no parameters yet): a = 0.05 puts
// the cutoff near sample_rate * a / (2*PI) ~ 380 Hz at 48 kHz, dark enough to be unmistakable.
const SMOOTHING: f32 = 0.02;

/// The effect's per-instance state, interpreted from the engine-allocated (zeroed) block: the filter's
/// last output sample, carried across quanta. Valid when zeroed.
pub struct LowpassState {
    z1: f32
}

/// The DSP, plugged into the SDK's `AudioEffect` template ([`abi::render_effect`]).
pub struct Lowpass;

impl abi::AudioEffect for Lowpass {
    type State = LowpassState;

    fn process_audio(state: &mut LowpassState, input: &[f32], output: &mut [f32], _sample_rate: f32) {
        let mut z1 = state.z1;
        for (sample, target) in input.iter().zip(output.iter_mut()) {
            z1 += SMOOTHING * (*sample - z1);
            *target = z1;
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

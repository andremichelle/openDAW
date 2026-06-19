//! A minimal MIDI-EFFECT device, the first proof of the event pull CHAIN (Route A): a PIC side module the
//! engine wires into a unit's pull chain BEFORE the instrument (instrument <- this <- sequencer). It is a
//! PULL SOURCE, not an audio node: the host invokes `process_events(from, to, flags, out, max)` only when
//! the downstream instrument pulls, and this device pulls its OWN upstream (the sequencer) for the range,
//! transposes every note by a fixed interval, and returns the transformed events. It produces no audio,
//! holds no per-instance state, and preserves event offsets (a pitch shift does not warp time).
//!
//! Exports: `kind()` (midi effect), `state_size()` (0), `process_events(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::EventRecord;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// Fixed transpose interval in semitones (no parameters yet): +12 = up one octave, clearly audible.
const TRANSPOSE: i32 = 12;

/// The transform, plugged into the SDK's `MidiEffect` template ([`abi::render_midi_effect`]), which owns
/// the upstream pull. This device writes only the transform: copy each event, shifting its pitch.
pub struct Transpose;

impl abi::MidiEffect for Transpose {
    fn transform(input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let count = input.len().min(output.len());
        for index in 0..count {
            let mut record = input[index];
            record.pitch = (record.pitch as i32 + TRANSPOSE).clamp(0, 127) as u32;
            output[index] = record;
        }
        count
    }
}

/// What the host wires this device as (read at load): a MIDI effect (a pull source in the event chain).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

/// A MIDI effect holds no per-instance audio state block; it pulls its upstream into an on-stack scratch.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<Transpose>(from, to, flags, out_ptr, max)
}

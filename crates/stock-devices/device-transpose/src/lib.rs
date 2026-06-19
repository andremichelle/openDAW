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
/// the upstream pull. This device writes only the transform: copy each event, shifting its pitch, and
/// DROP any note shifted out of MIDI range (never clamp — clamping would fold distinct pitches together).
/// So the output count is not one-to-one with the input. Stateless, so its `State` is `()`.
pub struct Transpose;

impl abi::MidiEffect for Transpose {
    type State = ();

    fn transform(_state: &mut (), input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            if count >= output.len() {
                break;
            }
            let pitch = record.pitch as i32 + TRANSPOSE;
            if !(0..=127).contains(&pitch) {
                continue; // out of MIDI range: drop the note, do not clamp
            }
            let mut shifted = *record;
            shifted.pitch = pitch as u32;
            output[count] = shifted;
            count += 1;
        }
        count
    }
}

/// What the host wires this device as (read at load): a MIDI effect (a pull source in the event chain).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block. Transpose is stateless (`()`),
/// so this is 0; the parameter keeps the ABI uniform with stateful MIDI fx (e.g. an arpeggiator's stack).
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<<Transpose as abi::MidiEffect>::State>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<Transpose>(from, to, flags, state_ptr, out_ptr, max)
}

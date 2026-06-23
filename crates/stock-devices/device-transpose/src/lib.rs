//! A MIDI-EFFECT device that transposes by an AUTOMATED semitone parameter (Route A pull chain + Route D
//! parameters). A PIC side module the engine wires BEFORE the instrument (instrument <- this <- sequencer):
//! it is a PULL SOURCE, not an audio node. The host invokes `process_events(from, to, flags, out, max)` when
//! the downstream instrument pulls; this device pulls its OWN upstream for the range, shifts every note's
//! pitch by the current semitone amount, and returns the transformed events (no audio, offsets preserved).
//! Its `semitones` is a real parameter (`PitchDeviceBox.semiTones`, field path `[10]`): when automated, the
//! SDK splits the pull at the engine's update positions and `parameter_changed` refreshes it per sub-range —
//! so a midi-fx parameter automates exactly like an audio device's.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `process_events(...)`, `init(...)`, `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, MidiEffect, ParamValue};
use math::value_mapping::{LinearInteger, ValueMapping};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// The transpose parameter's field-key PATH on the box: PitchDeviceBox.semiTones (field 10), and its value
// mapping (the device owns it; the host is mapping-agnostic). LinearInteger so a uniform automation value
// maps to a whole semitone; 0..12 = up to an octave.
const SEMITONE_FIELD: [u16; 1] = [10];
const SEMITONE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 12};

/// The transpose's per-instance state, from the engine-allocated (zeroed) block: the current semitone shift
/// (refreshed by `parameter_changed`) and the parameter id `bind_parameter` returned. Valid when zeroed
/// (0 semitones = no shift) until the engine pushes the field / automation value.
pub struct TransposeState {
    semitones: i32,
    semitone_id: u32
}

/// The transform, plugged into the SDK's `MidiEffect` template ([`abi::render_midi_effect`]), which owns the
/// upstream pull + the param-update fragmentation. This device writes only the transform: copy each event,
/// shifting its pitch by `state.semitones`, and DROP any note shifted out of MIDI range (never clamp —
/// clamping would fold distinct pitches together). So the output count is not one-to-one with the input.
pub struct Transpose;

impl MidiEffect for Transpose {
    type State = TransposeState;

    fn init(state: &mut TransposeState) {
        state.semitone_id = abi::bind_parameter(&SEMITONE_FIELD);
    }

    fn parameter_changed(state: &mut TransposeState, id: u32, value: ParamValue) {
        if id == state.semitone_id {
            // `Unit` => map the uniform 0..1 through the LinearInteger mapping, which yields a real `i32`
            // semitone; `Int` => the box field's real semitone value, used directly. Semitones are an integer
            // parameter, so any other variant is a contract error.
            state.semitones = match value {
                ParamValue::Unit(unit) => SEMITONE_MAPPING.y(unit),
                ParamValue::Int(semitones) => semitones,
                _ => panic!("transpose semitone expects a unit or int value")
            };
        }
    }

    fn transform(state: &mut TransposeState, input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            if count >= output.len() {
                break;
            }
            let pitch = record.pitch as i32 + state.semitones;
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

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<TransposeState>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<Transpose>(from, to, flags, state_ptr, out_ptr, max)
}

/// Bind this device's semitone parameter with the host (it records the field-path, returns the id).
#[no_mangle]
pub extern "C" fn init(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, <Transpose as MidiEffect>::init) }
}

/// Apply a semitone value the host resolved (initial / edit / automation), by the id `init` got back. The
/// `kind` tag tells the SDK how to type the f32 `value` into a `ParamValue` (uniform to map, or a real i32).
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Transpose as MidiEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

#[cfg(test)]
mod tests {
    //! The transpose transform (driven via the ABI's `MidiEffect`): pitch shifts by the SEMITONE parameter,
    //! count + other fields pass through, off-range notes drop. In-crate so it can set the private state.
    use super::{Transpose, TransposeState};
    use abi::{EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON};

    fn state_at(semitones: i32) -> TransposeState {
        TransposeState {semitones, semitone_id: 0}
    }

    fn note_on(id: u32, offset: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset, kind: EVENT_NOTE_ON, id, pitch, velocity: 0.8, cent: 0.0}
    }

    fn blanks() -> [EventRecord; 8] {
        [EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0}; 8]
    }

    #[test]
    fn transposes_by_the_semitone_parameter_preserving_count_and_offset() {
        let input = [note_on(7, 64, 60), note_on(8, 96, 67)];
        let mut output = blanks();
        let count = Transpose::transform(&mut state_at(12), &input, &mut output);
        assert_eq!(count, 2);
        assert_eq!(output[0].pitch, 72);
        assert_eq!(output[1].pitch, 79);
        assert_eq!(output[0].offset, 64, "timing is preserved");
        assert_eq!(output[0].id, 7, "identity is preserved");
    }

    #[test]
    fn zero_semitones_passes_pitch_through() {
        let input = [note_on(1, 0, 60)];
        let mut output = blanks();
        Transpose::transform(&mut state_at(0), &input, &mut output);
        assert_eq!(output[0].pitch, 60, "0 semitones is no shift");
    }

    #[test]
    fn drops_off_range_notes_instead_of_clamping() {
        // 120 + 12 = 132 is out of MIDI range -> dropped; 60 + 12 = 72 is kept. Output is NOT one-to-one.
        let input = [note_on(1, 0, 120), note_on(2, 30, 60)];
        let mut output = blanks();
        let count = Transpose::transform(&mut state_at(12), &input, &mut output);
        assert_eq!(count, 1, "the off-range note is dropped, not clamped");
        assert_eq!(output[0].pitch, 72);
        assert_eq!(output[0].id, 2, "the kept note is the in-range one");
    }

    #[test]
    fn parameter_changed_maps_a_unit_value_but_takes_a_real_value_directly() {
        let mut state = state_at(0);
        let id = state.semitone_id;
        // Unit: the uniform 1.0 maps through LinearInteger(0, 12) -> 12 semitones.
        Transpose::parameter_changed(&mut state, id, ParamValue::Unit(1.0));
        assert_eq!(state.semitones, 12, "a unit value is mapped to a whole semitone");
        // Int: a real field value (a UI edit) is used directly.
        Transpose::parameter_changed(&mut state, id, ParamValue::Int(7));
        assert_eq!(state.semitones, 7, "a real semitone value is used as-is");
    }

    #[test]
    #[should_panic]
    fn parameter_changed_rejects_a_mismatched_type() {
        let mut state = state_at(0);
        let id = state.semitone_id;
        Transpose::parameter_changed(&mut state, id, ParamValue::Float(1.5));
    }
}

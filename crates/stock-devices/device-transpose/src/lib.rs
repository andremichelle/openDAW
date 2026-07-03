//! The PITCH MIDI-EFFECT device (`PitchDeviceBox`, TS `PitchDeviceProcessor`): a PIC side module the engine
//! wires BEFORE the instrument (instrument <- this <- sequencer), a PULL SOURCE, not an audio node. It pulls
//! its upstream for the range and shifts every note-on's pitch by `octaves * 12 + semiTones` and its cent by
//! `cents`, all three real parameters mapped per the TS `PitchDeviceBoxAdapter` (`linearInteger(-7, 7)`,
//! `linearInteger(-36, 36)`, `linear(-50, 50)`). A note-off replays the pitch its OWN note-on was shifted
//! by (TS `#startShifts`), so a mid-note parameter change never detunes the release.
//!
//! Deviation from TS (documented): a note shifted outside MIDI range 0..=127 is DROPPED, not emitted (TS
//! yields the raw value; a Rust instrument indexing by pitch must never see one). Its note-off then finds
//! no start entry and passes through unshifted (the TS `isDefined` fallback), which downstream instruments
//! ignore (no matching id).
//!
//! Exports: `kind()` (midi effect), `state_size()`, `process_events(...)`, `init(...)`, `parameter_changed(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, int_value, EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
use math::value_mapping::{Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// Field-key paths on `PitchDeviceBox` and their TS-adapter value mappings (the device owns the mapping;
// the host is mapping-agnostic): semiTones 10 (Int32), cents 11 (Float32), octaves 12 (Int32).
const SEMITONE_FIELD: [u16; 1] = [10];
const CENTS_FIELD: [u16; 1] = [11];
const OCTAVES_FIELD: [u16; 1] = [12];
const SEMITONE_MAPPING: LinearInteger = LinearInteger {min: -36, max: 36};
const CENTS_MAPPING: Linear = Linear {min: -50.0, max: 50.0};
const OCTAVES_MAPPING: LinearInteger = LinearInteger {min: -7, max: 7};

// The note-on shift replay table (TS `#startShifts`, unbounded there): enough for any realistic count of
// concurrently-sounding notes through one MIDI fx. When full, a note-on is emitted un-tracked and its off
// takes the TS `isDefined` miss path (passes through unshifted).
const MAX_HELD: usize = 64;

/// The pitch device's per-instance state, from the engine-allocated (zeroed) block: the three current
/// parameter values (refreshed by `parameter_changed`), their bound ids, and the id -> shifted-pitch table
/// a note-off replays. Valid when zeroed (no shift, empty table) until the engine pushes values.
pub struct TransposeState {
    semitones: i32,
    octaves: i32,
    cents: f32,
    semitones_id: u32,
    octaves_id: u32,
    cents_id: u32,
    starts: [(u32, u32); MAX_HELD], // (note id, shifted pitch)
    starts_len: usize
}

impl TransposeState {
    fn remember(&mut self, id: u32, pitch: u32) {
        if self.starts_len < MAX_HELD {
            self.starts[self.starts_len] = (id, pitch);
            self.starts_len += 1;
        }
    }

    fn recall(&mut self, id: u32) -> Option<u32> {
        let index = self.starts[..self.starts_len].iter().position(|(held, _)| *held == id)?;
        let (_, pitch) = self.starts[index];
        self.starts_len -= 1;
        self.starts[index] = self.starts[self.starts_len];
        Some(pitch)
    }
}

/// The transform, plugged into the SDK's `MidiEffect` template ([`abi::render_midi_effect`]), which owns the
/// upstream pull + the param-update fragmentation. A note-on shifts pitch by `octaves * 12 + semiTones` and
/// cent by `cents`, remembering the shifted pitch by id; a note-off replays that pitch (TS `#startShifts`).
/// A note-on shifted out of MIDI range is dropped (never clamped — clamping would fold distinct pitches);
/// any other event kind passes through untouched. Output count is therefore not one-to-one with the input.
pub struct Transpose;

impl MidiEffect for Transpose {
    type State = TransposeState;

    fn init(state: &mut TransposeState, _sample_rate: f32) {
        state.semitones_id = abi::bind_parameter(&SEMITONE_FIELD); // a MIDI fx: no audio, the rate is unused
        state.cents_id = abi::bind_parameter(&CENTS_FIELD);
        state.octaves_id = abi::bind_parameter(&OCTAVES_FIELD);
    }

    fn parameter_changed(state: &mut TransposeState, id: u32, value: ParamValue) {
        // `Unit` => map the uniform 0..1 through the adapter mapping; `Int`/`Float` => the box field's real
        // value, used directly. A mismatched wire type is a contract error (`int_value`/`float_value` panic).
        if id == state.semitones_id {
            state.semitones = int_value(value, &SEMITONE_MAPPING);
        } else if id == state.octaves_id {
            state.octaves = int_value(value, &OCTAVES_MAPPING);
        } else if id == state.cents_id {
            state.cents = float_value(value, &CENTS_MAPPING);
        }
    }

    fn transform(state: &mut TransposeState, input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            if count >= output.len() {
                break;
            }
            match record.kind {
                EVENT_NOTE_ON => {
                    let pitch = record.pitch as i32 + state.octaves * 12 + state.semitones;
                    if !(0..=127).contains(&pitch) {
                        continue; // out of MIDI range: drop the note, do not clamp (its off then passes unmatched)
                    }
                    let mut shifted = *record;
                    shifted.pitch = pitch as u32;
                    shifted.cent = record.cent + state.cents;
                    state.remember(record.id, shifted.pitch);
                    output[count] = shifted;
                }
                EVENT_NOTE_OFF => {
                    let mut off = *record;
                    if let Some(pitch) = state.recall(record.id) {
                        off.pitch = pitch; // the pitch ITS note-on was shifted by, immune to mid-note edits
                    }
                    output[count] = off;
                }
                _ => {
                    output[count] = *record;
                }
            }
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

/// Boot hook: bind this device's semitone parameter with the host (it records the field-path, returns the
/// id). The `sample_rate` is unused (a MIDI fx produces no audio), but the export signature is uniform.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Transpose as MidiEffect>::init(state, sample_rate)) }
}

/// Apply a semitone value the host resolved (initial / edit / automation), by the id `init` got back. The
/// `kind` tag tells the SDK how to type the f32 `value` into a `ParamValue` (uniform to map, or a real i32).
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Transpose as MidiEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Transport STOP: clear the note-on replay table (TS `reset` clears `#startShifts`). The parameter values
/// and bound ids survive (bindings, not sounding state).
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut TransposeState| state.starts_len = 0) }
}

#[cfg(test)]
mod tests {
    //! The pitch transform (driven via the ABI's `MidiEffect`): pitch shifts by octaves * 12 + semitones,
    //! cent shifts by cents, a note-off replays its note-on's shifted pitch, off-range notes drop. In-crate
    //! so it can set the private state.
    use super::{Transpose, TransposeState, MAX_HELD};
    use abi::{EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};

    fn state_at(semitones: i32, octaves: i32, cents: f32) -> TransposeState {
        TransposeState {
            semitones, octaves, cents, semitones_id: 1, octaves_id: 2, cents_id: 3,
            starts: [(0, 0); MAX_HELD], starts_len: 0
        }
    }

    fn note(kind: u32, id: u32, offset: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset, kind, id, pitch, velocity: 0.8, cent: 0.0, duration: 0.0}
    }

    fn blanks() -> [EventRecord; 8] {
        [EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}; 8]
    }

    #[test]
    fn shifts_by_octaves_semitones_and_cents_preserving_count_and_offset() {
        let input = [note(EVENT_NOTE_ON, 7, 64, 60), note(EVENT_NOTE_ON, 8, 96, 67)];
        let mut output = blanks();
        let count = Transpose::transform(&mut state_at(2, 1, 25.0), &input, &mut output);
        assert_eq!(count, 2);
        assert_eq!(output[0].pitch, 74, "60 + 1 octave + 2 st");
        assert_eq!(output[1].pitch, 81);
        assert_eq!(output[0].cent, 25.0, "the cents parameter adds to the note's cent");
        assert_eq!(output[0].offset, 64, "timing is preserved");
        assert_eq!(output[0].id, 7, "identity is preserved");
    }

    #[test]
    fn zero_shift_passes_pitch_and_cent_through() {
        let input = [note(EVENT_NOTE_ON, 1, 0, 60)];
        let mut output = blanks();
        Transpose::transform(&mut state_at(0, 0, 0.0), &input, &mut output);
        assert_eq!(output[0].pitch, 60);
        assert_eq!(output[0].cent, 0.0);
    }

    #[test]
    fn a_note_off_replays_its_note_ons_shifted_pitch_across_a_mid_note_edit() {
        // The on shifts by +12; the parameter then changes; the off must still carry the ON's pitch (TS
        // `#startShifts`), not the current shift.
        let mut state = state_at(12, 0, 0.0);
        let mut output = blanks();
        Transpose::transform(&mut state, &[note(EVENT_NOTE_ON, 5, 0, 60)], &mut output);
        assert_eq!(output[0].pitch, 72);
        state.semitones = 0; // mid-note edit
        let mut off_out = blanks();
        Transpose::transform(&mut state, &[note(EVENT_NOTE_OFF, 5, 0, 60)], &mut off_out);
        assert_eq!(off_out[0].pitch, 72, "the off replays the on's shifted pitch");
        assert_eq!(state.starts_len, 0, "the replay entry is released");
    }

    #[test]
    fn drops_off_range_notes_and_their_offs_pass_unmatched() {
        // 120 + 12 = 132 is out of MIDI range -> the on is dropped; 60 + 12 = 72 is kept. The dropped
        // note's off finds no start entry and passes through unshifted (the TS `isDefined` miss path).
        let input = [note(EVENT_NOTE_ON, 1, 0, 120), note(EVENT_NOTE_ON, 2, 30, 60)];
        let mut output = blanks();
        let mut state = state_at(12, 0, 0.0);
        let count = Transpose::transform(&mut state, &input, &mut output);
        assert_eq!(count, 1, "the off-range note is dropped, not clamped");
        assert_eq!(output[0].pitch, 72);
        assert_eq!(output[0].id, 2, "the kept note is the in-range one");
        let mut off_out = blanks();
        Transpose::transform(&mut state, &[note(EVENT_NOTE_OFF, 1, 0, 120)], &mut off_out);
        assert_eq!(off_out[0].pitch, 120, "the unmatched off passes through unshifted");
    }

    #[test]
    fn parameter_changed_maps_unit_values_but_takes_real_values_directly() {
        let mut state = state_at(0, 0, 0.0);
        // Unit: the uniform value maps through the TS-adapter mappings.
        Transpose::parameter_changed(&mut state, 1, ParamValue::Unit(1.0));
        assert_eq!(state.semitones, 36, "unit 1.0 -> linearInteger(-36, 36) max");
        Transpose::parameter_changed(&mut state, 2, ParamValue::Unit(0.0));
        assert_eq!(state.octaves, -7, "unit 0.0 -> linearInteger(-7, 7) min");
        Transpose::parameter_changed(&mut state, 3, ParamValue::Unit(0.5));
        assert_eq!(state.cents, 0.0, "unit 0.5 -> linear(-50, 50) center");
        // Real field values (UI edits) are used directly.
        Transpose::parameter_changed(&mut state, 1, ParamValue::Int(7));
        assert_eq!(state.semitones, 7);
        Transpose::parameter_changed(&mut state, 3, ParamValue::Float(-12.5));
        assert_eq!(state.cents, -12.5);
    }

    #[test]
    #[should_panic]
    fn parameter_changed_rejects_a_mismatched_type() {
        let mut state = state_at(0, 0, 0.0);
        Transpose::parameter_changed(&mut state, 1, ParamValue::Float(1.5));
    }
}

//! The NOTE FILTER MIDI-EFFECT device (`NoteFilterDeviceBox`): passes note-ons with `min <= pitch <= max`, then
//! either adds `transpose` (a result outside 0..=127 is ignored) or sets the pitch to `key`. A note-off replays
//! the pitch its note-on was given, a note-off whose note-on was ignored is ignored too.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, int_value, EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
use math::value_mapping::LinearInteger;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const MIN_FIELD: [u16; 1] = [10];
const MAX_FIELD: [u16; 1] = [11];
const SET_FIELD: [u16; 1] = [12];
const TRANSPOSE_FIELD: [u16; 1] = [13];
const KEY_FIELD: [u16; 1] = [14];
const KEY_MAPPING: LinearInteger = LinearInteger {min: 0, max: 127};
const TRANSPOSE_MAPPING: LinearInteger = LinearInteger {min: -127, max: 127};

// Same replay table size as device-pitch. When full, a note-on is ignored so its note-off can never hang.
const MAX_HELD: usize = 64;

pub struct NoteFilterState {
    min: i32,
    max: i32,
    set: bool,
    transpose: i32,
    key: i32,
    min_id: u32,
    max_id: u32,
    set_id: u32,
    transpose_id: u32,
    key_id: u32,
    starts: [(u32, u32); MAX_HELD],
    starts_len: usize
}

impl NoteFilterState {
    fn output_pitch(&self, pitch: i32) -> Option<u32> {
        if pitch < self.min || pitch > self.max {return None}
        let output = if self.set {self.key} else {pitch + self.transpose};
        if (0..=127).contains(&output) {Some(output as u32)} else {None}
    }

    fn remember(&mut self, id: u32, pitch: u32) -> bool {
        if self.starts_len >= MAX_HELD {return false}
        self.starts[self.starts_len] = (id, pitch);
        self.starts_len += 1;
        true
    }

    fn recall(&mut self, id: u32) -> Option<u32> {
        let index = self.starts[..self.starts_len].iter().position(|(held, _)| *held == id)?;
        let (_, pitch) = self.starts[index];
        self.starts_len -= 1;
        self.starts[index] = self.starts[self.starts_len];
        Some(pitch)
    }

    fn release_all_into(&mut self, position: f64, out: &mut [EventRecord]) -> usize {
        let written = self.starts_len.min(out.len());
        for (slot, (id, pitch)) in out.iter_mut().zip(self.starts[..written].iter()) {
            *slot = EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: *id, pitch: *pitch, velocity: 0.0, cent: 0.0, duration: 0.0};
        }
        self.starts_len = 0;
        written
    }
}

pub struct NoteFilter;

impl MidiEffect for NoteFilter {
    type State = NoteFilterState;

    fn init(state: &mut NoteFilterState, _sample_rate: f32) {
        state.max = 127;
        state.key = 60;
        state.min_id = abi::bind_parameter(&MIN_FIELD);
        state.max_id = abi::bind_parameter(&MAX_FIELD);
        state.set_id = abi::bind_parameter(&SET_FIELD);
        state.transpose_id = abi::bind_parameter(&TRANSPOSE_FIELD);
        state.key_id = abi::bind_parameter(&KEY_FIELD);
    }

    fn parameter_changed(state: &mut NoteFilterState, id: u32, value: ParamValue) {
        if id == state.min_id {
            state.min = int_value(value, &KEY_MAPPING);
        } else if id == state.max_id {
            state.max = int_value(value, &KEY_MAPPING);
        } else if id == state.set_id {
            state.set = bool_value(value);
        } else if id == state.transpose_id {
            state.transpose = int_value(value, &TRANSPOSE_MAPPING);
        } else if id == state.key_id {
            state.key = int_value(value, &KEY_MAPPING);
        }
    }

    fn transform(state: &mut NoteFilterState, input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            if count >= output.len() {
                break;
            }
            match record.kind {
                EVENT_NOTE_ON => {
                    let Some(pitch) = state.output_pitch(record.pitch as i32) else {continue};
                    if !state.remember(record.id, pitch) {continue}
                    let mut note = *record;
                    note.pitch = pitch;
                    output[count] = note;
                }
                EVENT_NOTE_OFF => {
                    let Some(pitch) = state.recall(record.id) else {continue};
                    let mut off = *record;
                    off.pitch = pitch;
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

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<NoteFilterState>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<NoteFilter>(from, to, flags, state_ptr, out_ptr, max)
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NoteFilter as MidiEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <NoteFilter as MidiEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 | 1 | 4 => int_value(value, &KEY_MAPPING) as f32,
        2 => if bool_value(value) {1.0} else {0.0},
        3 => int_value(value, &TRANSPOSE_MAPPING) as f32,
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut NoteFilterState| state.starts_len = 0) }
}

/// The host disabled or removed this effect: end every note that passed it.
#[no_mangle]
pub extern "C" fn release_all(state_ptr: u32, position: f64, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut NoteFilterState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    state.release_all_into(position, out) as u32
}

#[cfg(test)]
mod tests {
    use super::{NoteFilter, NoteFilterState, MAX_HELD};
    use abi::{EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};

    fn filter(min: i32, max: i32, set: bool, transpose: i32, key: i32) -> NoteFilterState {
        NoteFilterState {
            min, max, set, transpose, key, min_id: 1, max_id: 2, set_id: 3, transpose_id: 4, key_id: 5,
            starts: [(0, 0); MAX_HELD], starts_len: 0
        }
    }

    fn pass_all() -> NoteFilterState {filter(0, 127, false, 0, 60)}

    fn note(kind: u32, id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 16, kind, id, pitch, velocity: 0.8, cent: 12.5, duration: 0.0}
    }

    fn run(state: &mut NoteFilterState, input: &[EventRecord]) -> Vec<EventRecord> {
        let mut output = [note(0, 0, 0); 128];
        let count = NoteFilter::transform(state, input, &mut output);
        output[..count].to_vec()
    }

    fn pitches(events: &[EventRecord]) -> Vec<u32> {events.iter().map(|event| event.pitch).collect()}

    #[test]
    fn defaults_pass_everything_unchanged() {
        let mut state = pass_all();
        let input = [note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_ON, 2, 60), note(EVENT_NOTE_ON, 3, 127)];
        let output = run(&mut state, &input);
        assert_eq!(pitches(&output), vec![0, 60, 127]);
        assert_eq!(output[1].velocity, 0.8);
        assert_eq!(output[1].cent, 12.5);
        assert_eq!(output[1].offset, 16);
        assert_eq!(output[1].id, 2);
    }

    #[test]
    fn range_is_inclusive_on_both_ends() {
        let mut state = filter(36, 38, false, 0, 60);
        let input: Vec<EventRecord> = (34..=40).map(|pitch| note(EVENT_NOTE_ON, pitch, pitch)).collect();
        assert_eq!(pitches(&run(&mut state, &input)), vec![36, 37, 38]);
    }

    #[test]
    fn single_key_range() {
        let mut state = filter(42, 42, false, 0, 60);
        let input = [note(EVENT_NOTE_ON, 1, 41), note(EVENT_NOTE_ON, 2, 42), note(EVENT_NOTE_ON, 3, 43)];
        assert_eq!(pitches(&run(&mut state, &input)), vec![42]);
    }

    #[test]
    fn min_above_max_passes_nothing() {
        let mut state = filter(70, 50, false, 0, 60);
        let input: Vec<EventRecord> = (0..=127).map(|pitch| note(EVENT_NOTE_ON, pitch, pitch)).collect();
        assert!(run(&mut state, &input).is_empty());
    }

    #[test]
    fn transpose_adds_semitones() {
        let mut state = filter(0, 127, false, -24, 60);
        assert_eq!(pitches(&run(&mut state, &[note(EVENT_NOTE_ON, 1, 60)])), vec![36]);
    }

    #[test]
    fn transpose_out_of_range_is_ignored_not_clamped() {
        let mut state = filter(0, 127, false, 10, 60);
        let input = [note(EVENT_NOTE_ON, 1, 117), note(EVENT_NOTE_ON, 2, 118), note(EVENT_NOTE_ON, 3, 0)];
        assert_eq!(pitches(&run(&mut state, &input)), vec![127, 10]);
        let mut state = filter(0, 127, false, -10, 60);
        let input = [note(EVENT_NOTE_ON, 1, 9), note(EVENT_NOTE_ON, 2, 10)];
        assert_eq!(pitches(&run(&mut state, &input)), vec![0]);
    }

    #[test]
    fn transpose_extremes() {
        let mut state = filter(0, 127, false, 127, 60);
        assert_eq!(pitches(&run(&mut state, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_ON, 2, 1)])), vec![127]);
        let mut state = filter(0, 127, false, -127, 60);
        assert_eq!(pitches(&run(&mut state, &[note(EVENT_NOTE_ON, 1, 127), note(EVENT_NOTE_ON, 2, 126)])), vec![0]);
    }

    #[test]
    fn set_plays_every_passing_note_as_key_ignoring_transpose() {
        let mut state = filter(36, 48, true, 12, 60);
        let input = [note(EVENT_NOTE_ON, 1, 35), note(EVENT_NOTE_ON, 2, 36), note(EVENT_NOTE_ON, 3, 48), note(EVENT_NOTE_ON, 4, 49)];
        let output = run(&mut state, &input);
        assert_eq!(pitches(&output), vec![60, 60]);
        assert_eq!(output.iter().map(|event| event.id).collect::<Vec<u32>>(), vec![2, 3]);
        assert_eq!(output[0].cent, 12.5);
    }

    #[test]
    fn note_off_replays_its_note_on_pitch_across_edits() {
        let mut state = filter(0, 127, false, 12, 60);
        assert_eq!(pitches(&run(&mut state, &[note(EVENT_NOTE_ON, 5, 60)])), vec![72]);
        state.transpose = 0;
        state.set = true;
        state.key = 30;
        state.min = 100;
        assert_eq!(pitches(&run(&mut state, &[note(EVENT_NOTE_OFF, 5, 60)])), vec![72]);
        assert_eq!(state.starts_len, 0);
    }

    #[test]
    fn note_off_of_an_ignored_note_on_is_ignored() {
        let mut state = filter(50, 60, false, 0, 60);
        assert!(run(&mut state, &[note(EVENT_NOTE_ON, 1, 40)]).is_empty());
        state.min = 0;
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 1, 40)]).is_empty());
    }

    #[test]
    fn note_on_and_off_in_one_block() {
        let mut state = filter(0, 127, true, 0, 48);
        let output = run(&mut state, &[note(EVENT_NOTE_ON, 1, 70), note(EVENT_NOTE_OFF, 1, 70)]);
        assert_eq!(output.iter().map(|event| (event.kind, event.pitch)).collect::<Vec<(u32, u32)>>(),
            vec![(EVENT_NOTE_ON, 48), (EVENT_NOTE_OFF, 48)]);
        assert_eq!(state.starts_len, 0);
    }

    #[test]
    fn full_replay_table_ignores_new_note_ons_so_no_off_hangs() {
        let mut state = pass_all();
        let ons: Vec<EventRecord> = (0..MAX_HELD as u32).map(|id| note(EVENT_NOTE_ON, id, 60)).collect();
        assert_eq!(run(&mut state, &ons).len(), MAX_HELD);
        assert!(run(&mut state, &[note(EVENT_NOTE_ON, 999, 61)]).is_empty());
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 999, 61)]).is_empty());
        assert_eq!(run(&mut state, &[note(EVENT_NOTE_OFF, 0, 60)]).len(), 1);
        assert_eq!(pitches(&run(&mut state, &[note(EVENT_NOTE_ON, 1000, 62)])), vec![62]);
    }

    #[test]
    fn release_all_ends_every_passed_note_with_its_output_pitch_and_forgets_them() {
        let mut state = filter(0, 127, false, 5, 60);
        run(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 70), note(EVENT_NOTE_ON, 3, 125)]);
        let mut out = [note(0, 0, 0); 8];
        let count = state.release_all_into(96.0, &mut out);
        assert_eq!(count, 2);
        assert_eq!(out[..count].iter().map(|event| (event.kind, event.id, event.pitch, event.position)).collect::<Vec<(u32, u32, u32, f64)>>(),
            vec![(EVENT_NOTE_OFF, 1, 65, 96.0), (EVENT_NOTE_OFF, 2, 75, 96.0)]);
        assert_eq!(state.starts_len, 0);
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 1, 60)]).is_empty(), "the late upstream off finds nothing");
    }

    #[test]
    fn other_event_kinds_pass_through() {
        let mut state = filter(70, 50, false, 0, 60);
        let other = note(99, 1, 10);
        assert_eq!(run(&mut state, &[other]).len(), 1);
    }

    #[test]
    fn parameter_changed_maps_unit_and_takes_real_values() {
        let mut state = pass_all();
        NoteFilter::parameter_changed(&mut state, 1, ParamValue::Unit(1.0));
        assert_eq!(state.min, 127);
        NoteFilter::parameter_changed(&mut state, 2, ParamValue::Unit(0.0));
        assert_eq!(state.max, 0);
        NoteFilter::parameter_changed(&mut state, 3, ParamValue::Bool(true));
        assert!(state.set);
        NoteFilter::parameter_changed(&mut state, 4, ParamValue::Unit(0.0));
        assert_eq!(state.transpose, -127);
        NoteFilter::parameter_changed(&mut state, 4, ParamValue::Unit(1.0));
        assert_eq!(state.transpose, 127);
        NoteFilter::parameter_changed(&mut state, 4, ParamValue::Int(-5));
        assert_eq!(state.transpose, -5);
        NoteFilter::parameter_changed(&mut state, 5, ParamValue::Int(36));
        assert_eq!(state.key, 36);
    }

    #[test]
    #[should_panic]
    fn parameter_changed_rejects_a_mismatched_type() {
        let mut state = pass_all();
        NoteFilter::parameter_changed(&mut state, 1, ParamValue::Float(1.5));
    }
}

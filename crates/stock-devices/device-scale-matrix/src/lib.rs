//! The SCALE MATRIX MIDI-EFFECT device (`ScaleMatrixDeviceBox`): every note-on moves to the nearest key of
//! a scale (ties down), either its own `root` + `scale` or, with `follow`, the project key at the note's
//! position. The scale index after the stock scales is CUSTOM: a per-pitch-class offset relative to the
//! root (`custom`), where `MUTE` drops the note. A note-off replays the pitch its note-on was given. Notes
//! quantised onto a pitch that is already sounding share it: only the first note-on and the last note-off go out.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, int_value, EventRecord, FieldValue, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
use math::harmony::{quantise, STOCK_SCALES};
use math::value_mapping::LinearInteger;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const ROOT_FIELD: [u16; 1] = [10];
const SCALE_FIELD: [u16; 1] = [11];
const FOLLOW_FIELD: [u16; 1] = [12];
const CUSTOM_FIELD: [u16; 1] = [13];
const ROOT_MAPPING: LinearInteger = LinearInteger {min: 0, max: 11};
// WASM CONTRACT: the index after the stock scales is Custom, `MUTE` is the custom offset of a muted pitch class.
const CUSTOM_SCALE: i32 = STOCK_SCALES.len() as i32;
const MUTE: i32 = 12;
const SCALE_MAPPING: LinearInteger = LinearInteger {min: 0, max: CUSTOM_SCALE};

// Same replay table size as device-note-filter. When full, a note-on is ignored so its note-off can never hang.
const MAX_HELD: usize = 64;

#[derive(Clone, Copy)]
struct Held {
    id: u32,
    pitch: u32,
    owner: u32
}

pub struct ScaleMatrixState {
    root: i32,
    scale: i32,
    follow: bool,
    root_id: u32,
    scale_id: u32,
    follow_id: u32,
    custom: [i32; 12],
    custom_id: u32,
    held: [Held; MAX_HELD],
    held_len: usize
}

impl ScaleMatrixState {
    fn output_pitch(&self, pitch: i32, position: f64) -> Option<u32> {
        let (root, bits) = if self.follow {
            let harmony = abi::harmony_at(position);
            (harmony.root, harmony.bits)
        } else {
            (self.root, STOCK_SCALES[self.scale.min(CUSTOM_SCALE - 1) as usize])
        };
        if self.scale != CUSTOM_SCALE {
            return Some(quantise(pitch, root, bits) as u32);
        }
        let offset = self.custom[(pitch - root).rem_euclid(12) as usize];
        if offset == MUTE {
            return None;
        }
        let output = pitch + offset;
        Some(if output < 0 {output + 12} else if output > 127 {output - 12} else {output} as u32)
    }

    fn sounding(&self, pitch: u32) -> Option<u32> {
        self.held[..self.held_len].iter().find(|held| held.pitch == pitch).map(|held| held.owner)
    }

    fn release(&mut self, id: u32) -> Option<Held> {
        let index = self.held[..self.held_len].iter().position(|held| held.id == id)?;
        let held = self.held[index];
        self.held_len -= 1;
        self.held[index] = self.held[self.held_len];
        Some(held)
    }

    fn release_all_into(&mut self, position: f64, out: &mut [EventRecord]) -> usize {
        let mut written = 0;
        for index in 0..self.held_len {
            let held = self.held[index];
            if self.held[..index].iter().any(|other| other.pitch == held.pitch) || written >= out.len() {
                continue;
            }
            out[written] = EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: held.owner, pitch: held.pitch, velocity: 0.0, cent: 0.0, duration: 0.0};
            written += 1;
        }
        self.held_len = 0;
        written
    }
}

pub struct ScaleMatrix;

impl MidiEffect for ScaleMatrix {
    type State = ScaleMatrixState;

    fn init(state: &mut ScaleMatrixState, _sample_rate: f32) {
        state.root_id = abi::bind_parameter(&ROOT_FIELD);
        state.scale_id = abi::bind_parameter(&SCALE_FIELD);
        state.follow_id = abi::bind_parameter(&FOLLOW_FIELD);
        state.custom_id = abi::observe_field(&CUSTOM_FIELD);
    }

    fn parameter_changed(state: &mut ScaleMatrixState, id: u32, value: ParamValue) {
        if id == state.root_id {
            state.root = int_value(value, &ROOT_MAPPING);
        } else if id == state.scale_id {
            state.scale = int_value(value, &SCALE_MAPPING);
        } else if id == state.follow_id {
            state.follow = bool_value(value);
        }
    }

    fn transform(state: &mut ScaleMatrixState, input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            if count >= output.len() {
                break;
            }
            match record.kind {
                EVENT_NOTE_ON => {
                    if state.held_len >= MAX_HELD {continue}
                    let Some(pitch) = state.output_pitch(record.pitch as i32, record.position) else {continue};
                    let owner = state.sounding(pitch);
                    state.held[state.held_len] = Held {id: record.id, pitch, owner: owner.unwrap_or(record.id)};
                    state.held_len += 1;
                    if owner.is_some() {continue}
                    let mut note = *record;
                    note.pitch = pitch;
                    output[count] = note;
                }
                EVENT_NOTE_OFF => {
                    let Some(held) = state.release(record.id) else {continue};
                    if state.sounding(held.pitch).is_some() {continue}
                    let mut off = *record;
                    off.id = held.owner;
                    off.pitch = held.pitch;
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
    core::mem::size_of::<ScaleMatrixState>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<ScaleMatrix>(from, to, flags, state_ptr, out_ptr, max)
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ScaleMatrix as MidiEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ScaleMatrix as MidiEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => int_value(value, &ROOT_MAPPING) as f32,
        1 => int_value(value, &SCALE_MAPPING) as f32,
        2 => if bool_value(value) {1.0} else {0.0},
        _ => f32::NAN
    }
}

pub fn set_custom(state: &mut ScaleMatrixState, values: &[i32]) {
    for (slot, value) in values.iter().take(12).enumerate() {
        state.custom[slot] = (*value).clamp(-6, MUTE);
    }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    let state = unsafe { &mut *(state_ptr as *mut ScaleMatrixState) };
    if id == state.custom_id {
        if let FieldValue::Ints(values) = unsafe { FieldValue::from_wire(kind, bits, len) } {
            set_custom(state, values);
        }
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut ScaleMatrixState| state.held_len = 0) }
}

/// The host disabled or removed this effect: end every note that passed it.
#[no_mangle]
pub extern "C" fn release_all(state_ptr: u32, position: f64, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ScaleMatrixState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    state.release_all_into(position, out) as u32
}

#[cfg(test)]
mod tests {
    use super::{set_custom, Held, ScaleMatrix, ScaleMatrixState, CUSTOM_SCALE, MAX_HELD, MUTE};
    use abi::{EventRecord, Harmony, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
    use math::harmony::{quantise, MAJOR_BITS, STOCK_SCALES};

    // the native harmony is process-wide, tests that set it must not overlap
    static HARMONY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn matrix(root: i32, scale: i32, follow: bool) -> ScaleMatrixState {
        ScaleMatrixState {
            root, scale, follow, root_id: 1, scale_id: 2, follow_id: 3, custom: [0; 12], custom_id: 4,
            held: [Held {id: 0, pitch: 0, owner: 0}; MAX_HELD], held_len: 0
        }
    }

    fn note(kind: u32, id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 16, kind, id, pitch, velocity: 0.8, cent: 12.5, duration: 0.0}
    }

    fn run(state: &mut ScaleMatrixState, input: &[EventRecord]) -> Vec<EventRecord> {
        let mut output = [note(0, 0, 0); 256];
        let count = ScaleMatrix::transform(state, input, &mut output);
        output[..count].to_vec()
    }

    fn events(output: &[EventRecord]) -> Vec<(u32, u32, u32)> {
        output.iter().map(|event| (event.kind, event.id, event.pitch)).collect()
    }

    #[test]
    fn c_major_keeps_white_keys_and_moves_black_keys_down() {
        let mut state = matrix(0, 0, false);
        let input: Vec<EventRecord> = (60..72).map(|pitch| note(EVENT_NOTE_ON, pitch, pitch)).collect();
        let output = run(&mut state, &input);
        let pitches: Vec<u32> = output.iter().map(|event| event.pitch).collect();
        assert_eq!(pitches, vec![60, 62, 64, 65, 67, 69, 71], "black keys share the white key below");
        assert_eq!(output[0].velocity, 0.8);
        assert_eq!(output[0].cent, 12.5);
    }

    #[test]
    fn every_stock_scale_and_root_matches_the_quantiser() {
        for scale in 0..STOCK_SCALES.len() as i32 {
            for root in 0..12 {
                for pitch in 0..=127u32 {
                    let mut state = matrix(root, scale, false);
                    let output = run(&mut state, &[note(EVENT_NOTE_ON, 1, pitch)]);
                    assert_eq!(output[0].pitch as i32, quantise(pitch as i32, root, STOCK_SCALES[scale as usize]));
                }
            }
        }
    }

    #[test]
    fn note_off_replays_its_note_on_pitch_across_edits() {
        let mut state = matrix(0, 0, false);
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_ON, 5, 61)])), vec![(EVENT_NOTE_ON, 5, 60)]);
        state.root = 1;
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_OFF, 5, 61)])), vec![(EVENT_NOTE_OFF, 5, 60)]);
        assert_eq!(state.held_len, 0);
    }

    #[test]
    fn colliding_notes_share_one_output_note() {
        let mut state = matrix(0, 0, false);
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 61)])), vec![(EVENT_NOTE_ON, 1, 60)]);
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 1, 60)]).is_empty(), "C# still holds the shared C");
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_OFF, 2, 61)])), vec![(EVENT_NOTE_OFF, 1, 60)],
            "the last release ends the note under the id it started with");
        assert_eq!(state.held_len, 0);
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_ON, 3, 61), note(EVENT_NOTE_ON, 4, 60), note(EVENT_NOTE_OFF, 4, 60), note(EVENT_NOTE_OFF, 3, 61)])),
            vec![(EVENT_NOTE_ON, 3, 60), (EVENT_NOTE_OFF, 3, 60)]);
    }

    #[test]
    fn follow_reads_the_project_key() {
        let _lock = HARMONY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = matrix(0, 0, true);
        abi::set_native_harmony(Harmony {root: 2, bits: MAJOR_BITS, chord: None});
        let output = run(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 65)]);
        abi::set_native_harmony(Harmony {root: 0, bits: MAJOR_BITS, chord: None});
        assert_eq!(events(&output), vec![(EVENT_NOTE_ON, 1, 59), (EVENT_NOTE_ON, 2, 64)], "in D major C and F sit between two keys and go down");
    }

    #[test]
    fn full_replay_table_ignores_new_note_ons_so_no_off_hangs() {
        let mut state = matrix(0, 0, false);
        let ons: Vec<EventRecord> = (0..MAX_HELD as u32).map(|id| note(EVENT_NOTE_ON, id, 60)).collect();
        assert_eq!(run(&mut state, &ons).len(), 1);
        assert!(run(&mut state, &[note(EVENT_NOTE_ON, 999, 64)]).is_empty());
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 999, 64)]).is_empty());
    }

    #[test]
    fn release_all_ends_each_sounding_note_once() {
        let mut state = matrix(0, 0, false);
        run(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 61), note(EVENT_NOTE_ON, 3, 64)]);
        let mut out = [note(0, 0, 0); 8];
        let count = state.release_all_into(96.0, &mut out);
        assert_eq!(events(&out[..count]), vec![(EVENT_NOTE_OFF, 1, 60), (EVENT_NOTE_OFF, 3, 64)]);
        assert_eq!(state.held_len, 0);
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 2, 61)]).is_empty(), "the late upstream off finds nothing");
    }

    #[test]
    fn release_all_ends_a_shared_note_after_its_first_holder_left() {
        let mut state = matrix(0, 0, false);
        run(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 61), note(EVENT_NOTE_OFF, 1, 60)]);
        let mut out = [note(0, 0, 0); 8];
        let count = state.release_all_into(96.0, &mut out);
        assert_eq!(events(&out[..count]), vec![(EVENT_NOTE_OFF, 1, 60)], "the shared note ends under its starting id");
    }

    #[test]
    fn custom_offsets_apply_relative_to_the_root_and_mute_drops_the_note() {
        let mut state = matrix(2, CUSTOM_SCALE, false);
        let mut custom = [0; 12];
        custom[1] = -1;
        custom[3] = 5;
        custom[4] = MUTE;
        set_custom(&mut state, &custom);
        let input = [note(EVENT_NOTE_ON, 1, 62), note(EVENT_NOTE_ON, 2, 63), note(EVENT_NOTE_ON, 3, 65), note(EVENT_NOTE_ON, 4, 66)];
        assert_eq!(events(&run(&mut state, &input)), vec![(EVENT_NOTE_ON, 1, 62), (EVENT_NOTE_ON, 3, 70)],
            "D stays, D# goes down to the sounding D, F goes up to A#, F# is muted");
        assert!(run(&mut state, &[note(EVENT_NOTE_OFF, 4, 66)]).is_empty(), "the off of a muted note is dropped too");
        state.root = 0;
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_ON, 5, 64)])), vec![], "with root C the mute moves to E");
    }

    #[test]
    fn custom_offsets_stay_inside_0_to_127() {
        let mut state = matrix(0, CUSTOM_SCALE, false);
        let mut custom = [0; 12];
        custom[0] = -6;
        custom[7] = 5;
        set_custom(&mut state, &custom);
        assert_eq!(events(&run(&mut state, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_ON, 2, 127)])),
            vec![(EVENT_NOTE_ON, 1, 6), (EVENT_NOTE_ON, 2, 120)]);
    }

    #[test]
    fn custom_follows_the_project_root() {
        let _lock = HARMONY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = matrix(0, CUSTOM_SCALE, true);
        let mut custom = [0; 12];
        custom[1] = MUTE;
        set_custom(&mut state, &custom);
        abi::set_native_harmony(Harmony {root: 5, bits: MAJOR_BITS, chord: None});
        let output = run(&mut state, &[note(EVENT_NOTE_ON, 1, 61), note(EVENT_NOTE_ON, 2, 66)]);
        abi::set_native_harmony(Harmony {root: 0, bits: MAJOR_BITS, chord: None});
        assert_eq!(events(&output), vec![(EVENT_NOTE_ON, 1, 61)], "with root F the mute sits on F#");
    }

    #[test]
    fn other_event_kinds_pass_through() {
        let mut state = matrix(0, 0, false);
        assert_eq!(run(&mut state, &[note(99, 1, 10)]).len(), 1);
    }

    #[test]
    fn parameter_changed_maps_unit_and_takes_real_values() {
        let mut state = matrix(0, 0, false);
        ScaleMatrix::parameter_changed(&mut state, 1, ParamValue::Unit(1.0));
        assert_eq!(state.root, 11);
        ScaleMatrix::parameter_changed(&mut state, 2, ParamValue::Unit(1.0));
        assert_eq!(state.scale, CUSTOM_SCALE);
        ScaleMatrix::parameter_changed(&mut state, 2, ParamValue::Int(3));
        assert_eq!(state.scale, 3);
        ScaleMatrix::parameter_changed(&mut state, 3, ParamValue::Bool(true));
        assert!(state.follow);
    }
}

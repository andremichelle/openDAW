//! The CHORD KEYS MIDI-EFFECT device (`ChordKeysDeviceBox`): a white key plays the chord on its step of a key
//! (C = 1 whatever the root), held black keys change that chord (C# 7th, D# 9th, F# sus2, G# sus4, A# the next
//! inversion). A change while a chord sounds sends only the difference: notes that stay keep sounding, removed
//! notes get their note-off and added notes their note-on. The key is the device's own `root` + `scale`, or with
//! `follow` the project key at the note's position.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, int_value, EventRecord, MidiEffect, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
use math::harmony::{chord, STOCK_SCALES};
use math::value_mapping::LinearInteger;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const ROOT_FIELD: [u16; 1] = [10];
const SCALE_FIELD: [u16; 1] = [11];
const FOLLOW_FIELD: [u16; 1] = [12];
const VOICE_LEADING_FIELD: [u16; 1] = [13];
const ROOT_MAPPING: LinearInteger = LinearInteger {min: 0, max: 11};
const SCALE_MAPPING: LinearInteger = LinearInteger {min: 0, max: STOCK_SCALES.len() as i32 - 1};
const WHITE_KEYS: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];
// WASM CONTRACT: the helper pitch classes and their bit in the broadcast helper mask (ChordKeysDeviceBoxAdapter)
const HELPERS: [i32; 5] = [1, 3, 6, 8, 10];
const SEVENTH: usize = 0;
const NINTH: usize = 1;
const SUS2: usize = 2;
const SUS4: usize = 3;
const INVERSION: usize = 4;
const SUS2_SHAPE: i32 = 1 | (1 << 2) | (1 << 7);
const SUS4_SHAPE: i32 = 1 | (1 << 5) | (1 << 7);
const MAX_KEYS: usize = 32;
const MAX_NOTES: usize = 5;

#[derive(Clone, Copy, Default)]
struct Key {
    id: u32,
    pitch: u32,
    velocity: f32,
    end: f64
}

#[derive(Clone, Copy, Default)]
struct Note {
    id: u32,
    pitch: u32
}

pub struct ChordKeysState {
    root: i32,
    scale: i32,
    follow: bool,
    voice_leading: bool,
    root_id: u32,
    scale_id: u32,
    follow_id: u32,
    voice_leading_id: u32,
    broadcast: u32,
    // held white keys in press order, the latest one plays
    keys: [Key; MAX_KEYS],
    keys_len: usize,
    // held black keys, by id so a note-off always finds its key
    helpers: [Key; MAX_KEYS],
    helpers_len: usize,
    sounding: [Note; MAX_NOTES],
    sounding_len: usize,
    degree: i32,
    previous_center: f32,
    has_previous: bool,
    next_id: u32
}

fn is_white(pitch: u32) -> bool {WHITE_KEYS.contains(&((pitch % 12) as i32))}

fn remove(list: &mut [Key], len: &mut usize, id: u32) -> bool {
    let Some(index) = list[..*len].iter().position(|key| key.id == id) else {return false};
    list.copy_within(index + 1..*len, index);
    *len -= 1;
    true
}

impl ChordKeysState {
    fn helper_mask(&self) -> i32 {
        HELPERS.iter().enumerate().fold(0, |mask, (bit, pitch_class)| {
            let held = self.helpers[..self.helpers_len].iter().any(|key| (key.pitch % 12) as i32 == *pitch_class);
            if held {mask | (1 << bit)} else {mask}
        })
    }

    fn key_at(&self, position: f64) -> (i32, i32) {
        if self.follow {
            let harmony = abi::harmony_at(position);
            (harmony.root, harmony.bits)
        } else {
            (self.root, STOCK_SCALES[self.scale.clamp(0, STOCK_SCALES.len() as i32 - 1) as usize])
        }
    }

    // the pitches the latest white key plays with the held helpers, at most five
    fn target(&self, position: f64) -> ([u32; MAX_NOTES], usize, i32) {
        let mut pitches = [0u32; MAX_NOTES];
        if self.keys_len == 0 {return (pitches, 0, 0)}
        let pressed = self.keys[self.keys_len - 1].pitch as i32;
        let degree = WHITE_KEYS.iter().position(|pitch_class| *pitch_class == pressed % 12).unwrap_or(0) as i32 + 1;
        let helpers = self.helper_mask();
        let has = |bit: usize| helpers & (1 << bit) != 0;
        let shape = if has(SUS2) {SUS2_SHAPE} else if has(SUS4) {SUS4_SHAPE} else {0};
        let (key_root, bits) = self.key_at(position);
        // the triad plus the 7th and the 9th each on their own key, a sus shape replaces the chord
        let stacked = || -> Option<(i32, i32)> {
            if shape != 0 {return chord(key_root, bits, degree, 0, shape, 3, 0)}
            let (chord_root, triad) = chord(key_root, bits, degree, 0, 0, 3, 0)?;
            let (_, seventh) = chord(key_root, bits, degree, 0, 0, 4, 0)?;
            let (_, ninth) = chord(key_root, bits, degree, 0, 0, 5, 0)?;
            let mut mask = triad;
            if has(SEVENTH) {mask |= seventh & !triad}
            if has(NINTH) {mask |= ninth & !seventh}
            Some((chord_root, mask))
        };
        let stacked = stacked();
        let voiced = |inversion: i32, shift: i32| -> ([i32; MAX_NOTES], usize) {
            let mut voice = [0i32; MAX_NOTES];
            let mut count = 0;
            if let Some((chord_root, mask)) = stacked {
                let base = pressed - pressed % 12 + key_root + (chord_root - key_root).rem_euclid(12) + shift;
                for interval in 0..32 {
                    if mask & (1 << interval) != 0 && count < MAX_NOTES {
                        voice[count] = base + interval;
                        count += 1;
                    }
                }
                let rotate = (inversion.max(0) as usize).min(count.saturating_sub(1));
                for pitch in voice[..rotate].iter_mut() {*pitch += 12}
                voice[..count].sort_unstable();
            }
            (voice, count)
        };
        let (mut voice, mut count) = voiced(if has(INVERSION) {1} else {0}, 0);
        if self.voice_leading && self.has_previous && count > 0 && !has(INVERSION) {
            let center = |voice: &[i32]| voice.iter().sum::<i32>() as f32 / voice.len() as f32;
            let mut best = f32::MAX;
            for inversion in 0..count as i32 {
                for shift in [0, -12] {
                    let (candidate, size) = voiced(inversion, shift);
                    let distance = (center(&candidate[..size]) - self.previous_center).abs();
                    if size > 0 && distance < best {
                        best = distance;
                        voice = candidate;
                        count = size;
                    }
                }
            }
        }
        let mut written = 0;
        for pitch in voice[..count].iter().filter(|pitch| (0..=127).contains(*pitch)) {
            pitches[written] = *pitch as u32;
            written += 1;
        }
        (pitches, written, degree)
    }

    // sends the difference between what sounds and what should sound
    fn revoice(&mut self, position: f64, output: &mut [EventRecord], count: &mut usize) {
        let (pitches, size, degree) = self.target(position);
        let target = &pitches[..size];
        let mut index = 0;
        while index < self.sounding_len {
            let note = self.sounding[index];
            if target.contains(&note.pitch) {
                index += 1;
                continue;
            }
            if *count >= output.len() {
                index += 1;
                continue;
            }
            output[*count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: note.id, pitch: note.pitch, velocity: 0.0, cent: 0.0, duration: 0.0};
            *count += 1;
            self.sounding_len -= 1;
            self.sounding[index] = self.sounding[self.sounding_len];
        }
        let (velocity, end) = if self.keys_len > 0 {
            let key = self.keys[self.keys_len - 1];
            (key.velocity, key.end)
        } else {(0.0, f64::INFINITY)};
        let duration = if end.is_finite() {(end - position).max(1.0)} else {f64::INFINITY};
        for pitch in target {
            if self.sounding[..self.sounding_len].iter().any(|note| note.pitch == *pitch) {continue}
            if *count >= output.len() || self.sounding_len >= MAX_NOTES {break}
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1);
            output[*count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id, pitch: *pitch, velocity, cent: 0.0, duration};
            *count += 1;
            self.sounding[self.sounding_len] = Note {id, pitch: *pitch};
            self.sounding_len += 1;
        }
        self.degree = degree;
        if size > 0 {
            self.previous_center = target.iter().sum::<u32>() as f32 / size as f32;
            self.has_previous = true;
        }
    }

    // degree (0 none), helper mask, then the sounding pitches as four 32 bit masks
    fn write_broadcast(&self) {
        let slot = abi::broadcast_ptr(self.broadcast);
        if slot == 0 {return}
        let mut words = [0i32; 6];
        words[0] = self.degree;
        words[1] = if self.sounding_len > 0 {self.helper_mask()} else {0};
        for note in &self.sounding[..self.sounding_len] {
            words[2 + (note.pitch / 32) as usize] |= 1 << (note.pitch % 32);
        }
        unsafe { core::ptr::copy_nonoverlapping(words.as_ptr(), slot as *mut i32, 6); }
    }

    fn release_all_into(&mut self, position: f64, out: &mut [EventRecord]) -> usize {
        let mut written = 0;
        for note in &self.sounding[..self.sounding_len] {
            if written >= out.len() {break}
            out[written] = EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: note.id, pitch: note.pitch, velocity: 0.0, cent: 0.0, duration: 0.0};
            written += 1;
        }
        self.clear();
        written
    }

    fn clear(&mut self) {
        self.sounding_len = 0;
        self.keys_len = 0;
        self.helpers_len = 0;
        self.degree = 0;
        self.has_previous = false;
    }
}

pub struct ChordKeys;

impl MidiEffect for ChordKeys {
    type State = ChordKeysState;

    fn init(state: &mut ChordKeysState, _sample_rate: f32) {
        state.root_id = abi::bind_parameter(&ROOT_FIELD);
        state.scale_id = abi::bind_parameter(&SCALE_FIELD);
        state.follow_id = abi::bind_parameter(&FOLLOW_FIELD);
        state.voice_leading_id = abi::bind_parameter(&VOICE_LEADING_FIELD);
        state.broadcast = abi::bind_broadcast_int_array(&[0], 6);
        state.next_id = 1;
    }

    fn parameter_changed(state: &mut ChordKeysState, id: u32, value: ParamValue) {
        if id == state.root_id {
            state.root = int_value(value, &ROOT_MAPPING);
        } else if id == state.scale_id {
            state.scale = int_value(value, &SCALE_MAPPING);
        } else if id == state.follow_id {
            state.follow = bool_value(value);
        } else if id == state.voice_leading_id {
            state.voice_leading = bool_value(value);
        }
    }

    fn transform(state: &mut ChordKeysState, input: &[EventRecord], output: &mut [EventRecord]) -> usize {
        let mut count = 0;
        for record in input {
            match record.kind {
                EVENT_NOTE_ON => {
                    let end = if record.duration > 0.0 {record.position + record.duration} else {f64::INFINITY};
                    let key = Key {id: record.id, pitch: record.pitch, velocity: record.velocity, end};
                    if is_white(record.pitch) {
                        if state.keys_len >= MAX_KEYS {continue}
                        state.keys[state.keys_len] = key;
                        state.keys_len += 1;
                    } else {
                        if state.helpers_len >= MAX_KEYS {continue}
                        state.helpers[state.helpers_len] = key;
                        state.helpers_len += 1;
                    }
                    state.revoice(record.position, output, &mut count);
                }
                EVENT_NOTE_OFF => {
                    let removed = remove(&mut state.keys, &mut state.keys_len, record.id)
                        || remove(&mut state.helpers, &mut state.helpers_len, record.id);
                    if removed {state.revoice(record.position, output, &mut count)}
                }
                _ => {
                    if count < output.len() {
                        output[count] = *record;
                        count += 1;
                    }
                }
            }
        }
        state.write_broadcast();
        count
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ChordKeysState>() as u32
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    abi::render_midi_effect::<ChordKeys>(from, to, flags, state_ptr, out_ptr, max)
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ChordKeys as MidiEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ChordKeys as MidiEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => int_value(value, &ROOT_MAPPING) as f32,
        1 => int_value(value, &SCALE_MAPPING) as f32,
        2 | 3 => if bool_value(value) {1.0} else {0.0},
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut ChordKeysState| state.clear()) }
}

/// The host disabled or removed this effect: end every note it started.
#[no_mangle]
pub extern "C" fn release_all(state_ptr: u32, position: f64, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ChordKeysState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let written = state.release_all_into(position, out) as u32;
    state.write_broadcast();
    written
}

#[cfg(test)]
mod tests;

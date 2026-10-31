//! The Wclap MIDI-effect device: a CLAP note effect hosted through the `host_wclap_*` JS bridge. It pulls its
//! upstream per pulse range, hands the notes to the plugin at their sample offsets and returns the plugin's
//! notes at the pulse positions of their samples.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{Block, BlockFlags, EventRecord, FieldValue, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use dsp::ppqn::{pulses_to_samples, samples_to_pulses};
use wclap_common::WclapLink;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const SCRATCH: usize = 256; // WASM CONTRACT: the SDK's MIDI pull scratch, the bridge's MAX_PULLED_NOTES
const KEYS: usize = 128;
const BLANK: EventRecord = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};

pub struct WclapMidiState {
    link: WclapLink,
    sample_rate: f32,
    next_id: u32,
    sounding: [u32; KEYS], // the id of the note this device holds per key, 0 for none
    release_due: bool
}

/// The engine's `sample_offset`: the sample of `position` in `block`, clamped to the block.
fn sample_of(position: f64, block: &Block, sample_rate: f32) -> u32 {
    let pulses = position - block.p0;
    let raw = if pulses.abs() < 1.0e-7 {block.s0} else {block.s0 + pulses_to_samples(pulses, block.bpm, sample_rate) as u32};
    raw.clamp(block.s0, block.s1)
}

/// The pulse position of the middle of `sample`, so the consumer's `sample_of` lands on it, inside `[from, to)`.
fn position_of(sample: u32, block: &Block, sample_rate: f32, from: f64, to: f64) -> f64 {
    let position = block.p0 + samples_to_pulses((sample - block.s0) as f64 + 0.5, block.bpm, sample_rate);
    if position < from {from} else if position < to {position} else {from.max(to - (to - from) * 1.0e-6)}
}

impl WclapMidiState {
    fn init(&mut self, sample_rate: f32) {
        self.link.init();
        self.sample_rate = sample_rate;
        self.next_id = 1;
    }

    fn emit(out: &mut [EventRecord], count: &mut usize, record: EventRecord) {
        if *count < out.len() {
            out[*count] = record;
            *count += 1;
        }
    }

    fn note(&mut self, out: &mut [EventRecord], count: &mut usize, on: bool, pitch: u32, velocity: f32, position: f64) {
        let key = pitch as usize;
        if key >= KEYS {return}
        let held = self.sounding[key];
        if held != 0 {
            Self::emit(out, count, EventRecord {position, kind: EVENT_NOTE_OFF, id: held, pitch, velocity: 0.0, ..BLANK});
            self.sounding[key] = 0;
        }
        if !on {return}
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.sounding[key] = id;
        Self::emit(out, count, EventRecord {position, kind: EVENT_NOTE_ON, id, pitch, velocity, ..BLANK});
    }

    /// Every note this device started and did not end, ended at `position` (a plugin change, no plugin).
    fn release_all(&mut self, out: &mut [EventRecord], count: &mut usize, position: f64) {
        for key in 0..KEYS {
            if self.sounding[key] != 0 {self.note(out, count, false, key as u32, 0.0, position)}
        }
    }

    /// The pull template's fragmentation (`abi::render_midi_effect`): one plugin call per update sub-range, the
    /// parameters refreshed at each boundary.
    fn render(&mut self, from: f64, to: f64, flags: u32, out: &mut [EventRecord]) -> usize {
        let mut count = 0;
        if self.release_due {
            self.release_due = false;
            self.release_all(out, &mut count, from);
        }
        let mut sub_from = from;
        let mut boundary = abi::first_update_position(from);
        loop {
            let sub_to = if boundary < to {boundary} else {to};
            if sub_to > sub_from {count += self.render_range(sub_from, sub_to, flags, &mut out[count..]);}
            if sub_to >= to {break}
            abi::apply_param_changes(self, boundary, Self::parameter_changed);
            sub_from = sub_to;
            boundary = abi::next_update_position(boundary);
        }
        count
    }

    fn render_range(&mut self, from: f64, to: f64, flags: u32, out: &mut [EventRecord]) -> usize {
        let mut pulled = [BLANK; SCRATCH];
        let pulled_count = abi::pull_events(from, to, flags, &mut pulled);
        let mut count = 0;
        let Some((block, serial)) = abi::block_at(from) else {
            for record in &pulled[..pulled_count] {Self::emit(out, &mut count, *record)}
            return count;
        };
        let start = sample_of(from, &block, self.sample_rate);
        let end = if to >= block.p1 {block.s1} else {sample_of(to, &block, self.sample_rate)};
        let frames = end.saturating_sub(start);
        let mut notes = [BLANK; SCRATCH];
        let mut note_count = 0;
        for record in &pulled[..pulled_count] {
            if record.kind == EVENT_NOTE_ON || record.kind == EVENT_NOTE_OFF {
                let offset = sample_of(record.position, &block, self.sample_rate).saturating_sub(start);
                notes[note_count] = EventRecord {offset: offset.min(frames.saturating_sub(1)), ..*record};
                note_count += 1;
            } else {
                Self::emit(out, &mut count, *record);
            }
        }
        let mut produced = [BLANK; SCRATCH];
        match abi::wclap_process_notes(self.link.bridge, serial, &notes[..note_count], &mut produced, frames as usize,
                                       block.bpm, from, BlockFlags(flags)) {
            Some(produced_count) => {
                for record in &produced[..produced_count] {
                    let sample = start + record.offset.min(frames.saturating_sub(1));
                    let position = position_of(sample, &block, self.sample_rate, from, to);
                    self.note(out, &mut count, record.kind == EVENT_NOTE_ON, record.pitch, record.velocity, position);
                }
            }
            None => {
                self.release_all(out, &mut count, from);
                for record in &notes[..note_count] {Self::emit(out, &mut count, EventRecord {offset: 0, ..*record})}
            }
        }
        sort_by_position(&mut out[..count]);
        count
    }

    fn parameter_changed(state: &mut WclapMidiState, id: u32, value: ParamValue) {
        abi::wclap_param(state.link.bridge, id, value);
    }

    fn field_changed(&mut self, id: u32, value: FieldValue) {
        if self.link.reloads(id) {self.release_due = true}
        self.link.apply_field(id, value);
    }
}

// stable, the plugin's notes and the passed records keep their order at equal positions
fn sort_by_position(records: &mut [EventRecord]) {
    for index in 1..records.len() {
        let mut cursor = index;
        while cursor > 0 && records[cursor - 1].position > records[cursor].position {
            records.swap(cursor - 1, cursor);
            cursor -= 1;
        }
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<WclapMidiState>() as u32
}

/// WASM CONTRACT: `parameters` hub key 13, children bind `value` (4) and pass `clap-id` (3) as id.
#[no_mangle]
pub extern "C" fn observe_param_collection_field() -> u32 {
    13
}

/// WASM CONTRACT: `samples` hub key 16 (WclapSampleBox children, `index` 3 the plugin's key, `file` 4).
#[no_mangle]
pub extern "C" fn observe_sample_collection_field() -> u32 {
    16
}

/// A slot's sample, resolved by the engine: the bridge hands it to the plugin (`opendaw.samples/1`).
#[no_mangle]
pub extern "C" fn sample_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut WclapMidiState| abi::wclap_sample(state.link.bridge, id, handle, present != 0)) }
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut WclapMidiState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    state.render(from, to, flags, out) as u32
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state: &mut WclapMidiState| state.init(sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| WclapMidiState::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut WclapMidiState| state.field_changed(id, FieldValue::from_wire(kind, bits, len))) }
}

#[no_mangle]
pub extern "C" fn terminate(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state: &mut WclapMidiState| state.link.release()) }
}

#[cfg(test)]
mod tests {
    use super::{position_of, sample_of, sort_by_position, WclapMidiState, BLANK};
    use abi::{Block, BlockFlags, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};

    const RATE: f32 = 48_000.0;

    fn block() -> Block {
        Block {index: 0, flags: BlockFlags(0), p0: 1920.0, p1: 1920.0 + 128.0 * 960.0 * 2.0 / RATE as f64, s0: 0, s1: 128, bpm: 120.0}
    }

    #[test]
    fn a_sample_maps_to_a_position_that_maps_back_to_it() {
        let block = block();
        for sample in 0..128 {
            let position = position_of(sample, &block, RATE, block.p0, block.p1);
            assert!(position >= block.p0 && position < block.p1, "sample {sample} inside the range");
            assert_eq!(sample_of(position, &block, RATE), sample, "sample {sample} round trips");
        }
    }

    #[test]
    fn a_sample_before_the_range_start_stays_at_the_start() {
        let block = block();
        let from = block.p0 + 0.9 * 960.0 * 2.0 / RATE as f64;
        assert_eq!(position_of(0, &block, RATE, from, block.p1), from);
    }

    #[test]
    fn a_re_attacked_key_ends_its_first_note_and_every_held_note_can_be_released() {
        let mut state: WclapMidiState = unsafe { core::mem::zeroed() };
        state.next_id = 1;
        let mut out = [BLANK; 8];
        let mut count = 0;
        state.note(&mut out, &mut count, true, 60, 0.8, 10.0);
        state.note(&mut out, &mut count, true, 60, 0.5, 20.0);
        state.note(&mut out, &mut count, true, 64, 0.5, 20.0);
        state.release_all(&mut out, &mut count, 30.0);
        let kinds: Vec<(u32, u32, u32)> = out[..count].iter().map(|record| (record.kind, record.pitch, record.id)).collect();
        assert_eq!(kinds, vec![(EVENT_NOTE_ON, 60, 1), (EVENT_NOTE_OFF, 60, 1), (EVENT_NOTE_ON, 60, 2), (EVENT_NOTE_ON, 64, 3),
                               (EVENT_NOTE_OFF, 60, 2), (EVENT_NOTE_OFF, 64, 3)]);
        assert!(state.sounding.iter().all(|&id| id == 0));
    }

    #[test]
    fn an_off_for_a_key_that_does_not_sound_is_dropped() {
        let mut state: WclapMidiState = unsafe { core::mem::zeroed() };
        let mut out = [BLANK; 4];
        let mut count = 0;
        state.note(&mut out, &mut count, false, 60, 0.0, 10.0);
        assert_eq!(count, 0);
    }

    #[test]
    fn sorting_keeps_the_order_of_equal_positions() {
        let record = |position: f64, pitch: u32| EventRecord {position, pitch, ..BLANK};
        let mut records = [record(5.0, 1), record(2.0, 2), record(5.0, 3), record(2.0, 4)];
        sort_by_position(&mut records);
        assert_eq!(records.iter().map(|record| record.pitch).collect::<Vec<_>>(), vec![2, 4, 1, 3]);
    }
}

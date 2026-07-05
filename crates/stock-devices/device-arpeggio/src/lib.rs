//! The ARPEGGIATOR MIDI-effect device: a faithful port of the TS `ArpeggioDeviceProcessor` +
//! `ArpeggioDeviceBoxAdapter`. A stateful PULL SOURCE wired before an instrument (instrument <- arp <-
//! sequencer): the host calls `process_events(from, to, ...)` when the instrument pulls; the arp pulls its
//! OWN upstream, tracks the currently-active source notes (their pulse spans), and for every RATE-grid step
//! in the range picks one note from the active stack (per the Up/Down/UpDown mode + octave range) and emits a
//! note-on, scheduling the matching note-off `duration` pulses later. So a few held notes become a long
//! STREAM, and the active-note set + scheduled note-offs PERSIST across blocks that carry no new input.
//!
//! Parameters (`ArpeggioDeviceBox`): modeIndex `[10]` (0=Up/1=Down/2=UpDown), numOctaves `[11]` (1..5),
//! rateIndex `[12]` (into `RATE_FRACTIONS`), gate `[13]` (0..2, step length as a fraction of the rate),
//! repeat `[14]` (1..16, how many grid steps per arp step), velocity `[15]` (bipolar, a magnet toward 1.0).
//! Parameter automation is honored: the block is split at update boundaries (as `render_midi_effect` does).
//!
//! Timing is musical: `rate` is `Fraction.toPPQN(RATE_FRACTIONS[rateIndex])` in pulses, and steps land on the
//! absolute grid `index * rate` (mirroring `Fragmentor.iterateWithIndex`). On a transport jump (DISCONTINUOUS)
//! it releases everything it holds, mirroring the TS `releaseAll`.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `init(...)`, `parameter_changed(...)`, `process_events(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use math::value_mapping::{Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

// WASM CONTRACT: mirrors `PPQN` (Quarter = 960, Bar = 3840) and `Fraction.toPPQN` = floor(Bar / d) * n.
const BAR: i64 = 3840;

// WASM CONTRACT: mirrors `ArpeggioDeviceBoxAdapter.RateFractions.asDescendingArray()` (already authored in
// descending order, so the array index == the rateIndex parameter value). `(n, d)` -> `rate_ppqn`.
const RATE_FRACTIONS: [(i64, i64); 17] = [
    (1, 1), (1, 2), (1, 3), (1, 4), (3, 16), (1, 6), (1, 8), (3, 32), (1, 12),
    (1, 16), (3, 64), (1, 24), (1, 32), (1, 48), (1, 64), (1, 96), (1, 128)
];

fn rate_ppqn(index: i32) -> f64 {
    let clamped = if index < 0 { 0 } else if index as usize >= RATE_FRACTIONS.len() { RATE_FRACTIONS.len() - 1 } else { index as usize };
    let (numerator, denominator) = RATE_FRACTIONS[clamped];
    ((BAR / denominator) * numerator) as f64
}

const MODE_FIELD: [u16; 1] = [10];
const OCTAVES_FIELD: [u16; 1] = [11];
const RATE_FIELD: [u16; 1] = [12];
const GATE_FIELD: [u16; 1] = [13];
const REPEAT_FIELD: [u16; 1] = [14];
const VELOCITY_FIELD: [u16; 1] = [15];

const MODE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
const OCTAVES_MAPPING: LinearInteger = LinearInteger {min: 1, max: 5};
const RATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: (RATE_FRACTIONS.len() - 1) as i32};
const GATE_MAPPING: Linear = Linear {min: 0.0, max: 2.0};
const REPEAT_MAPPING: LinearInteger = LinearInteger {min: 1, max: 16};
const VELOCITY_MAPPING: Linear = Linear::bipolar();

const MAX_SOURCE: usize = 32; // simultaneously active source notes (chord + overlap) tracked by their span
const MAX_RETAINED: usize = 64; // emitted notes awaiting their scheduled note-off
const EMIT_MAX: usize = 128; // events emitted in one block (note-offs + note-ons)
const PULL_SCRATCH: usize = 256; // on-stack buffer the upstream pull writes into

#[derive(Clone, Copy)]
struct SourceNote {
    start: f64,
    end: f64,
    pitch: u32,
    velocity: f32
}

#[derive(Clone, Copy)]
struct Retained {
    id: u32,
    pitch: u32,
    complete: f64
}

/// The arp's per-instance state (engine-allocated). Runtime state: the active source-note spans, the emitted
/// notes awaiting their note-off, and an id generator. Parameter values + their bound ids are seeded in `init`
/// to the box defaults (NOT the zeroed block, since a zero octave / repeat would divide by zero before the
/// engine pushes the real values).
pub struct ArpState {
    source: [SourceNote; MAX_SOURCE],
    retained: [Retained; MAX_RETAINED],
    source_count: u32,
    retained_count: u32,
    next_id: u32,
    mode: i32,
    octaves: i32,
    rate: f64,
    gate: f32,
    repeat: i32,
    velocity_mult: f32,
    velocity_add: f32,
    mode_id: u32,
    octaves_id: u32,
    rate_id: u32,
    gate_id: u32,
    repeat_id: u32,
    velocity_id: u32
}

/// Set the velocity magnet (mirrors the TS `parameterChanged` velocity branch): at `v <= 0` fade the note's
/// own velocity out toward the constant `1 + v`; at `v > 0` blend the note velocity toward 1.0 by `v`.
fn set_velocity_matrix(state: &mut ArpState, value: f32) {
    if value <= 0.0 {
        state.velocity_add = 1.0 + value;
        state.velocity_mult = 0.0;
    } else {
        state.velocity_add = 1.0 - value;
        state.velocity_mult = value;
    }
}

fn apply_velocity(state: &ArpState, velocity: f32) -> f32 {
    velocity * state.velocity_mult + state.velocity_add
}

/// One arp step: pick a pitch + octave from the sorted active-note `stack` for the global `step_index`, per the
/// mode. Mirrors `ArpeggioModes` (up / down / up-down) exactly. `stack` is (pitch, velocity), pre-sorted by
/// (start, pitch). Returns (pitch, velocity).
fn mode_run(state: &ArpState, stack: &[(u32, f32)], step_index: i64) -> (u32, f32) {
    let count = stack.len() as i64;
    let octaves = if state.octaves < 1 { 1 } else { state.octaves as i64 };
    let (local_index, octave) = match state.mode {
        1 => {
            // down
            let amount = count * octaves;
            let local = (count - 1) - step_index % count;
            let octave = (octaves - 1) - (step_index % amount) / count;
            (local, octave)
        }
        2 => {
            // up-down
            let process_length = count * octaves;
            let sequence_length = if process_length * 2 - 2 < 1 { 1 } else { process_length * 2 - 2 };
            let sequence_index = step_index % sequence_length;
            let process_index = if sequence_index < process_length { sequence_index } else { sequence_length - sequence_index };
            (process_index % count, process_index / count)
        }
        _ => {
            // up (default)
            let amount = count * octaves;
            (step_index % count, (step_index % amount) / count)
        }
    };
    let (pitch, velocity) = stack[local_index as usize];
    ((pitch as i64 + octave * 12) as u32, apply_velocity(state, velocity))
}

/// Drop active source notes whose span has ended at/before `from` (they can no longer overlap any grid step in
/// this or a later block).
fn prune_source(state: &mut ArpState, from: f64) {
    let mut index = 0;
    while index < state.source_count as usize {
        if state.source[index].end <= from {
            state.source[index] = state.source[state.source_count as usize - 1];
            state.source_count -= 1;
        } else {
            index += 1;
        }
    }
}

/// Fold one block's pulled input into the active-note set: a note-on adds a span (its `duration` carried on the
/// note-on, so the arp knows when it ends); a note-off shortens the matching id's span to its release position.
fn ingest(state: &mut ArpState, input: &[EventRecord]) {
    for record in input {
        if record.kind == EVENT_NOTE_ON {
            if (state.source_count as usize) < MAX_SOURCE && record.duration > 0.0 {
                state.source[state.source_count as usize] = SourceNote {
                    start: record.position, end: record.position + record.duration, pitch: record.pitch, velocity: record.velocity
                };
                state.source_count += 1;
            }
        } else if record.kind == EVENT_NOTE_OFF {
            let mut index = 0;
            while index < state.source_count as usize {
                if state.source[index].pitch == record.pitch && record.position < state.source[index].end {
                    state.source[index].end = record.position;
                }
                index += 1;
            }
        }
    }
}

fn lifecycle_rank(record: &EventRecord) -> u8 {
    if record.kind == EVENT_NOTE_OFF { 0 } else { 1 }
}

/// Smallest grid index `i` with `i * rate >= from` (the first `Fragmentor` step in the range). `from >= 0`.
fn first_index(from: f64, rate: f64) -> i64 {
    let index = (from / rate) as i64;
    if (index as f64) * rate < from { index + 1 } else { index }
}

fn emit(events: &mut [EventRecord], count: &mut usize, record: EventRecord) {
    if *count < events.len() {
        events[*count] = record;
        *count += 1;
    }
}

fn note_off(id: u32, pitch: u32, position: f64) -> EventRecord {
    EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id, pitch, velocity: 0.0, cent: 0.0, duration: 0.0}
}

/// Release every retained note whose scheduled end is `< to` (mirrors `EventSpanRetainer.releaseLinearCompleted`),
/// emitting a note-off at that end. Order does not matter (the output is sorted before it is returned).
fn release_completed(state: &mut ArpState, to: f64, events: &mut [EventRecord], count: &mut usize) {
    let mut index = 0;
    while index < state.retained_count as usize {
        let retained = state.retained[index];
        if retained.complete < to {
            emit(events, count, note_off(retained.id, retained.pitch, retained.complete));
            state.retained[index] = state.retained[state.retained_count as usize - 1];
            state.retained_count -= 1;
        } else {
            index += 1;
        }
    }
}

/// Produce one block's events for `[from, to)`. Sequence mirrors `ArpeggioDeviceProcessor.processNotes`: release
/// due note-offs (all of them on a DISCONTINUOUS jump), ingest the upstream, walk the rate grid emitting a
/// note-on per step through the active-note stack, then release the note-offs that come due within the block.
/// Returns the count of position-sorted events written (note-off before note-on at an equal position).
pub fn process(state: &mut ArpState, from: f64, to: f64, flags: u32, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut events = [blank; EMIT_MAX];
    let mut count = 0;
    let discontinuous = flags & abi::BlockFlags::DISCONTINUOUS != 0;
    let transporting = flags & abi::BlockFlags::TRANSPORTING != 0;
    if discontinuous {
        let mut index = 0;
        while index < state.retained_count as usize {
            let retained = state.retained[index];
            emit(&mut events, &mut count, note_off(retained.id, retained.pitch, from));
            index += 1;
        }
        state.retained_count = 0;
        state.source_count = 0;
    } else {
        release_completed(state, to, &mut events, &mut count);
    }
    prune_source(state, from);
    ingest(state, input);
    // onlyExternal (= !transporting) yields no sequenced notes in the TS source, so the arp emits nothing while
    // the transport is not moving.
    if transporting && state.rate > 0.0 && state.source_count > 0 {
        let repeat = if state.repeat < 1 { 1 } else { state.repeat as i64 };
        let step_len = state.rate * state.gate.max(0.0) as f64;
        let duration = if step_len < 1.0 { 1.0 } else { (step_len as i64) as f64 };
        let mut index = first_index(from, state.rate);
        let mut position = index as f64 * state.rate;
        while position < to {
            let mut stack = [(0u32, 0.0f32); MAX_SOURCE];
            let mut stack_key = [(0.0f64, 0u32); MAX_SOURCE]; // (start, pitch) sort key
            let mut stack_len = 0;
            let mut source_index = 0;
            while source_index < state.source_count as usize {
                let note = state.source[source_index];
                if note.start <= position && position < note.end {
                    stack[stack_len] = (note.pitch, note.velocity);
                    stack_key[stack_len] = (note.start, note.pitch);
                    stack_len += 1;
                }
                source_index += 1;
            }
            if stack_len > 0 {
                // Insertion-sort by (start position, pitch) to match the TS sequencer's `NoteEvent.Comparator`.
                let mut outer = 1;
                while outer < stack_len {
                    let value = stack[outer];
                    let key = stack_key[outer];
                    let mut inner = outer;
                    while inner > 0 && (stack_key[inner - 1].0 > key.0
                        || (stack_key[inner - 1].0 == key.0 && stack_key[inner - 1].1 > key.1)) {
                        stack[inner] = stack[inner - 1];
                        stack_key[inner] = stack_key[inner - 1];
                        inner -= 1;
                    }
                    stack[inner] = value;
                    stack_key[inner] = key;
                    outer += 1;
                }
                let step_index = index / repeat;
                let (pitch, velocity) = mode_run(state, &stack[..stack_len], step_index);
                if (state.retained_count as usize) < MAX_RETAINED {
                    let id = state.next_id;
                    state.next_id = state.next_id.wrapping_add(1);
                    emit(&mut events, &mut count, EventRecord {
                        position, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity, cent: 0.0, duration
                    });
                    state.retained[state.retained_count as usize] = Retained {id, pitch, complete: position + duration};
                    state.retained_count += 1;
                }
            }
            index += 1;
            position = index as f64 * state.rate;
        }
    }
    release_completed(state, to, &mut events, &mut count);
    events[..count].sort_unstable_by(|left, right| {
        left.position.partial_cmp(&right.position).unwrap_or(core::cmp::Ordering::Equal).then(lifecycle_rank(left).cmp(&lifecycle_rank(right)))
    });
    let written = count.min(out.len());
    out[..written].copy_from_slice(&events[..written]);
    written
}

/// What the host wires this device as (read at load): a MIDI effect (a pull source in the event chain).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ArpState>() as u32
}

/// Seed a (zeroed) state with the box parameter defaults and bind each parameter. Kept separate from the
/// `init` export so tests can seed a state directly (the export takes a `u32` pointer, which truncates on a
/// 64-bit native test build). Mirrors the `ArpeggioDeviceBox` field defaults (1/16, up, 1 octave, gate 1).
pub fn seed(state: &mut ArpState) {
    state.mode = 0;
    state.octaves = 1;
    state.rate = rate_ppqn(9);
    state.gate = 1.0;
    state.repeat = 1;
    set_velocity_matrix(state, 0.0);
    state.mode_id = abi::bind_parameter(&MODE_FIELD);
    state.octaves_id = abi::bind_parameter(&OCTAVES_FIELD);
    state.rate_id = abi::bind_parameter(&RATE_FIELD);
    state.gate_id = abi::bind_parameter(&GATE_FIELD);
    state.repeat_id = abi::bind_parameter(&REPEAT_FIELD);
    state.velocity_id = abi::bind_parameter(&VELOCITY_FIELD);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, _sample_rate: f32) {
    seed(unsafe { &mut *(state_ptr as *mut ArpState) });
}

fn apply_parameter(state: &mut ArpState, id: u32, value: ParamValue) {
    if id == state.mode_id {
        state.mode = abi::int_value(value, &MODE_MAPPING);
    } else if id == state.octaves_id {
        state.octaves = abi::int_value(value, &OCTAVES_MAPPING);
    } else if id == state.rate_id {
        state.rate = rate_ppqn(abi::int_value(value, &RATE_MAPPING));
    } else if id == state.gate_id {
        state.gate = abi::float_value(value, &GATE_MAPPING);
    } else if id == state.repeat_id {
        state.repeat = abi::int_value(value, &REPEAT_MAPPING);
    } else if id == state.velocity_id {
        set_velocity_matrix(state, abi::float_value(value, &VELOCITY_MAPPING));
    }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    apply_parameter(state, id, ParamValue::from_wire(kind, value));
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    // Split the range at parameter-update boundaries (as `render_midi_effect` does) so automated rate / mode /
    // octaves / gate / repeat / velocity take effect at the right pulse. The source is pulled per sub-range.
    let mut written = 0usize;
    let mut sub_from = from;
    let mut boundary = abi::first_update_position(from);
    loop {
        let sub_to = if boundary < to { boundary } else { to };
        let mut scratch = [blank; PULL_SCRATCH];
        let pulled = abi::pull_events(sub_from, sub_to, flags, &mut scratch);
        written += process(state, sub_from, sub_to, flags, &scratch[..pulled], &mut out[written..]);
        if sub_to >= to {
            break;
        }
        abi::apply_param_changes::<ArpState>(state, boundary, apply_parameter);
        sub_from = sub_to;
        boundary = abi::next_update_position(boundary);
    }
    written as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ArpState {
        let mut state: ArpState = unsafe { core::mem::zeroed() };
        state.mode = 0;
        state.octaves = 1;
        state.rate = rate_ppqn(9); // 1/16 = 240
        state.gate = 1.0;
        state.repeat = 1;
        set_velocity_matrix(&mut state, 0.0);
        state
    }

    fn note_on(position: f64, duration: f64, pitch: u32, velocity: f32) -> EventRecord {
        EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id: 1, pitch, velocity, cent: 0.0, duration}
    }

    fn on_count(out: &[EventRecord]) -> usize {
        out.iter().filter(|event| event.kind == EVENT_NOTE_ON).count()
    }

    #[test]
    fn rate_index_maps_to_ppqn() {
        assert_eq!(rate_ppqn(0), 3840.0); // 1/1
        assert_eq!(rate_ppqn(2), 1280.0); // 1/3
        assert_eq!(rate_ppqn(3), 960.0);  // 1/4
        assert_eq!(rate_ppqn(9), 240.0);  // 1/16
        assert_eq!(rate_ppqn(16), 30.0);  // 1/128
    }

    #[test]
    fn one_held_note_steps_on_the_rate_grid() {
        // rate = 1/3 = 1280 pulses; a note held [0, 4000) -> steps at 0, 1280, 2560, 3840.
        let mut state = state();
        state.rate = rate_ppqn(2);
        let input = [note_on(0.0, 4000.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let flags = abi::BlockFlags::TRANSPORTING;
        let written = process(&mut state, 0.0, 4000.0, flags, &input, &mut out);
        assert_eq!(on_count(&out[..written]), 4, "four 1/3 grid steps in [0,4000)");
        for event in out[..written].iter().filter(|event| event.kind == EVENT_NOTE_ON) {
            assert_eq!(event.pitch, 60);
            assert!((event.velocity - 1.0).abs() < 1e-6, "default velocity magnet outputs 1.0");
        }
        let positions = [0.0, 1280.0, 2560.0, 3840.0];
        let mut seen = out[..written].iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.position);
        for expected in positions {
            assert_eq!(seen.next().unwrap(), expected);
        }
    }

    #[test]
    fn rate_changes_the_step_count() {
        // 1/16 (240) over one bar (3840) = 16 steps, vs 4 at 1/3 — the exact rate bug the port fixes.
        let mut fast = state();
        fast.rate = rate_ppqn(9);
        let input = [note_on(0.0, 3840.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 128];
        let written = process(&mut fast, 0.0, 3840.0, abi::BlockFlags::TRANSPORTING, &input, &mut out);
        assert_eq!(on_count(&out[..written]), 16, "1/16 grid over one bar = 16 steps");
    }

    #[test]
    fn up_mode_cycles_two_note_chord() {
        // Chord C4(60) + G4(67), rate 1/4 (960), one octave, up mode -> 60,67,60,67...
        let mut state = state();
        state.rate = rate_ppqn(3);
        let input = [note_on(0.0, 4000.0, 67, 0.8), note_on(0.0, 4000.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let written = process(&mut state, 0.0, 4000.0, abi::BlockFlags::TRANSPORTING, &input, &mut out);
        let pitches = [60, 67, 60, 67];
        let mut ons = out[..written].iter().filter(|event| event.kind == EVENT_NOTE_ON);
        for expected in pitches {
            assert_eq!(ons.next().unwrap().pitch, expected, "up mode sorts the chord ascending and cycles");
        }
    }

    #[test]
    fn up_mode_two_octaves_raises_by_twelve() {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.octaves = 2;
        let input = [note_on(0.0, 4000.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let written = process(&mut state, 0.0, 4000.0, abi::BlockFlags::TRANSPORTING, &input, &mut out);
        let pitches = [60, 72, 60, 72];
        let mut ons = out[..written].iter().filter(|event| event.kind == EVENT_NOTE_ON);
        for expected in pitches {
            assert_eq!(ons.next().unwrap().pitch, expected);
        }
    }

    #[test]
    fn each_step_schedules_a_note_off_at_its_end() {
        // rate 1/4 (960), gate 0.5 -> step length 480; a step at 0 completes at 480 within the block.
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.gate = 0.5;
        let input = [note_on(0.0, 4000.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let written = process(&mut state, 0.0, 4000.0, abi::BlockFlags::TRANSPORTING, &input, &mut out);
        let offs = out[..written].iter().filter(|event| event.kind == EVENT_NOTE_OFF).count();
        assert!(offs >= 3, "short-gate steps release within the block");
        let first_off = out[..written].iter().find(|event| event.kind == EVENT_NOTE_OFF).unwrap();
        assert_eq!(first_off.position, 480.0, "note-off at position + rate*gate");
    }

    #[test]
    fn discontinuous_releases_all_held_notes() {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.gate = 2.0; // long gate so notes stay retained across the block
        let input = [note_on(0.0, 8000.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        process(&mut state, 0.0, 1000.0, abi::BlockFlags::TRANSPORTING, &input, &mut out);
        assert!(state.retained_count > 0, "notes are retained");
        let empty: [EventRecord; 0] = [];
        let written = process(&mut state, 1000.0, 1100.0, abi::BlockFlags::TRANSPORTING | abi::BlockFlags::DISCONTINUOUS, &empty, &mut out);
        assert_eq!(state.retained_count, 0, "releaseAll drained the retainer");
        assert!(out[..written].iter().all(|event| event.kind == EVENT_NOTE_OFF));
        assert!(out[..written].iter().all(|event| event.position == 1000.0), "released at `from`");
    }

    #[test]
    fn not_transporting_emits_nothing() {
        let mut state = state();
        let input = [note_on(0.0, 4000.0, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let written = process(&mut state, 0.0, 4000.0, 0, &input, &mut out);
        assert_eq!(written, 0, "no output while the transport is not moving");
    }
}

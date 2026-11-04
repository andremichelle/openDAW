//! FROZEN copy of the Arpeggio as it shipped before the enhancement (git 0b371e0b3, `src/lib.rs`). It is the
//! reference model of the golden tests: the enhanced device with its new fields at their defaults must produce
//! exactly these events. Never edit the arithmetic here.

use abi::{BlockFlags, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};

const BAR: i64 = 3840;
const RATE_FRACTIONS: [(i64, i64); 17] = [
    (1, 1), (1, 2), (1, 3), (1, 4), (3, 16), (1, 6), (1, 8), (3, 32), (1, 12),
    (1, 16), (3, 64), (1, 24), (1, 32), (1, 48), (1, 64), (1, 96), (1, 128)
];
const MAX_SOURCE: usize = 32;
const MAX_RETAINED: usize = 64;
const EMIT_MAX: usize = 128;

pub fn rate_ppqn(index: i32) -> f64 {
    let clamped = if index < 0 { 0 } else if index as usize >= RATE_FRACTIONS.len() { RATE_FRACTIONS.len() - 1 } else { index as usize };
    let (numerator, denominator) = RATE_FRACTIONS[clamped];
    ((BAR / denominator) * numerator) as f64
}

#[derive(Clone, Copy)]
struct SourceNote {start: f64, end: f64, pitch: u32, velocity: f32}

#[derive(Clone, Copy)]
struct Retained {id: u32, pitch: u32, complete: f64}

pub struct LegacyState {
    source: [SourceNote; MAX_SOURCE],
    retained: [Retained; MAX_RETAINED],
    source_count: u32,
    retained_count: u32,
    next_id: u32,
    pub mode: i32,
    pub octaves: i32,
    pub rate: f64,
    pub gate: f32,
    pub repeat: i32,
    velocity_mult: f32,
    velocity_add: f32
}

impl LegacyState {
    pub fn new(mode: i32, octaves: i32, rate_index: i32, gate: f32, repeat: i32, velocity: f32) -> Self {
        let blank_source = SourceNote {start: 0.0, end: 0.0, pitch: 0, velocity: 0.0};
        let blank_retained = Retained {id: 0, pitch: 0, complete: 0.0};
        let mut state = LegacyState {
            source: [blank_source; MAX_SOURCE], retained: [blank_retained; MAX_RETAINED],
            source_count: 0, retained_count: 0, next_id: 0,
            mode, octaves, rate: rate_ppqn(rate_index), gate, repeat, velocity_mult: 0.0, velocity_add: 0.0
        };
        state.set_velocity(velocity);
        state
    }

    pub fn set_velocity(&mut self, value: f32) {
        if value <= 0.0 {
            self.velocity_add = 1.0 + value;
            self.velocity_mult = 0.0;
        } else {
            self.velocity_add = 1.0 - value;
            self.velocity_mult = value;
        }
    }

    pub fn set_rate_index(&mut self, index: i32) {
        self.rate = rate_ppqn(index);
    }
}

fn apply_velocity(state: &LegacyState, velocity: f32) -> f32 {
    velocity * state.velocity_mult + state.velocity_add
}

fn mode_run(state: &LegacyState, stack: &[(u32, f32)], step_index: i64) -> (u32, f32) {
    let count = stack.len() as i64;
    let octaves = if state.octaves < 1 { 1 } else { state.octaves as i64 };
    let (local_index, octave) = match state.mode {
        1 => {
            let amount = count * octaves;
            let local = (count - 1) - step_index % count;
            let octave = (octaves - 1) - (step_index % amount) / count;
            (local, octave)
        }
        2 => {
            let process_length = count * octaves;
            let sequence_length = if process_length * 2 - 2 < 1 { 1 } else { process_length * 2 - 2 };
            let sequence_index = step_index % sequence_length;
            let process_index = if sequence_index < process_length { sequence_index } else { sequence_length - sequence_index };
            (process_index % count, process_index / count)
        }
        _ => {
            let amount = count * octaves;
            (step_index % count, (step_index % amount) / count)
        }
    };
    let (pitch, velocity) = stack[local_index as usize];
    ((pitch as i64 + octave * 12) as u32, apply_velocity(state, velocity))
}

fn prune_source(state: &mut LegacyState, from: f64) {
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

fn ingest(state: &mut LegacyState, input: &[EventRecord]) {
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
    if record.kind == EVENT_NOTE_OFF { 1 } else { 0 }
}

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

fn release_completed(state: &mut LegacyState, to: f64, events: &mut [EventRecord], count: &mut usize) {
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

pub fn release_all_into(state: &mut LegacyState, position: f64, out: &mut [EventRecord]) -> usize {
    let written = (state.retained_count as usize).min(out.len());
    for index in 0..written {
        let retained = state.retained[index];
        out[index] = note_off(retained.id, retained.pitch, position);
    }
    state.retained_count = 0;
    state.source_count = 0;
    written
}

pub fn process(state: &mut LegacyState, from: f64, to: f64, flags: u32, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut events = [blank; EMIT_MAX];
    let mut count = 0;
    let discontinuous = flags & BlockFlags::DISCONTINUOUS != 0;
    if discontinuous {
        count = release_all_into(state, from, &mut events);
    } else {
        release_completed(state, to, &mut events, &mut count);
    }
    prune_source(state, from);
    ingest(state, input);
    if state.rate > 0.0 && state.source_count > 0 {
        let repeat = if state.repeat < 1 { 1 } else { state.repeat as i64 };
        let step_len = state.rate * state.gate.max(0.0) as f64;
        let duration = if step_len < 1.0 { 1.0 } else { (step_len as i64) as f64 };
        let mut index = first_index(from, state.rate);
        let mut position = index as f64 * state.rate;
        while position < to {
            let mut stack = [(0u32, 0.0f32); MAX_SOURCE];
            let mut stack_key = [(0.0f64, 0u32); MAX_SOURCE];
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

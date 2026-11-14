//! The Euclid MIDI effect: every lane plays its note on a Euclidean rhythm of the active pattern.

#![cfg_attr(target_family = "wasm", no_std)]

pub mod rhythm;

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, GrooveFollower, ParamValue, Table, TableColumn, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use math::value_mapping::LinearInteger;
use rhythm::{Step, MAX_STEPS};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const PATTERN_FIELD: [u16; 1] = [10];
const LENGTH_FIELD: [u16; 1] = [11];
const RATE_FIELD: [u16; 1] = [12];
const LANES_HUB: [u16; 1] = [14];
const PATTERNS_KEY: u16 = 20;
const GROOVE_KEY: u16 = 1;
// WASM CONTRACT: the active and the waiting pattern for the editor (EuclidDeviceBoxAdapter.state)
const STATE: [u16; 1] = [0xFFF];
const PATTERNS: usize = 8;
pub const OFF: i32 = -1;
const NONE: i32 = -2;
pub const MAX_LANES: usize = 127;
const MAX_RETAINED: usize = 512;
const MAX_CANDIDATES: usize = 512;
const QUARTER: f64 = 960.0;
const SIXTEENTH: f64 = 240.0;
// generated notes take ids from the upper half, so they never meet the ids of the notes passing through
const OWN_IDS: u32 = 0x8000_0000;
const PATTERN_MAPPING: LinearInteger = LinearInteger {min: OFF, max: PATTERNS as i32 - 1};
const LENGTH_MAPPING: LinearInteger = LinearInteger {min: 0, max: 128};
const RATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 4};
const GLOBAL_RATES: [f64; 5] = [0.25, 0.5, 1.0, 2.0, 4.0];

// the lane box: index, note, velocity, chance, gate, mute, solo, then ten rhythm values per pattern from key 10
const LANE_VALUES: usize = 7;
const RHYTHM_VALUES: usize = 10;
pub const COLUMNS: usize = LANE_VALUES + PATTERNS * RHYTHM_VALUES;
const fn lane_columns() -> [TableColumn; COLUMNS] {
    let mut columns = [TableColumn::value(0); COLUMNS];
    let mut index = 0;
    while index < LANE_VALUES {
        columns[index] = TableColumn::value(2 + index as u16);
        index += 1;
    }
    while index < COLUMNS {
        columns[index] = TableColumn::value(10 + (index - LANE_VALUES) as u16);
        index += 1;
    }
    columns
}
const LANE_COLUMNS: [TableColumn; COLUMNS] = lane_columns();

/// A note value in quarter notes: 1/4, 1/8, 1/16 and 1/32, each straight, triplet and dotted.
pub fn note_value(index: i32) -> f64 {
    let index = index.clamp(0, 11);
    let straight = 1.0 / (1 << (index / 3)) as f64;
    match index % 3 {
        1 => straight * 2.0 / 3.0,
        2 => straight * 1.5,
        _ => straight
    }
}

#[derive(Clone, Copy, Default)]
pub struct Lane {
    order: i32,
    note: u32,
    velocity: f32,
    chance: f32,
    gate: i32,
    mute: bool,
    solo: bool,
    rate: i32,
    repeats: i32,
    fade: f32,
    length: usize,
    steps: [Step; MAX_STEPS]
}

#[derive(Clone, Copy, Default)]
struct Retained {
    id: u32,
    pitch: u32,
    end: f64
}

#[derive(Clone, Copy, Default)]
struct Candidate {
    position: f64,
    pitch: u32,
    velocity: f32,
    duration: f64
}

pub struct EuclidState {
    pattern_id: u32,
    length_id: u32,
    rate_id: u32,
    lanes_id: u32,
    state_id: u32,
    requested: i32,
    active: i32,
    length: i32,
    rate: i32,
    table: Table,
    dirty: bool,
    lanes: [Lane; MAX_LANES],
    lane_count: usize,
    grooves: [GrooveFollower; PATTERNS],
    retained: [Retained; MAX_RETAINED],
    retained_count: usize,
    next_id: u32,
    transporting: bool,
    // a state built while the transport runs takes the stored pattern at once
    started: bool
}

fn blank() -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn emit(events: &mut [EventRecord], count: &mut usize, event: EventRecord) -> bool {
    if *count >= events.len() {return false;}
    events[*count] = event;
    *count += 1;
    true
}

// a stable 0..1 value per lane note and grid step, so a chance plays the same notes on every render
fn unit_hash(note: u32, step: i64) -> f32 {
    let mut value = (step as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (note as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    value ^= value >> 33;
    value = value.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    value ^= value >> 33;
    (value >> 40) as f32 / (1u64 << 24) as f32
}

impl EuclidState {
    /// The lanes from the table, in list order, with the steps of the active pattern.
    pub fn compose(&mut self) {
        self.dirty = false;
        let pattern = self.active.clamp(0, PATTERNS as i32 - 1) as usize;
        let rows = self.table.rows().min(MAX_LANES);
        for row in 0..rows {
            let value = |column: usize| self.table.int(row, column);
            let rhythm = LANE_VALUES + pattern * RHYTHM_VALUES;
            let (steps, length) = rhythm::steps(value(rhythm), value(rhythm + 1), value(rhythm + 2), value(rhythm + 4),
                value(rhythm + 5), value(rhythm + 6), value(rhythm + 7));
            self.lanes[row] = Lane {
                order: value(0), note: value(1).clamp(0, 127) as u32, velocity: self.table.float(row, 2),
                chance: self.table.float(row, 3), gate: value(4), mute: self.table.bool(row, 5), solo: self.table.bool(row, 6),
                rate: value(rhythm + 3), repeats: value(rhythm + 8).clamp(2, 8), fade: self.table.float(row, rhythm + 9),
                length, steps
            };
        }
        self.lane_count = rows;
        self.lanes[..rows].sort_unstable_by_key(|lane| lane.order);
    }

    // a note-off that finds no room stays retained and goes out with the next block
    fn release_completed(&mut self, from: f64, to: f64, events: &mut [EventRecord], count: &mut usize) {
        let mut index = 0;
        while index < self.retained_count {
            let note = self.retained[index];
            let off = EventRecord {position: note.end.max(from), kind: EVENT_NOTE_OFF, id: note.id, pitch: note.pitch, ..blank()};
            if note.end < to && emit(events, count, off) {
                self.retained[index] = self.retained[self.retained_count - 1];
                self.retained_count -= 1;
            } else {
                index += 1;
            }
        }
    }

    fn release_all(&mut self, position: f64, events: &mut [EventRecord], count: &mut usize) {
        for note in &mut self.retained[..self.retained_count] {note.end = note.end.min(position);}
        self.release_completed(position, f64::INFINITY, events, count);
    }

    fn start(&mut self, candidate: &Candidate, events: &mut [EventRecord], count: &mut usize) {
        if self.retained_count >= MAX_RETAINED {return;}
        let id = OWN_IDS | self.next_id;
        self.next_id = (self.next_id + 1) & !OWN_IDS;
        let Candidate {position, pitch, velocity, duration} = *candidate;
        if emit(events, count, EventRecord {position, kind: EVENT_NOTE_ON, id, pitch, velocity, duration, ..blank()}) {
            self.retained[self.retained_count] = Retained {id, pitch, end: position + duration};
            self.retained_count += 1;
        }
    }

    // the straight distance from a hit at step `index` to the lane's next hit, at most to the end of the period
    fn distance_to_next(lane: &Lane, index: i64, left: f64, step: f64) -> f64 {
        for ahead in 1..=lane.length as i64 {
            if ahead as f64 * step >= left {return left;}
            if lane.steps[((index + ahead) % lane.length as i64) as usize].hit {return ahead as f64 * step;}
        }
        (lane.length as f64 * step).min(left)
    }

    /// The hits of every audible lane whose triggers fall into the straight range `[s0, s1)` of `pattern`.
    fn collect(&self, pattern: usize, s0: f64, s1: f64, candidates: &mut [Candidate; MAX_CANDIDATES], total: &mut usize) {
        let factor = GLOBAL_RATES[self.rate.clamp(0, 4) as usize];
        let period = if self.length > 0 {self.length as f64 * SIXTEENTH / factor} else {f64::INFINITY};
        let any_solo = self.lanes[..self.lane_count].iter().any(|lane| lane.solo);
        let groove = &self.grooves[pattern];
        for lane in &self.lanes[..self.lane_count] {
            if lane.mute || (any_solo && !lane.solo) {continue;}
            let step = note_value(lane.rate) * QUARTER / factor;
            let first_period = if period.is_finite() {libm::floor((s0 - step) / period) * period} else {0.0};
            let mut period_start = first_period.max(0.0);
            while period_start < s1 {
                let period_end = period_start + period;
                let first = (libm::ceil((s0 - step - period_start) / step) as i64).max(0);
                let mut index = first;
                loop {
                    let start = period_start + index as f64 * step;
                    if start >= s1 || start >= period_end {break;}
                    let slot = (index % lane.length as i64) as usize;
                    let this = lane.steps[slot];
                    if this.hit && (lane.chance >= 1.0 || unit_hash(lane.note, libm::round(start / step) as i64) < lane.chance) {
                        let triggers = if this.burst {lane.repeats} else {1};
                        let spacing = step / triggers as f64;
                        let base = if this.accent {1.0} else {lane.velocity};
                        for trigger in 0..triggers {
                            let at = start + trigger as f64 * spacing;
                            if at < s0 || at >= s1 || at >= period_end {continue;}
                            let level = if triggers < 2 {1.0} else {
                                let along = if lane.fade < 0.0 {triggers - 1 - trigger} else {trigger};
                                1.0 - lane.fade.abs() * along as f32 / (triggers - 1) as f32
                            };
                            let velocity = base * level;
                            if velocity <= 0.0 {continue;}
                            let last = trigger == triggers - 1;
                            let length = if lane.gate == 1 && last {
                                Self::distance_to_next(lane, index, period_end - start, step) - trigger as f64 * spacing
                            } else {spacing};
                            let length = length.min(period_end - at);
                            let on = groove.warp(at);
                            let duration = (groove.warp(at + length) - on).max(1.0);
                            if *total < MAX_CANDIDATES {
                                candidates[*total] = Candidate {position: on, pitch: lane.note, velocity, duration};
                                *total += 1;
                            }
                        }
                    }
                    index += 1;
                }
                if !period.is_finite() {break;}
                period_start = period_end;
            }
        }
    }

    // the lanes' hits in `[from, to)` of the active pattern, one note-on per moment and note, the louder one
    fn generate(&mut self, from: f64, to: f64, discontinuous: bool, events: &mut [EventRecord], count: &mut usize) {
        if self.active == OFF {return;}
        let pattern = self.active as usize;
        let (s0, s1) = self.grooves[pattern].straight(from, to, discontinuous);
        if self.lane_count == 0 || s1 <= s0 {return;}
        let mut candidates = [Candidate::default(); MAX_CANDIDATES];
        let mut total = 0;
        self.collect(pattern, s0, s1, &mut candidates, &mut total);
        let candidates = &mut candidates[..total];
        candidates.sort_unstable_by(|left, right| left.position.partial_cmp(&right.position)
            .unwrap_or(core::cmp::Ordering::Equal).then(left.pitch.cmp(&right.pitch))
            .then(right.velocity.partial_cmp(&left.velocity).unwrap_or(core::cmp::Ordering::Equal)));
        for index in 0..total {
            let candidate = candidates[index];
            if index > 0 && candidates[index - 1].position == candidate.position && candidates[index - 1].pitch == candidate.pitch {continue;}
            if candidate.position < from || candidate.position >= to {continue;}
            self.start(&candidate, events, count);
        }
    }

    /// One block: pass the input through, play the lanes, switch the pattern on the next bar, end due notes.
    pub fn process(&mut self, from: f64, to: f64, flags: u32, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
        let mut buffer = [blank(); 256];
        let events = &mut buffer[..out.len().min(256)];
        let mut count = 0;
        for event in input {emit(events, &mut count, *event);}
        let transporting = flags & abi::BlockFlags::TRANSPORTING != 0;
        let discontinuous = flags & abi::BlockFlags::DISCONTINUOUS != 0;
        if discontinuous || (self.transporting && !transporting) {self.release_all(from, events, &mut count);}
        self.release_completed(from, to, events, &mut count);
        if !transporting || discontinuous || !self.started {
            self.started = true;
            if self.active != self.requested {
                self.active = self.requested;
                self.dirty = true;
            }
        }
        self.transporting = transporting;
        if self.dirty {self.compose();}
        if transporting {
            for (pattern, groove) in self.grooves.iter_mut().enumerate() {
                if pattern as i32 != self.active {groove.straight(from, to, discontinuous);}
            }
            let mut at = from;
            let mut first = discontinuous;
            if self.active != self.requested {
                let bar = abi::bar_at(from);
                let boundary = if bar.start >= from {bar.start} else {bar.start + bar.length};
                if boundary < to {
                    self.generate(at, boundary, first, events, &mut count);
                    self.release_completed(at, boundary, events, &mut count);
                    self.active = self.requested;
                    self.compose();
                    at = boundary;
                    first = false;
                }
            }
            self.generate(at, to, first, events, &mut count);
        }
        self.release_completed(from, to, events, &mut count);
        let rank = |event: &EventRecord| if event.kind == EVENT_NOTE_OFF {0} else {1};
        events[..count].sort_unstable_by(|left, right| left.position.partial_cmp(&right.position)
            .unwrap_or(core::cmp::Ordering::Equal).then(rank(left).cmp(&rank(right))));
        out[..count].copy_from_slice(&events[..count]);
        let shown = abi::broadcast_ptr(self.state_id);
        if shown != 0 {
            let shown = unsafe { core::slice::from_raw_parts_mut(shown as *mut i32, 2) };
            shown[0] = self.active;
            shown[1] = if self.active != self.requested {self.requested} else {NONE};
        }
        count
    }

    pub fn apply_parameter(&mut self, id: u32, value: ParamValue) {
        if id == self.pattern_id {
            self.requested = abi::int_value(value, &PATTERN_MAPPING);
        } else if id == self.length_id {
            self.length = abi::int_value(value, &LENGTH_MAPPING);
        } else if id == self.rate_id {
            self.rate = abi::int_value(value, &RATE_MAPPING);
        }
    }

    /// The lanes as table words (native tests deliver them through here).
    pub fn set_table(&mut self, table: Table) {
        self.table = table;
        self.dirty = true;
    }
}

/// Seed a zeroed state with the box defaults and bind the parameters, the lanes and the broadcast.
pub fn seed(state: &mut EuclidState) {
    state.requested = 0;
    state.active = 0;
    state.started = false;
    state.length = 0;
    state.rate = 2;
    state.table = Table::empty();
    state.dirty = true;
    state.pattern_id = abi::bind_parameter(&PATTERN_FIELD);
    state.length_id = abi::bind_parameter(&LENGTH_FIELD);
    state.rate_id = abi::bind_parameter(&RATE_FIELD);
    state.lanes_id = abi::observe_table(&LANES_HUB, &LANE_COLUMNS);
    state.state_id = abi::bind_broadcast_int_array(&STATE, 2);
    for pattern in 0..PATTERNS {
        state.grooves[pattern] = GrooveFollower::observe(&[PATTERNS_KEY, pattern as u16, GROOVE_KEY]);
    }
}

#[no_mangle]
pub extern "C" fn kind() -> u32 {abi::DEVICE_KIND_MIDI_EFFECT}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {core::mem::size_of::<EuclidState>() as u32}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, _sample_rate: f32) {
    seed(unsafe { &mut *(state_ptr as *mut EuclidState) });
}

#[no_mangle]
pub extern "C" fn table_changed(state_ptr: u32, id: u32, ptr: u32, rows: u32, columns: u32) {
    let state = unsafe { &mut *(state_ptr as *mut EuclidState) };
    if id == state.lanes_id {state.set_table(unsafe { Table::from_wire(ptr, rows, columns) });}
}

fn apply_parameter(state: &mut EuclidState, id: u32, value: ParamValue) {state.apply_parameter(id, value)}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    let state = unsafe { &mut *(state_ptr as *mut EuclidState) };
    state.apply_parameter(id, ParamValue::from_wire(kind, value, modulation));
}

/// Parity probe: the real value stored for a unit automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => abi::int_value(value, &PATTERN_MAPPING) as f32,
        1 => abi::int_value(value, &LENGTH_MAPPING) as f32,
        2 => abi::int_value(value, &RATE_MAPPING) as f32,
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut EuclidState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    abi::render_sub_ranges(state, from, to, flags, out, abi::first_update_position(from),
        &mut |sub_from, sub_to, flags, scratch| abi::pull_events(sub_from, sub_to, flags, scratch),
        &mut |state, boundary| {
            abi::apply_param_changes::<EuclidState>(state, boundary, apply_parameter);
            abi::next_update_position(boundary)
        },
        &mut |state, sub_from, sub_to, flags, input, output| state.process(sub_from, sub_to, flags, input, output)) as u32
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    let state = unsafe { &mut *(state_ptr as *mut EuclidState) };
    state.retained_count = 0;
}

/// The host disabled or removed this effect: end every note it started.
#[no_mangle]
pub extern "C" fn release_all(state_ptr: u32, position: f64, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut EuclidState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let mut count = 0;
    state.release_all(position, out, &mut count);
    count as u32
}

#[cfg(test)]
mod tests;

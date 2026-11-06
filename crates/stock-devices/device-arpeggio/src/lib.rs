//! The ARPEGGIATOR MIDI-effect device: a faithful port of the TS `ArpeggioDeviceProcessor` +
//! `ArpeggioDeviceBoxAdapter`. A stateful PULL SOURCE wired before an instrument (instrument <- arp <-
//! sequencer): the host calls `process_events(from, to, ...)` when the instrument pulls; the arp pulls its
//! OWN upstream, tracks the currently-active source notes (their pulse spans), and for every RATE-grid step
//! in the range picks one note from the active stack (per the Up/Down/UpDown mode + octave range) and emits a
//! note-on, scheduling the matching note-off `duration` pulses later. So a few held notes become a long
//! STREAM, and the active-note set + scheduled note-offs PERSIST across blocks that carry no new input.
//!
//! Parameters (`ArpeggioDeviceBox`): modeIndex `[10]` (the 18 walks, 0..2 = the legacy Up/Down/UpDown),
//! numOctaves `[11]` (1..5), rateIndex `[12]` (into `RATE_FRACTIONS`), gate `[13]` (0..2, step length as a
//! fraction of the rate), repeat `[14]` (1..16, grid steps per walk step), velocity `[15]` (bipolar magnet),
//! order `[16]` (played / pitch), hold `[17]`, retrigger `[18]` (off / note / bar / beat), offset `[19]`,
//! followChords `[21]` (while transporting, a chord on the project's chord track replaces the held notes).
//! Plain fields: seed `[20]`, the 64-step lanes `[30..36]` and the pattern length `[37]`. With the new fields at
//! their defaults the device emits exactly what the legacy device emitted (`tests/golden.rs`).
//! Parameter automation is honored: the block is split at update boundaries (as `render_midi_effect` does).
//!
//! Timing is musical: `rate` is `Fraction.toPPQN(RATE_FRACTIONS[rateIndex])` in pulses, and steps land on the
//! absolute grid `index * rate` (mirroring `Fragmentor.iterateWithIndex`). On a transport jump (DISCONTINUOUS)
//! it releases everything it holds, mirroring the TS `releaseAll`.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `init(...)`, `parameter_changed(...)`, `field_changed(...)`,
//! `process_events(...)`, `release_all(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{Bar, EventRecord, FieldValue, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use math::value_mapping::{Linear, LinearInteger};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
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
const ORDER_FIELD: [u16; 1] = [16];
const HOLD_FIELD: [u16; 1] = [17];
const RETRIGGER_FIELD: [u16; 1] = [18];
const OFFSET_FIELD: [u16; 1] = [19];
const SEED_FIELD: [u16; 1] = [20];
const FOLLOW_CHORDS_FIELD: [u16; 1] = [21];
// WASM CONTRACT: mirrors the `ArpeggioDeviceBox` lane arrays (int32 x STEP_COUNT each) and `pattern-length`.
const LANE_FIELDS: [u16; LANE_COUNT] = [30, 31, 32, 33, 34, 35, 36];
const LENGTH_FIELD: [u16; 1] = [37];

pub const MODE_COUNT: i32 = 18;
const MODE_MAPPING: LinearInteger = LinearInteger {min: 0, max: MODE_COUNT - 1};
const OCTAVES_MAPPING: LinearInteger = LinearInteger {min: 1, max: 5};
const RATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: (RATE_FRACTIONS.len() - 1) as i32};
const GATE_MAPPING: Linear = Linear {min: 0.0, max: 2.0};
const REPEAT_MAPPING: LinearInteger = LinearInteger {min: 1, max: 16};
const VELOCITY_MAPPING: Linear = Linear::bipolar();
const ORDER_MAPPING: LinearInteger = LinearInteger {min: 0, max: 1};
const RETRIGGER_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const OFFSET_MAPPING: LinearInteger = LinearInteger {min: 0, max: 15};

pub const ORDER_PLAYED: i32 = 0;
pub const ORDER_PITCH: i32 = 1;
pub const RETRIGGER_OFF: i32 = 0;
pub const RETRIGGER_NOTE: i32 = 1;
pub const RETRIGGER_BAR: i32 = 2;
pub const RETRIGGER_BEAT: i32 = 3;

pub const STEP_COUNT: usize = 64;
pub const STEP_NOTE: u8 = 0;
pub const STEP_REST: u8 = 1;
pub const STEP_TIE: u8 = 2;
pub const STEP_CHORD: u8 = 3;
const MAX_RATCHET: i32 = 7;

/// The step lanes, in field order `[30..36]`. Percent lanes are stored as int32 percent in the box.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Lane {Kind, Velocity, Gate, Transpose, Octave, Chance, Ratchet}
pub const LANE_COUNT: usize = 7;
const LANES: [Lane; LANE_COUNT] = [Lane::Kind, Lane::Velocity, Lane::Gate, Lane::Transpose, Lane::Octave, Lane::Chance, Lane::Ratchet];

const MAX_SOURCE: usize = 32; // simultaneously active source notes (chord + overlap) tracked by their span
const MAX_RETAINED: usize = MAX_SOURCE * 8; // emitted notes awaiting their scheduled note-off (chords + ratchets)
const MAX_PENDING: usize = MAX_SOURCE * MAX_RATCHET as usize; // ratchet hits due in a later block
const EMIT_MAX: usize = 256; // events emitted in one block (note-offs + note-ons), the host's per-quantum capacity
const MAX_POOL: usize = MAX_SOURCE * 5; // notes x octaves
const CHORD_BASE_PITCH: u32 = 60; // the octave chord notes play in when no key is held
const CHORD_VELOCITY: f32 = 0.8;

#[derive(Clone, Copy)]
struct SourceNote {
    start: f64,
    end: f64,
    pitch: u32,
    velocity: f32,
    cent: f32
}

#[derive(Clone, Copy)]
struct Retained {
    id: u32,
    pitch: u32,
    complete: f64
}

#[derive(Clone, Copy)]
struct PoolNote {
    start: f64,
    pitch: u32,
    velocity: f32,
    cent: f32
}

#[derive(Clone, Copy)]
struct Pending {
    position: f64,
    pitch: u32,
    velocity: f32,
    cent: f32,
    duration: f64
}

/// Per-instance state, seeded to the box defaults in `init` (a zeroed octave or repeat would divide by zero).
pub struct ArpState {
    source: [SourceNote; MAX_SOURCE],
    retained: [Retained; MAX_RETAINED],
    latch: [PoolNote; MAX_SOURCE],
    pending: [Pending; MAX_PENDING],
    source_count: u32,
    retained_count: u32,
    latch_count: u32,
    pending_count: u32,
    latch_released: bool,
    latch_fresh: bool,
    pool_empty: bool,
    transporting: bool,
    phase_start: i64,
    playing_slot: i32,
    next_id: u32,
    mode: i32,
    octaves: i32,
    rate: f64,
    gate: f32,
    repeat: i32,
    velocity_mult: f32,
    velocity_add: f32,
    order: i32,
    hold: bool,
    retrigger: i32,
    offset: i32,
    follow_chords: bool,
    seed: u32,
    length: usize,
    kinds: [u8; STEP_COUNT],
    velocities: [f32; STEP_COUNT],
    gates: [f32; STEP_COUNT],
    transposes: [i32; STEP_COUNT],
    octave_shifts: [i32; STEP_COUNT],
    chances: [f32; STEP_COUNT],
    ratchets: [i32; STEP_COUNT],
    mode_id: u32,
    octaves_id: u32,
    rate_id: u32,
    gate_id: u32,
    repeat_id: u32,
    velocity_id: u32,
    order_id: u32,
    hold_id: u32,
    retrigger_id: u32,
    offset_id: u32,
    follow_chords_id: u32,
    seed_id: u32,
    lane_ids: [u32; LANE_COUNT],
    length_id: u32,
    step_broadcast: u32
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

const SALT_RANDOM: u32 = 1;
const SALT_OTHER: u32 = 2;
const SALT_CHANCE: u32 = 3;
const SALT_WALK: u32 = 4;
const SALT_SHUFFLE: u32 = 100;

/// Deterministic hash of (seed, step, salt): random decisions never depend on the playback history.
pub fn hash(seed: u32, step: i64, salt: u32) -> u32 {
    let mut value = (seed as u64).wrapping_mul(0xD6E8_FEB8_6659_FD93)
        ^ (step as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (salt as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    value ^= value >> 30;
    value = value.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^= value >> 31;
    (value >> 32) as u32
}

/// `hash` as a unit value in [0, 1).
pub fn unit_hash(seed: u32, step: i64, salt: u32) -> f32 {
    (hash(seed, step, salt) >> 8) as f32 / 16_777_216.0
}

fn up_down(step: i64, count: i64) -> i64 {
    if count < 2 {
        return 0;
    }
    let cycle = count * 2 - 2;
    let index = step.rem_euclid(cycle);
    if index < count { index } else { cycle - index }
}

fn up_and_down(step: i64, count: i64) -> i64 {
    let index = step.rem_euclid(count * 2);
    if index < count { index } else { count * 2 - 1 - index }
}

fn converge(index: i64, count: i64) -> i64 {
    if index % 2 == 0 { index / 2 } else { count - 1 - (index - 1) / 2 }
}

fn permuted(seed: u32, salt: i64, count: i64, index: i64) -> i64 {
    let mut order = [0u16; MAX_POOL];
    let count = (count as usize).min(MAX_POOL);
    for slot in 0..count {
        order[slot] = slot as u16;
    }
    for slot in (1..count).rev() {
        let other = hash(seed, salt, SALT_SHUFFLE + slot as u32) as usize % (slot + 1);
        order.swap(slot, other);
    }
    order[index as usize % count] as i64
}

const WALK_BLOCK: i64 = 8;
const WALK_MOVES: [i64; WALK_BLOCK as usize] = [1, 1, 1, 1, 0, 0, -1, -1]; // sums to 2 per block

/// 17 Walk: every block of 8 steps plays the moves above in a seeded order.
fn walk(seed: u32, step: i64, count: i64) -> i64 {
    let block = step.div_euclid(WALK_BLOCK);
    let mut moves = WALK_MOVES;
    for slot in (1..moves.len()).rev() {
        let other = hash(seed, block, SALT_WALK + slot as u32) as usize % (slot + 1);
        moves.swap(slot, other);
    }
    let within: i64 = moves[..step.rem_euclid(WALK_BLOCK) as usize].iter().sum();
    (block * 2 + within).rem_euclid(count)
}

/// 14 Random Other: odd steps avoid both random even neighbours.
fn random_other(seed: u32, step: i64, count: i64) -> i64 {
    let random = |at: i64| hash(seed, at, SALT_OTHER) as i64;
    if count == 2 {
        return (random(0) + step).rem_euclid(2);
    }
    if step.rem_euclid(2) == 0 {
        return random(step) % count;
    }
    let (left, right) = (random(step - 1) % count, random(step + 1) % count);
    let (low, high) = if left < right { (left, right) } else { (right, left) };
    let excluded = if low == high { 1 } else { 2 };
    let mut value = random(step) % (count - excluded);
    if value >= low {
        value += 1;
    }
    if excluded == 2 && value >= high {
        value += 1;
    }
    value
}

/// The index into the expanded pool (notes x octaves) for `step`. Modes 0..2 are the legacy arithmetic.
pub fn walk_index(state: &ArpState, step: i64, count: i64) -> i64 {
    if count < 2 {
        return 0;
    }
    let seed = state.seed;
    let index = step.rem_euclid(count);
    match state.mode {
        1 => count - 1 - index,
        2 => up_down(step, count),
        3 => count - 1 - up_down(step, count),
        4 => up_and_down(step, count),
        5 => count - 1 - up_and_down(step, count),
        6 => converge(index, count),
        7 => converge(count - 1 - index, count),
        8 => {
            if count < 3 {
                return converge(index, count);
            }
            let cycle = count * 2 - 2;
            let phase = step.rem_euclid(cycle);
            if phase < count { converge(phase, count) } else { converge(cycle - phase, count) }
        }
        9 => {
            let phase = step.rem_euclid((count - 1) * 2);
            if phase % 2 == 0 { phase / 2 } else { count - 1 }
        }
        10 => if step.rem_euclid(2) == 1 { count - 1 } else { up_down(step.div_euclid(2), count - 1) },
        11 => {
            let phase = step.rem_euclid((count - 1) * 2);
            if phase % 2 == 0 { 0 } else { 1 + (phase - 1) / 2 }
        }
        12 => if step.rem_euclid(2) == 0 { 0 } else { 1 + up_down(step.div_euclid(2), count - 1) },
        13 => hash(seed, step, SALT_RANDOM) as i64 % count,
        14 => random_other(seed, step, count),
        15 => permuted(seed, step.div_euclid(count), count, index),
        16 => permuted(seed, -1, count, index),
        17 => walk(seed, step, count),
        _ => index
    }
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

/// A press while no key is down starts a new latch, any other press joins it.
fn latch(state: &mut ArpState, note: PoolNote, alone: bool) {
    if alone {
        state.latch[0] = note;
        state.latch_count = 1;
        state.latch_released = false;
        state.latch_fresh = true;
    } else if (state.latch_count as usize) < MAX_SOURCE
        && !state.latch[..state.latch_count as usize].iter().any(|entry| entry.pitch == note.pitch) {
        state.latch[state.latch_count as usize] = note;
        state.latch_count += 1;
    }
}

/// Folds the input up to `until` into the source spans and returns the count consumed.
fn ingest(state: &mut ArpState, input: &[EventRecord], until: f64) -> usize {
    let mut consumed = 0;
    for record in input {
        if record.position > until {
            break;
        }
        consumed += 1;
        if record.kind == EVENT_NOTE_ON {
            if (state.source_count as usize) < MAX_SOURCE && record.duration > 0.0 {
                let position = record.position;
                let alone = !state.source[..state.source_count as usize].iter()
                    .any(|note| note.start <= position && position < note.end);
                state.source[state.source_count as usize] = SourceNote {
                    start: position, end: position + record.duration, pitch: record.pitch,
                    velocity: record.velocity, cent: record.cent
                };
                state.source_count += 1;
                if state.hold {
                    latch(state, PoolNote {start: position, pitch: record.pitch, velocity: record.velocity, cent: record.cent}, alone);
                }
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
    consumed
}

// TS `ArpeggioDeviceProcessor.processNotes` yields the step note-ONs (the Fragmentor loop) BEFORE the
// note-OFFs completing at the same pulse (`releaseLinearCompleted` runs after), and the stable TS event
// pipeline preserves that order. ON-before-OFF at an equal position is what keeps a MONO synth legato
// across abutting steps: the held stack still contains the previous note when the new one starts, so the
// voice glides instead of retriggering. OFF-first emptied the stack first and forced a retrigger per step.
fn lifecycle_rank(record: &EventRecord) -> u8 {
    if record.kind == EVENT_NOTE_OFF { 1 } else { 0 }
}

/// Smallest grid index `i` with `i * rate >= from` (the first `Fragmentor` step in the range). `from >= 0`.
fn first_index(from: f64, rate: f64) -> i64 {
    let index = (from / rate) as i64;
    if (index as f64) * rate < from { index + 1 } else { index }
}

fn emit(events: &mut [EventRecord], count: &mut usize, record: EventRecord) -> bool {
    if *count < events.len() {
        events[*count] = record;
        *count += 1;
        true
    } else {
        false
    }
}

fn note_off(id: u32, pitch: u32, position: f64) -> EventRecord {
    EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id, pitch, velocity: 0.0, cent: 0.0, duration: 0.0}
}

/// Release every retained note whose scheduled end is `< to` (mirrors `EventSpanRetainer.releaseLinearCompleted`),
/// emitting a note-off at that end. A note-off without room stays retained and goes out with a later block.
fn release_completed(state: &mut ArpState, to: f64, events: &mut [EventRecord], count: &mut usize) {
    let mut index = 0;
    while index < state.retained_count as usize {
        let retained = state.retained[index];
        if retained.complete < to && emit(events, count, note_off(retained.id, retained.pitch, retained.complete)) {
            state.retained[index] = state.retained[state.retained_count as usize - 1];
            state.retained_count -= 1;
        } else {
            index += 1;
        }
    }
}

/// End every emitted note at `position` and forget the source notes (TS `releaseAll`), returning the count written.
/// Notes that do not fit into `out` are released at the start of the next block.
pub fn release_all_into(state: &mut ArpState, position: f64, out: &mut [EventRecord]) -> usize {
    let written = (state.retained_count as usize).min(out.len());
    for index in 0..written {
        let retained = state.retained[index];
        out[index] = note_off(retained.id, retained.pitch, position);
    }
    let remaining = state.retained_count as usize - written;
    state.retained.copy_within(written..written + remaining, 0);
    state.retained[..remaining].iter_mut().for_each(|retained| retained.complete = position);
    state.retained_count = remaining as u32;
    state.source_count = 0;
    state.latch_count = 0;
    state.latch_released = true;
    state.pending_count = 0;
    state.pool_empty = true;
    written
}

/// The pool for a step at `position`: the covering source notes, or with Hold the latched notes (a press after
/// all keys were up replaces the latch, presses while keys are down add to it). Ordered per `order`.
fn collect_pool(state: &mut ArpState, position: f64, pool: &mut [PoolNote; MAX_SOURCE]) -> usize {
    if state.follow_chords && state.transporting {
        if let Some((root, bits)) = abi::harmony_at(position).chord {
            return collect_chord(state, position, root, bits, pool);
        }
    }
    let mut count = 0;
    for index in 0..state.source_count as usize {
        let note = state.source[index];
        if note.start <= position && position < note.end {
            pool[count] = PoolNote {start: note.start, pitch: note.pitch, velocity: note.velocity, cent: note.cent};
            count += 1;
        }
    }
    if state.hold {
        if count > 0 {
            if state.latch_released {
                state.latch[..count].copy_from_slice(&pool[..count]);
                state.latch_count = count as u32;
                state.latch_released = false;
                state.latch_fresh = true;
            } else {
                for index in 0..count {
                    let note = pool[index];
                    let latched = &state.latch[..state.latch_count as usize];
                    if !latched.iter().any(|entry| entry.pitch == note.pitch) && (state.latch_count as usize) < MAX_SOURCE {
                        state.latch[state.latch_count as usize] = note;
                        state.latch_count += 1;
                    }
                }
            }
        } else {
            state.latch_released = true;
        }
        count = state.latch_count as usize;
        pool[..count].copy_from_slice(&state.latch[..count]);
    }
    let by_pitch = state.order == ORDER_PITCH;
    let before = |left: &PoolNote, right: &PoolNote| if by_pitch {
        left.pitch < right.pitch || (left.pitch == right.pitch && left.start < right.start)
    } else {
        left.start < right.start || (left.start == right.start && left.pitch < right.pitch)
    };
    for outer in 1..count {
        let value = pool[outer];
        let mut inner = outer;
        while inner > 0 && before(&value, &pool[inner - 1]) {
            pool[inner] = pool[inner - 1];
            inner -= 1;
        }
        pool[inner] = value;
    }
    count
}

/// The chord's notes ascending, in the octave of the lowest held key (or `CHORD_BASE_PITCH` without one).
fn collect_chord(state: &ArpState, position: f64, root: i32, bits: i32, pool: &mut [PoolNote; MAX_SOURCE]) -> usize {
    let mut base = CHORD_BASE_PITCH;
    let mut velocity = CHORD_VELOCITY;
    let mut held = false;
    for note in state.source[..state.source_count as usize].iter().filter(|note| note.start <= position && position < note.end) {
        let octave = note.pitch / 12 * 12;
        base = if held {base.min(octave)} else {octave};
        velocity = if held {velocity.max(note.velocity)} else {note.velocity};
        held = true;
    }
    let mut count = 0;
    for interval in 0..31 {
        if bits & (1 << interval) != 0 && count < MAX_SOURCE {
            pool[count] = PoolNote {start: position, pitch: base + (root + interval) as u32, velocity, cent: 0.0};
            count += 1;
        }
    }
    count
}

/// The bar holding a position on the project's signature track (`abi::bar_at`, replaceable in tests).
pub type BarAt = fn(f64) -> Bar;

fn effective_index(state: &ArpState, index: i64, position: f64, bar_at: BarAt) -> i64 {
    match state.retrigger {
        RETRIGGER_NOTE => index - state.phase_start,
        RETRIGGER_BAR => ((position - bar_at(position).start) as i64 as f64 / state.rate) as i64,
        RETRIGGER_BEAT => {
            let bar = bar_at(position);
            let beat = bar.beat as i64;
            if beat < 1 {
                return index;
            }
            (((position - bar.start) as i64).rem_euclid(beat) as f64 / state.rate) as i64
        }
        _ => index
    }
}

fn start_note(state: &mut ArpState, position: f64, pitch: u32, velocity: f32, cent: f32, duration: f64,
              events: &mut [EventRecord], count: &mut usize) {
    if (state.retained_count as usize) < MAX_RETAINED {
        let id = state.next_id;
        if emit(events, count, EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity, cent, duration}) {
            state.next_id = state.next_id.wrapping_add(1);
            state.retained[state.retained_count as usize] = Retained {id, pitch, complete: position + duration};
            state.retained_count += 1;
        }
    }
}

/// Emit (or defer to a later block) every ratchet hit of one note of a step.
fn play(state: &mut ArpState, position: f64, to: f64, pitch: u32, velocity: f32, cent: f32, step_gate: f32, ratchets: i32,
        ties: i64, events: &mut [EventRecord], count: &mut usize) {
    let slice = state.rate / ratchets as f64;
    let length = slice * state.gate.max(0.0) as f64 * step_gate as f64;
    let base = if length < 1.0 { 1.0 } else { (length as i64) as f64 };
    for hit in 0..ratchets {
        let at = position + hit as f64 * slice;
        let duration = if hit == ratchets - 1 { base + ties as f64 * state.rate } else { base };
        if at < to {
            start_note(state, at, pitch, velocity, cent, duration, events, count);
        } else if (state.pending_count as usize) < MAX_PENDING {
            state.pending[state.pending_count as usize] = Pending {position: at, pitch, velocity, cent, duration};
            state.pending_count += 1;
        }
    }
}

fn emit_pending(state: &mut ArpState, to: f64, events: &mut [EventRecord], count: &mut usize) {
    let mut index = 0;
    while index < state.pending_count as usize {
        let hit = state.pending[index];
        if hit.position < to {
            start_note(state, hit.position, hit.pitch, hit.velocity, hit.cent, hit.duration, events, count);
            state.pending[index] = state.pending[state.pending_count as usize - 1];
            state.pending_count -= 1;
        } else {
            index += 1;
        }
    }
}

// Pitches above 127 pass unchanged, as the legacy device emitted them (golden test).
fn note_pitch(pitch: i64) -> Option<u32> {
    if pitch < 0 { None } else { Some(pitch as u32) }
}

/// One grid step at `position` (grid `index`): pool, step lanes, walk, emit.
fn step(state: &mut ArpState, index: i64, position: f64, to: f64, events: &mut [EventRecord], count: &mut usize, bar_at: BarAt) {
    let mut pool = [PoolNote {start: 0.0, pitch: 0, velocity: 0.0, cent: 0.0}; MAX_SOURCE];
    let size = collect_pool(state, position, &mut pool);
    if size == 0 {
        state.pool_empty = true;
        return;
    }
    if state.pool_empty || state.latch_fresh {
        state.phase_start = index;
    }
    state.pool_empty = false;
    state.latch_fresh = false;
    let effective = effective_index(state, index, position, bar_at);
    let length = state.length.clamp(1, STEP_COUNT) as i64;
    let slot = effective.rem_euclid(length) as usize;
    state.playing_slot = slot as i32;
    let kind = state.kinds[slot];
    if kind == STEP_REST || kind == STEP_TIE {
        return;
    }
    let chance = state.chances[slot];
    if chance < 1.0 && unit_hash(state.seed, effective, SALT_CHANCE) >= chance {
        return;
    }
    let mut ties = 0i64;
    while ties < length - 1 {
        let ahead = ties + 1;
        let next = effective_index(state, index + ahead, position + ahead as f64 * state.rate, bar_at).rem_euclid(length);
        if state.kinds[next as usize] != STEP_TIE {
            break;
        }
        ties = ahead;
    }
    let shift = state.transposes[slot] as i64 + 12 * state.octave_shifts[slot] as i64;
    let step_velocity = state.velocities[slot];
    let ratchets = state.ratchets[slot].clamp(1, MAX_RATCHET);
    let step_gate = state.gates[slot];
    if kind == STEP_CHORD {
        for note in &pool[..size] {
            if let Some(pitch) = note_pitch(note.pitch as i64 + shift) {
                let velocity = apply_velocity(state, note.velocity) * step_velocity;
                play(state, position, to, pitch, velocity, note.cent, step_gate, ratchets, ties, events, count);
            }
        }
        return;
    }
    let octaves = if state.octaves < 1 { 1 } else { state.octaves as i64 };
    let walk_step = effective / (if state.repeat < 1 { 1 } else { state.repeat as i64 }) + state.offset as i64;
    let picked = walk_index(state, walk_step, size as i64 * octaves);
    let note = pool[(picked % size as i64) as usize];
    if let Some(pitch) = note_pitch(note.pitch as i64 + (picked / size as i64) * 12 + shift) {
        let velocity = apply_velocity(state, note.velocity) * step_velocity;
        play(state, position, to, pitch, velocity, note.cent, step_gate, ratchets, ties, events, count);
    }
}

/// Produce one block's events for `[from, to)`. Sequence mirrors `ArpeggioDeviceProcessor.processNotes`: release
/// due note-offs (all of them on a DISCONTINUOUS jump), ingest the upstream, walk the rate grid emitting a
/// note-on per step through the active-note stack, then release the note-offs that come due within the block.
/// Returns the count of position-sorted events written (note-ON before note-off at an equal position,
/// mirroring the TS yield order — see `lifecycle_rank`).
pub fn process(state: &mut ArpState, from: f64, to: f64, flags: u32, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
    process_in(state, from, to, flags, input, out, abi::bar_at)
}

/// `process` with the signature lookup passed in.
pub fn process_in(state: &mut ArpState, from: f64, to: f64, flags: u32, input: &[EventRecord], out: &mut [EventRecord],
                  bar_at: BarAt) -> usize {
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut buffer = [blank; EMIT_MAX];
    let events = &mut buffer[..out.len().min(EMIT_MAX)];
    let mut count = 0;
    let transporting = flags & abi::BlockFlags::TRANSPORTING != 0;
    if transporting != state.transporting {
        state.transporting = transporting;
        state.latch_count = 0;
        state.latch_released = true;
    }
    let discontinuous = flags & abi::BlockFlags::DISCONTINUOUS != 0;
    if discontinuous {
        count = release_all_into(state, from, events);
    } else {
        release_completed(state, to, events, &mut count);
    }
    prune_source(state, from);
    emit_pending(state, to, events, &mut count);
    let mut consumed = 0;
    // TS `onlyExternal = !transporting`: a stopped transport arpeggiates the LIVE notes. The sequencer hands over
    // live notes only while stopped (it releases the sequenced ones), so the source holds exactly those.
    if state.rate > 0.0 {
        let mut index = first_index(from, state.rate);
        let mut position = index as f64 * state.rate;
        while position < to {
            consumed += ingest(state, &input[consumed..], position);
            step(state, index, position, to, events, &mut count, bar_at);
            index += 1;
            position = index as f64 * state.rate;
        }
    }
    ingest(state, &input[consumed..], f64::INFINITY);
    let slot = abi::broadcast_ptr(state.step_broadcast);
    if slot != 0 {
        unsafe { *(slot as *mut i32) = if state.pool_empty { -1 } else { state.playing_slot }; }
    }
    release_completed(state, to, events, &mut count);
    events[..count].sort_unstable_by(|left, right| {
        left.position.partial_cmp(&right.position).unwrap_or(core::cmp::Ordering::Equal).then(lifecycle_rank(left).cmp(&lifecycle_rank(right)))
    });
    out[..count].copy_from_slice(&events[..count]);
    count
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
/// 64-bit native test build). Mirrors the `ArpeggioDeviceBox` field defaults (1/16, up, 1 octave, gate 1,
/// played order, 16 neutral note steps).
pub fn seed(state: &mut ArpState) {
    state.mode = 0;
    state.octaves = 1;
    state.rate = rate_ppqn(9);
    state.gate = 1.0;
    state.repeat = 1;
    set_velocity_matrix(state, 0.0);
    state.order = ORDER_PLAYED;
    state.hold = false;
    state.retrigger = RETRIGGER_OFF;
    state.offset = 0;
    state.follow_chords = false;
    state.seed = 0;
    state.length = 16;
    state.kinds = [STEP_NOTE; STEP_COUNT];
    state.velocities = [1.0; STEP_COUNT];
    state.gates = [1.0; STEP_COUNT];
    state.transposes = [0; STEP_COUNT];
    state.octave_shifts = [0; STEP_COUNT];
    state.chances = [1.0; STEP_COUNT];
    state.ratchets = [1; STEP_COUNT];
    state.latch_released = true;
    state.pool_empty = true;
    state.playing_slot = -1;
    state.mode_id = abi::bind_parameter(&MODE_FIELD);
    state.octaves_id = abi::bind_parameter(&OCTAVES_FIELD);
    state.rate_id = abi::bind_parameter(&RATE_FIELD);
    state.gate_id = abi::bind_parameter(&GATE_FIELD);
    state.repeat_id = abi::bind_parameter(&REPEAT_FIELD);
    state.velocity_id = abi::bind_parameter(&VELOCITY_FIELD);
    state.order_id = abi::bind_parameter(&ORDER_FIELD);
    state.hold_id = abi::bind_parameter(&HOLD_FIELD);
    state.retrigger_id = abi::bind_parameter(&RETRIGGER_FIELD);
    state.offset_id = abi::bind_parameter(&OFFSET_FIELD);
    state.follow_chords_id = abi::bind_parameter(&FOLLOW_CHORDS_FIELD);
    state.seed_id = abi::observe_field(&SEED_FIELD);
    for (index, path) in LANE_FIELDS.iter().enumerate() {
        state.lane_ids[index] = abi::observe_field(&[*path]);
    }
    state.length_id = abi::observe_field(&LENGTH_FIELD);
    state.step_broadcast = abi::bind_broadcast_int_array(&[0], 1);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, _sample_rate: f32) {
    seed(unsafe { &mut *(state_ptr as *mut ArpState) });
}

/// Write one step lane from its box values (int32 per step, percent for velocity / gate / chance).
pub fn set_lane(state: &mut ArpState, lane: Lane, values: &[i32]) {
    for (slot, value) in values.iter().take(STEP_COUNT).enumerate() {
        let value = *value;
        match lane {
            Lane::Kind => state.kinds[slot] = value.clamp(STEP_NOTE as i32, STEP_CHORD as i32) as u8,
            Lane::Velocity => state.velocities[slot] = value.clamp(0, 100) as f32 / 100.0,
            Lane::Gate => state.gates[slot] = value.clamp(0, 200) as f32 / 100.0,
            Lane::Transpose => state.transposes[slot] = value.clamp(-12, 12),
            Lane::Octave => state.octave_shifts[slot] = value.clamp(-2, 2),
            Lane::Chance => state.chances[slot] = value.clamp(0, 100) as f32 / 100.0,
            Lane::Ratchet => state.ratchets[slot] = value.clamp(1, MAX_RATCHET)
        }
    }
}

pub fn set_seed(state: &mut ArpState, seed: u32) {
    state.seed = seed;
}

pub fn set_length(state: &mut ArpState, length: i32) {
    state.length = length.clamp(1, STEP_COUNT as i32) as usize;
}

fn apply_field(state: &mut ArpState, id: u32, value: FieldValue) {
    if id == state.seed_id {
        if let FieldValue::Int(seed) = value {
            set_seed(state, seed as u32);
        }
    } else if id == state.length_id {
        if let FieldValue::Int(length) = value {
            set_length(state, length);
        }
    } else if let Some(index) = state.lane_ids.iter().position(|bound| *bound == id) {
        if let FieldValue::Ints(values) = value {
            set_lane(state, LANES[index], values);
        }
    }
}

#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    apply_field(state, id, unsafe { FieldValue::from_wire(kind, bits, len) });
}

pub fn apply_parameter(state: &mut ArpState, id: u32, value: ParamValue) {
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
    } else if id == state.order_id {
        state.order = abi::int_value(value, &ORDER_MAPPING);
    } else if id == state.hold_id {
        state.hold = abi::bool_value(value);
        if !state.hold {
            state.latch_count = 0;
            state.latch_released = true;
        }
    } else if id == state.retrigger_id {
        state.retrigger = abi::int_value(value, &RETRIGGER_MAPPING);
    } else if id == state.offset_id {
        state.offset = abi::int_value(value, &OFFSET_MAPPING);
    } else if id == state.follow_chords_id {
        state.follow_chords = abi::bool_value(value);
    }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    apply_parameter(state, id, ParamValue::from_wire(kind, value, modulation));
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => abi::int_value(value, &MODE_MAPPING) as f32,
        1 => abi::int_value(value, &OCTAVES_MAPPING) as f32,
        2 => abi::int_value(value, &RATE_MAPPING) as f32,
        3 => abi::float_value(value, &GATE_MAPPING),
        4 => abi::int_value(value, &REPEAT_MAPPING) as f32,
        5 => abi::float_value(value, &VELOCITY_MAPPING),
        6 => abi::int_value(value, &ORDER_MAPPING) as f32,
        7 => if abi::bool_value(value) { 1.0 } else { 0.0 },
        8 => abi::int_value(value, &RETRIGGER_MAPPING) as f32,
        9 => abi::int_value(value, &OFFSET_MAPPING) as f32,
        10 => if abi::bool_value(value) { 1.0 } else { 0.0 },
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    abi::render_sub_ranges(state, from, to, flags, out, abi::first_update_position(from),
        &mut |sub_from, sub_to, flags, scratch| abi::pull_events(sub_from, sub_to, flags, scratch),
        &mut |state, boundary| {
            abi::apply_param_changes::<ArpState>(state, boundary, apply_parameter);
            abi::next_update_position(boundary)
        },
        &mut |state, sub_from, sub_to, flags, input, output| process(state, sub_from, sub_to, flags, input, output)) as u32
}

/// The host disabled or removed this effect: end every note it started.
#[no_mangle]
pub extern "C" fn release_all(state_ptr: u32, position: f64, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &mut *(state_ptr as *mut ArpState) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    release_all_into(state, position, out) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ArpState {
        let mut state: ArpState = unsafe { core::mem::zeroed() };
        seed(&mut state); // 1/16 = 240, up, 1 octave, gate 1
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

    // the native harmony is process-wide, tests that set it must not overlap
    static HARMONY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn chord_pitches(state: &mut ArpState, input: &[EventRecord], chord: Option<(i32, i32)>) -> Vec<u32> {
        let _lock = HARMONY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        abi::set_native_harmony(abi::Harmony {root: 0, bits: math::harmony::MAJOR_BITS, chord});
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let written = process(state, 0.0, 3840.0, abi::BlockFlags::TRANSPORTING, input, &mut out);
        abi::set_native_harmony(abi::Harmony {root: 0, bits: math::harmony::MAJOR_BITS, chord: None});
        out[..written].iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.pitch).collect()
    }

    #[test]
    fn follow_chords_plays_the_chord_without_held_keys() {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.follow_chords = true;
        state.transporting = true;
        assert_eq!(chord_pitches(&mut state, &[], Some((7, 0x91))), vec![67, 71, 74, 67], "G major from C3 upwards");
    }

    #[test]
    fn follow_chords_plays_stacked_and_inverted_voicings() {
        let mut state = state_with_follow();
        let g9 = (1 << 0) | (1 << 4) | (1 << 7) | (1 << 10) | (1 << 14);
        assert_eq!(chord_pitches(&mut state, &[], Some((7, g9))), vec![67, 71, 74, 77], "G9 walks up into the ninth");
        let mut inverted = state_with_follow();
        let c_first = (1 << 4) | (1 << 7) | (1 << 12);
        assert_eq!(chord_pitches(&mut inverted, &[], Some((0, c_first))), vec![64, 67, 72, 64], "C/E starts on E");
    }

    #[test]
    fn follow_chords_voices_the_chord_in_the_octave_of_the_lowest_held_key() {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.follow_chords = true;
        state.transporting = true;
        let input = [note_on(0.0, 4000.0, 50, 0.5), note_on(0.0, 4000.0, 77, 0.9)];
        assert_eq!(chord_pitches(&mut state, &input, Some((9, 0x89))), vec![57, 60, 64, 57], "A minor in the octave of the lowest held key");
    }

    #[test]
    fn follow_chords_falls_back_to_the_held_keys_without_a_chord() {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.follow_chords = true;
        state.transporting = true;
        let input = [note_on(0.0, 4000.0, 62, 0.8)];
        assert_eq!(chord_pitches(&mut state, &input, None), vec![62, 62, 62, 62]);
        let mut silent = state_with_follow();
        assert!(chord_pitches(&mut silent, &[], None).is_empty(), "no chord, no keys, no notes");
    }

    #[test]
    fn follow_chords_off_ignores_the_chord_track() {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.transporting = true;
        let input = [note_on(0.0, 4000.0, 62, 0.8)];
        assert_eq!(chord_pitches(&mut state, &input, Some((7, 0x91))), vec![62, 62, 62, 62]);
    }

    fn state_with_follow() -> ArpState {
        let mut state = state();
        state.rate = rate_ppqn(3);
        state.follow_chords = true;
        state.transporting = true;
        state
    }

    #[test]
    fn a_stopped_transport_arpeggiates_the_held_live_notes() {
        // TS `onlyExternal = !transporting`: while stopped the arp steps over the EXTERNAL (live) notes. The
        // engine's paused block keeps a free-running position, and the sequencer hands over live notes only.
        let mut state = state();
        let held = [note_on(0.0, f64::INFINITY, 60, 0.8)];
        let mut out = [note_on(0.0, 0.0, 0, 0.0); 64];
        let written = process(&mut state, 0.0, 960.0, 0, &held, &mut out);
        assert_eq!(on_count(&out[..written]), 4, "a held key steps on the 1/16 grid while stopped");
        // The key is released: its note-off ends the span, no further step starts.
        let release = [EventRecord {position: 1000.0, offset: 0, kind: EVENT_NOTE_OFF, id: 1, pitch: 60, velocity: 0.0, cent: 0.0, duration: 0.0}];
        process(&mut state, 960.0, 1200.0, 0, &release, &mut out);
        let written = process(&mut state, 1200.0, 2160.0, 0, &[], &mut out);
        assert_eq!(on_count(&out[..written]), 0, "no step after the key went up");
    }
}

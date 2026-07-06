//! The ZEITGEIST (groove / time-warp) MIDI-effect device: it SHUFFLES the event stream by warping note
//! positions in time. Mirrors the TS `ZeitgeistDeviceProcessor` + `GrooveShuffleBoxAdapter` / `GroovePattern`:
//! to produce its output for `[from, to)` it pulls its upstream over the UN-warped range
//! `[unwarp(from), unwarp(to)]`, then maps each event's position through `warp` (clamped back into
//! `[from, to]`). The warp is a per-cell Moebius ease (`GrooveShuffle`): within each `duration` cell the
//! downbeat stays put and the off-beat is pushed later (`h > 0.5`, swing) or earlier (`h < 0.5`); `h = 0.5`
//! is the identity. It works entirely in PULSE positions (the chain's currency) — the consuming instrument
//! resolves sample offsets — so this device touches no sample timing at all.
//!
//! The groove parameters live on the CONNECTED `GrooveShuffleBox` (the target of the device box's `groove`
//! pointer at `[10]`), NOT on the device box: `amount` `[10]` (unipolar; the adapter squashes it into
//! `[0.01, 0.99]`, `squashUnit(amount, 0.01)`) and `duration` `[11]` (a real ppqn int). The device declares
//! field observations THROUGH the pointer (paths `[10, 10]` / `[10, 11]`) and applies deliveries in
//! `field_changed`: the engine resolves the pointer at the path head, delivers the target box's values
//! (catch-up + live edits) and re-resolves on a repoint / clear (an unbound pointer delivers nothing, so
//! the state keeps the seeded `GrooveShuffleBox` schema defaults, amount 0.6 / duration 480). Field
//! observation IS full TS parity here: the studio's `ZeitgeistDeviceEditor` creates both groove knobs with
//! `disableAutomation: true`, so no Value track can target the groove fields — there is no automation to
//! mirror via `bind_parameter`.
//!
//! Exports: `kind()` (midi effect), `state_size()`, `init(...)`, `field_changed(...)`, `map_parameter(...)`,
//! `process_events(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, FieldValue, ParamValue};
use math::value_mapping::{Linear, Values};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

// WASM CONTRACT: the groove pointer key on `ZeitgeistDeviceBox` (10) and the `GrooveShuffleBox` field keys
// (amount 10, duration 11) — the observation paths run THROUGH the pointer.
const AMOUNT_FIELD: [u16; 2] = [10, 10];
const DURATION_FIELD: [u16; 2] = [10, 11];

// WASM CONTRACT: mirrors `GrooveShuffleBoxAdapter.DurationPPQNs` (`PPQN.fromSignature` over `Durations`).
const DURATION_PPQNS: [i32; 9] = [480, 960, 960, 1920, 3840, 7680, 15360, 30720, 61440];
const AMOUNT_MAPPING: Linear = Linear::unipolar();
const DURATION_MAPPING: Values<i32> = Values::new(&DURATION_PPQNS);

// The `GrooveShuffleBox` schema defaults (amount 0.6, duration = PPQN.fromSignature(1, 8) = 480): the seed
// until the engine's catch-up delivers the connected groove box's real values, and what the state keeps
// while the `groove` pointer is unbound. `amount` is an `f32` because the box field is a float32 — the TS
// adapter reads the f32-rounded value, so the seed must too.
const DEFAULT_AMOUNT: f32 = 0.6;
const DEFAULT_DURATION: f64 = 480.0;
const SQUASH_MARGIN: f64 = 0.01; // the adapter's `squashUnit(amount, 0.01)` margin
const PULL_SCRATCH: usize = 256;

/// The device's per-instance state (engine-allocated, seeded in `init`): `h` is the SQUASHED amount
/// (`squashUnit(amount, 0.01)`, so `0.5` is straight / identity), `duration` the groove cell in pulses.
/// The ids match the `observe_field` declarations.
pub struct ZeitgeistState {
    h: f64,
    duration: f64,
    amount_id: u32,
    duration_id: u32
}

// TS `squashUnit(value, margin)`: clamp to the unit interval, then squeeze into `[margin, 1 - margin]` —
// the adapter applies it to `amount`, keeping the Moebius ease away from its degenerate endpoints.
fn squash_unit(value: f64) -> f64 {
    let clamped = if value < 0.0 { 0.0 } else if value > 1.0 { 1.0 } else { value };
    SQUASH_MARGIN + (1.0 - 2.0 * SQUASH_MARGIN) * clamped
}

// TS `moebiusEase(x, h)`: a Moebius (rational) ease of `[0,1] -> [0,1]` biased by `h`; `h = 0.5` is the
// identity, and `moebiusEase(., 1 - h)` is its inverse (so warp / unwarp are a bijection).
fn moebius_ease(x: f64, h: f64) -> f64 {
    (x * h) / ((2.0 * h - 1.0) * (x - 1.0) + h)
}

// Mirror of `GroovePattern.#transform`: quantise to the cell, ease the normalized position, scale back.
// `forward` is warp (straight -> grooved), else unwarp (grooved -> straight). `floor` via integer truncation
// (positions are non-negative) since `f64::floor` is not in `core`.
fn transform(state: &ZeitgeistState, position: f64, forward: bool) -> f64 {
    let duration = state.duration;
    let start = (position / duration) as i64 as f64 * duration;
    let normalized = (position - start) / duration;
    let eased = moebius_ease(normalized, if forward { state.h } else { 1.0 - state.h });
    start + eased * duration
}

pub fn warp(state: &ZeitgeistState, position: f64) -> f64 {
    transform(state, position, true)
}

pub fn unwarp(state: &ZeitgeistState, position: f64) -> f64 {
    transform(state, position, false)
}

/// Seed a (zeroed) state with the `GrooveShuffleBox` schema defaults and declare the groove field
/// observations. Kept separate from the `init` export so tests can seed a state directly (the export takes
/// a `u32` pointer, which truncates on a 64-bit native test build).
pub fn seed(state: &mut ZeitgeistState) {
    state.h = squash_unit(DEFAULT_AMOUNT as f64);
    state.duration = DEFAULT_DURATION;
    state.amount_id = abi::observe_field(&AMOUNT_FIELD);
    state.duration_id = abi::observe_field(&DURATION_FIELD);
}

/// Apply a delivered groove field (mirrors the `GrooveShuffleBoxAdapter` subscriptions): `amount` is squashed
/// into `h`, `duration` is the real ppqn value (a non-positive one is ignored — the cell length divides).
pub fn apply_field(state: &mut ZeitgeistState, id: u32, value: FieldValue) {
    if id == state.amount_id {
        let FieldValue::Float(amount) = value else { panic!("amount must be a float") };
        state.h = squash_unit(amount as f64);
    } else if id == state.duration_id {
        let FieldValue::Int(duration) = value else { panic!("duration must be an int") };
        if duration > 0 {
            state.duration = duration as f64;
        }
    }
}

/// The pure block transform (host-free, so native tests drive it): warp each input record's position and
/// clamp it into `[from, to]` (TS `clamp(groove.warp(event.position), from, to)`). Returns the count written.
pub fn process(state: &ZeitgeistState, from: f64, to: f64, input: &[EventRecord], out: &mut [EventRecord]) -> usize {
    let mut count = 0;
    for record in input {
        if count >= out.len() {
            break;
        }
        let warped = warp(state, record.position);
        let position = if warped < from { from } else if warped > to { to } else { warped };
        let mut shifted = *record;
        shifted.position = position;
        out[count] = shifted;
        count += 1;
    }
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
    core::mem::size_of::<ZeitgeistState>() as u32
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, _sample_rate: f32) {
    seed(unsafe { &mut *(state_ptr as *mut ZeitgeistState) });
}

/// Apply an observed groove field's value, by the id `observe_field` returned. Driven by the engine's
/// catch-up + subscription (inside a transaction, never during render).
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    let state = unsafe { &mut *(state_ptr as *mut ZeitgeistState) };
    apply_field(state, id, unsafe { FieldValue::from_wire(kind, bits, len) });
}

/// Parity probe (the shared device shape): the REAL value stored for a UNIT automation value, ids in the
/// groove box's parameter order (0 = amount, 1 = duration). The mappings mirror `GrooveShuffleBoxAdapter`
/// (`amount` unipolar, `duration` over `DurationPPQNs`); the parameters live behind the device's `groove`
/// pointer and the studio disables automation on them, so they are field observations, not `bind_parameter`
/// bindings (see the module docs).
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => abi::float_value(value, &AMOUNT_MAPPING),
        1 => abi::int_value(value, &DURATION_MAPPING) as f32,
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let state = unsafe { &*(state_ptr as *const ZeitgeistState) };
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut scratch = [blank; PULL_SCRATCH];
    // Pull the UN-warped range, so events that the groove pushes into [from, to) are captured.
    let pulled = abi::pull_events(unwarp(state, from), unwarp(state, to), flags, &mut scratch);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    process(state, from, to, &scratch[..pulled], out) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(amount: f64, duration: f64) -> ZeitgeistState {
        ZeitgeistState {h: squash_unit(amount), duration, amount_id: 7, duration_id: 8}
    }

    // The box amount whose squash equals the device's PREVIOUS hardcoded `h = 0.65`.
    fn legacy_amount() -> f64 {
        (0.65 - SQUASH_MARGIN) / (1.0 - 2.0 * SQUASH_MARGIN)
    }

    fn note_on(position: f64) -> EventRecord {
        EventRecord {position, offset: 0, kind: abi::EVENT_NOTE_ON, id: 1, pitch: 60, velocity: 0.8, cent: 0.0, duration: 240.0}
    }

    #[test]
    fn amount_half_is_the_identity() {
        // TS: squashUnit(0.5, 0.01) = 0.5 and moebiusEase(x, 0.5) = x — the straight setting.
        let state = state(0.5, 480.0);
        for position in [0.0, 100.0, 240.0, 360.0, 480.0, 700.0, 955.0] {
            assert!((warp(&state, position) - position).abs() < 1.0e-9, "warp is the identity at amount 0.5");
            assert!((unwarp(&state, position) - position).abs() < 1.0e-9, "unwarp is the identity at amount 0.5");
        }
    }

    #[test]
    fn the_downbeat_stays_and_the_offbeat_swings_later() {
        let state = state(legacy_amount(), 480.0);
        assert!((warp(&state, 0.0) - 0.0).abs() < 1.0e-6, "cell downbeat unchanged");
        assert!((warp(&state, 480.0) - 480.0).abs() < 1.0e-6, "next cell downbeat unchanged");
        let offbeat = warp(&state, 240.0);
        assert!(offbeat > 240.0, "the off-beat is pushed later (swing)");
        assert!((offbeat - 312.0).abs() < 1.0e-6, "moebius(0.5, 0.65) * 480 = 312 (the previous hardcode)");
    }

    #[test]
    fn seeding_yields_the_schema_default_groove() {
        // squashUnit(0.6f32, 0.01) = 0.598 -> moebius(0.5, 0.598) * 480 = 287.04 (within the f32-rounded
        // amount the box field carries), what a stock Zeitgeist swings.
        let mut state = state(0.0, 0.0);
        seed(&mut state);
        assert!((warp(&state, 240.0) - 287.04).abs() < 1.0e-3, "the GrooveShuffleBox defaults drive the warp");
    }

    #[test]
    fn field_deliveries_update_the_groove_live() {
        let mut state = state(0.6, 480.0);
        apply_field(&mut state, 7, FieldValue::Float(0.5));
        assert!((warp(&state, 240.0) - 240.0).abs() < 1.0e-9, "a delivered amount 0.5 straightens the stream");
        apply_field(&mut state, 8, FieldValue::Int(960));
        apply_field(&mut state, 7, FieldValue::Float(legacy_amount() as f32));
        let offbeat = warp(&state, 480.0);
        assert!((offbeat - 624.0).abs() < 1.0e-3, "moebius(0.5, 0.65) * 960 = 624 (the delivered 1/4 cell)");
        apply_field(&mut state, 8, FieldValue::Int(0));
        assert!((warp(&state, 480.0) - offbeat).abs() < 1.0e-9, "a non-positive duration is ignored");
    }

    #[test]
    fn unwarp_inverts_warp_for_any_amount() {
        for amount in [0.0, 0.25, 0.6, 0.9, 1.0] {
            let state = state(amount, 480.0);
            for position in [0.0, 100.0, 240.0, 360.0, 480.0, 700.0, 955.0] {
                assert!((unwarp(&state, warp(&state, position)) - position).abs() < 1.0e-3, "unwarp(warp(p)) == p");
            }
        }
    }

    #[test]
    fn a_note_stream_is_straight_at_amount_half_and_swung_at_the_old_hardcode() {
        let input = [note_on(0.0), note_on(240.0), note_on(480.0), note_on(720.0)];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        let mut out = [blank; 8];
        let straight = state(0.5, 480.0);
        let written = process(&straight, 0.0, 960.0, &input, &mut out);
        assert_eq!(written, 4);
        for (record, original) in out[..written].iter().zip(&input) {
            assert!((record.position - original.position).abs() < 1.0e-9, "the stream passes unwarped at amount 0.5");
        }
        let swung = state(legacy_amount(), 480.0);
        let written = process(&swung, 0.0, 960.0, &input, &mut out);
        assert_eq!(written, 4);
        for (record, expected) in out[..written].iter().zip([0.0, 312.0, 480.0, 792.0]) {
            assert!((record.position - expected).abs() < 1.0e-6, "the off-beats swing exactly like the previous hardcode");
        }
    }
}

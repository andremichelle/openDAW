//! A simple ZEITGEIST (groove / time-warp) MIDI-effect device: it SHUFFLES the event stream by warping
//! note positions in time. Modeled on the TS `ZeitgeistDeviceProcessor` + `GroovePattern`: to produce its
//! output for `[from, to)` it pulls its upstream over the UN-warped range `[unwarp(from), unwarp(to)]`,
//! then maps each event's position through `warp` (clamped back into `[from, to)`). The warp is a per-cell
//! Moebius ease (`GrooveShuffle`): within each 1/8-note cell the downbeat stays put and the off-beat is
//! pushed later, i.e. swing. It works entirely in PULSE positions (the chain's currency) — the consuming
//! instrument resolves sample offsets — so this device touches no sample timing at all.
//!
//! This is the range-flexible pull the plan calls out: the requested range and the pulled range differ,
//! but stay monotonic, so a stateful upstream (the arpeggiator) is pulled correctly. Stateless itself.
//!
//! Exports: `kind()` (midi effect), `state_size()` (0), `process_events(...)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::EventRecord;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const CELL: f64 = 480.0; // groove cell = PPQN.SemiQuaver * 2 (one 1/8 note = two 1/16s)
const AMOUNT: f64 = 0.65; // swing amount; 0.5 = straight (identity), >0.5 pushes the off-beat later
const PULL_SCRATCH: usize = 256;

// TS `moebiusEase(x, h)`: a Moebius (rational) ease of `[0,1] -> [0,1]` biased by `h`; `h = 0.5` is the
// identity, and `moebiusEase(., 1 - h)` is its inverse (so warp / unwarp are a bijection).
fn moebius_ease(x: f64, h: f64) -> f64 {
    (x * h) / ((2.0 * h - 1.0) * (x - 1.0) + h)
}

// Mirror of `GroovePattern`: quantise to the cell, ease the normalized position, scale back. `forward` is
// warp (straight -> grooved), else unwarp (grooved -> straight). `floor` via integer truncation (positions
// are non-negative) since `f64::floor` is not in `core`.
fn transform(position: f64, forward: bool) -> f64 {
    let start = (position / CELL) as i64 as f64 * CELL;
    let normalized = (position - start) / CELL;
    let eased = moebius_ease(normalized, if forward { AMOUNT } else { 1.0 - AMOUNT });
    start + eased * CELL
}

pub fn warp(position: f64) -> f64 {
    transform(position, true)
}

pub fn unwarp(position: f64) -> f64 {
    transform(position, false)
}

/// What the host wires this device as (read at load): a MIDI effect (a pull source in the event chain).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_MIDI_EFFECT
}

/// Stateless: the groove is fixed, so it needs no per-instance state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn process_events(from: f64, to: f64, flags: u32, _state_ptr: u32, out_ptr: u32, max: u32) -> u32 {
    let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    let mut scratch = [blank; PULL_SCRATCH];
    // Pull the UN-warped range, so events that the groove pushes into [from, to) are captured.
    let pulled = abi::pull_events(unwarp(from), unwarp(to), flags, &mut scratch);
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut EventRecord, max as usize) };
    let mut count = 0;
    for record in &scratch[..pulled] {
        if count >= out.len() {
            break;
        }
        let warped = warp(record.position);
        let position = if warped < from { from } else if warped > to { to } else { warped };
        let mut shifted = *record;
        shifted.position = position;
        out[count] = shifted;
        count += 1;
    }
    count as u32
}

//! The Surgeon preview module: own memory, no imports, one engine, so the /testing preview plays what the device
//! will play. Raw pointer ABI like `stretch-wasm`. It runs inside an audio worklet of the preview.

extern crate alloc;

use alloc::boxed::Box;
use alloc::vec::Vec;
use core::ptr::addr_of_mut;
use device_surgeon::engine::{Engine, Slot, PATTERNS};
use device_surgeon::param::PARAMS;
use device_surgeon::pattern::{Lane, PitchLoop, LANES};

/// The floats `set_pattern` reads: rate, the pitch loop (steps, seed, mutate, range, density, tie, accent), four
/// lanes (steps, seed, mutate), the base positions, then the lane amounts row by row.
pub const PATTERN_FLOATS: usize = 1 + 7 + LANES * 3 + PARAMS + PARAMS * LANES;
const NO_SLOT: i32 = -2;
const OFF: i32 = -1;

static mut ENGINE: Option<Box<Engine>> = None;

fn engine() -> Option<&'static mut Engine> {
    unsafe { (*addr_of_mut!(ENGINE)).as_deref_mut() }
}

fn slot_of(value: i32) -> Slot {
    if value < 0 {Slot::Off} else {Slot::Pattern((value as usize).min(PATTERNS - 1))}
}

fn number_of(slot: Slot) -> i32 {
    match slot {
        Slot::Off => OFF,
        Slot::Pattern(index) => index as i32
    }
}

#[no_mangle]
pub extern "C" fn alloc_floats(count: usize) -> *mut f32 {
    let mut buffer = Vec::<f32>::with_capacity(count);
    let pointer = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub extern "C" fn pattern_floats() -> usize {PATTERN_FLOATS}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe { *addr_of_mut!(ENGINE) = Some(Box::new(Engine::new(sample_rate))) };
}

#[no_mangle]
pub extern "C" fn set_pattern(index: usize, values: *const f32) {
    let Some(engine) = engine() else {return;};
    let values = unsafe { core::slice::from_raw_parts(values, PATTERN_FLOATS) };
    let pattern = &mut engine.patterns[index.min(PATTERNS - 1)];
    pattern.rate = values[0] as u32;
    pattern.pitch = PitchLoop {
        steps: values[1] as u32, seed: values[2] as u32, mutate: values[3], range: values[4], density: values[5],
        tie: values[6], accent: values[7]
    };
    for lane in 0..LANES {
        let at = 8 + lane * 3;
        pattern.lanes[lane] = Lane {steps: values[at] as u32, seed: values[at + 1] as u32, mutate: values[at + 2]};
    }
    let base = 8 + LANES * 3;
    pattern.base.copy_from_slice(&values[base..base + PARAMS]);
    for param in 0..PARAMS {
        let at = base + PARAMS + param * LANES;
        pattern.amounts[param].copy_from_slice(&values[at..at + LANES]);
    }
}

/// `midi` is the centre pitch as a MIDI number with fractions.
#[no_mangle]
pub extern "C" fn set_tune(midi: f32) {
    if let Some(engine) = engine() {engine.tune = midi;}
}

#[no_mangle]
pub extern "C" fn set_volume(gain: f32) {
    if let Some(engine) = engine() {engine.volume = gain;}
}

/// A pattern index, or -1 for Off. Takes over at the next bar.
#[no_mangle]
pub extern "C" fn fire(slot: i32) {
    if let Some(engine) = engine() {engine.fire(slot_of(slot));}
}

/// Like `fire`, but at once (for a stopped transport).
#[no_mangle]
pub extern "C" fn select(slot: i32) {
    if let Some(engine) = engine() {engine.select(slot_of(slot));}
}

#[no_mangle]
pub extern "C" fn active() -> i32 {
    engine().map_or(OFF, |engine| number_of(engine.active()))
}

/// The slot waiting for its bar, or -2 when none waits.
#[no_mangle]
pub extern "C" fn fired() -> i32 {
    engine().and_then(|engine| engine.fired()).map_or(NO_SLOT, number_of)
}

#[no_mangle]
pub extern "C" fn process(p0: f64, p1: f64, playing: i32, discontinuous: i32, output: *mut f32, frames: usize) {
    let output = unsafe { core::slice::from_raw_parts_mut(output, frames) };
    match engine() {
        Some(engine) => engine.process(p0, p1, playing != 0, discontinuous != 0, output),
        None => output.fill(0.0)
    }
}

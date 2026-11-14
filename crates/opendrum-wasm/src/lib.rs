//! The openDrum display module: renders one hit through the devices' own engine descriptions (`opendrum-device`).

extern crate alloc;

use alloc::vec::Vec;
use opendrum::{bell::Bell, clap::Clap, cymbal::Cymbal, hat::Hat, kick::Kick, perc::Perc, rim::Rim};
use opendrum::{shaker::Shaker, snare::Snare, tom::Tom};
use opendrum_device::Engine;

// the display plays every hit at full velocity, the key at 60
const VELOCITY: f32 = 1.0;
// sample rate, frames, display frames, columns, bpm, then the engine's values in box key order
const HEADER: usize = 5;
// the render ends at the first chunk after the engine fell silent (a Gate note is never released here)
const CHUNK: usize = 2048;
// the trimmed hit keeps this much after its last sample above SILENT
const SILENT: f32 = 0.0001;
const TAIL_FRAMES: usize = 480;
const BAD_INPUT: i32 = -1;
const OUT_OF_DATE: i32 = -2;
const TOO_SMALL: i32 = -3;
// the spans in seconds a display zooms to
const SPANS: [f32; 6] = [0.0625, 0.125, 0.25, 0.5, 1.0, 2.0];
// below this share of the peak (-40 dB) a hit is under half a pixel on the display
const VISIBLE: f32 = 0.01;

/// Returns an 8 byte aligned area of `length` bytes, the worker keeps and reuses it.
#[no_mangle]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
    let mut buffer = Vec::<u64>::with_capacity(length.div_ceil(8).max(1));
    let pointer = buffer.as_mut_ptr().cast::<u8>();
    core::mem::forget(buffer);
    pointer
}

/// Writes how many values each engine reads (kick, snare, clap, tom, rim, hat, cymbal, shaker, bell, perc) as i32.
#[no_mangle]
pub extern "C" fn param_counts(_input: *const u8, _length: usize, output: *mut u8, capacity: usize) -> i32 {
    let counts = [Kick::PARAMS.len(), Snare::PARAMS.len(), Clap::PARAMS.len(), Tom::PARAMS.len(), Rim::PARAMS.len(),
        Hat::PARAMS.len(), Cymbal::PARAMS.len(), Shaker::PARAMS.len(), Bell::PARAMS.len(), Perc::PARAMS.len()];
    if capacity < counts.len() * 4 {return TOO_SMALL;}
    let output = unsafe { core::slice::from_raw_parts_mut(output.cast::<i32>(), counts.len()) };
    output.iter_mut().zip(counts).for_each(|(value, count)| *value = count as i32);
    (counts.len() * 4) as i32
}

/// Renders one hit and writes either its samples (columns 0) or its trimmed length, the display frames and a min
/// and a max per column over them.
fn hit<E: Engine>(input: *const u8, length: usize, output: *mut u8, capacity: usize) -> i32 {
    if length % 4 != 0 || length / 4 < HEADER {return BAD_INPUT;}
    let input = unsafe { core::slice::from_raw_parts(input.cast::<f32>(), length / 4) };
    if input.len() != HEADER + E::PARAMS.len() {return OUT_OF_DATE;}
    let (sample_rate, frames, display, columns, bpm) =
        (input[0], input[1] as usize, input[2] as usize, input[3] as usize, input[4]);
    if sample_rate <= 0.0 || frames == 0 {return BAD_INPUT;}
    let mut params = E::defaults();
    input[HEADER..].iter().enumerate().for_each(|(index, value)| E::set(&mut params, index, *value));
    let mut engine = E::create(sample_rate);
    engine.note_on(0, VELOCITY, 0.0, &params);
    let mut samples = alloc::vec![0.0f32; frames];
    for chunk in samples.chunks_mut(CHUNK) {
        engine.process(&params, bpm, chunk);
        if engine.is_silent() {break;}
    }
    let last = samples.iter().rposition(|value| value.abs() >= SILENT).unwrap_or(0);
    let trimmed = (last + 1 + TAIL_FRAMES).min(frames);
    let output = unsafe { core::slice::from_raw_parts_mut(output.cast::<f32>(), capacity / 4) };
    if columns == 0 {
        if output.len() < trimmed {return TOO_SMALL;}
        output[..trimmed].copy_from_slice(&samples[..trimmed]);
        return (trimmed * 4) as i32;
    }
    if output.len() < 2 + columns * 2 {return TOO_SMALL;}
    // display 0 zooms to the hit: the shortest span that holds all of it the display can show
    let display = if display > 0 {display} else {
        let peak = samples.iter().fold(0.0f32, |peak, value| peak.max(value.abs()));
        let visible = samples.iter().rposition(|value| value.abs() >= peak * VISIBLE).map_or(0, |last| last + 1);
        SPANS.iter().map(|seconds| (seconds * sample_rate) as usize).find(|span| *span >= visible).unwrap_or(frames)
    };
    output[0] = trimmed as f32;
    output[1] = display as f32;
    for column in 0..columns {
        let from = column * display / columns;
        let to = ((column + 1) * display / columns).max(from + 1).min(trimmed);
        let (low, high) = if from >= to {(0.0, 0.0)} else {
            samples[from..to].iter().fold((0.0f32, 0.0f32), |(low, high), value| (low.min(*value), high.max(*value)))
        };
        output[2 + column * 2] = low;
        output[3 + column * 2] = high;
    }
    ((2 + columns * 2) * 4) as i32
}

macro_rules! hit_export {
    ($name:ident, $engine:ty) => {
        #[no_mangle]
        pub extern "C" fn $name(input: *const u8, length: usize, output: *mut u8, capacity: usize) -> i32 {
            hit::<$engine>(input, length, output, capacity)
        }
    };
}

hit_export!(kick, Kick);
hit_export!(snare, Snare);
hit_export!(clap, Clap);
hit_export!(tom, Tom);
hit_export!(rim, Rim);
hit_export!(hat, Hat);
hit_export!(cymbal, Cymbal);
hit_export!(shaker, Shaker);
hit_export!(bell, Bell);
hit_export!(perc, Perc);

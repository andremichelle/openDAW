//! The openDrum preview module: own memory, no imports, renders one hit with the real engine so the /testing
//! preview plays what the device will play. Follows the convention of `@opendaw/lib-wasm-worker`: `alloc`, and
//! every export reads its input bytes and writes its output bytes.

extern crate alloc;

use alloc::vec::Vec;
use opendrum::kick::{Kick, KickParams, Play};
use opendrum::snare::{Snare, SnareParams};
use opendrum::clap::{Clap, ClapParams};
use opendrum::tom::{Tom, TomParams};
use opendrum::rim::{Rim, RimParams};
use opendrum::hat::{Hat, HatParams};
use opendrum::cymbal::{Cymbal, CymbalParams};
use opendrum::shaker::{Shaker, ShakerParams};
use opendrum::bell::{Bell, BellParams};
use opendrum::perc::{Perc, PercParams};

// the preview releases a held note (Mode Gate) after this time
const GATE_SECONDS: f32 = 0.2;

macro_rules! play_hit {
    ($engine:ident, $params:ident, $output:ident, $sample_rate:ident, |$out:ident| $process:expr) => {
        if $params.play == Play::Gate {
            let gate = ((GATE_SECONDS * $sample_rate) as usize).min($output.len());
            let (held, released) = $output.split_at_mut(gate);
            {let $out = held; $process;}
            $engine.note_off(0, &$params);
            {let $out = released; $process;}
        } else {
            let $out = $output;
            $process;
        }
    };
}

pub const KICK_PARAMS: usize = 20;
pub const SNARE_PARAMS: usize = 20;
pub const CLAP_PARAMS: usize = 16;
pub const TOM_PARAMS: usize = 20;
pub const RIM_PARAMS: usize = 18;
pub const HAT_PARAMS: usize = 11;
pub const CYMBAL_PARAMS: usize = 7;
pub const SHAKER_PARAMS: usize = 7;
pub const BELL_PARAMS: usize = 9;
pub const PERC_PARAMS: usize = 13;

// the preview plays every hit at full velocity
const VELOCITY: f32 = 1.0;
// sample rate, frames, display frames, columns, bpm, then the engine's values
const HEADER: usize = 5;
// the trimmed hit keeps this much after its last sample above SILENT
const SILENT: f32 = 0.0001;
const TAIL_FRAMES: usize = 480;
const BAD_INPUT: i32 = -1;
const OUT_OF_DATE: i32 = -2;
const TOO_SMALL: i32 = -3;

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
    let counts = [KICK_PARAMS, SNARE_PARAMS, CLAP_PARAMS, TOM_PARAMS, RIM_PARAMS, HAT_PARAMS, CYMBAL_PARAMS,
        SHAKER_PARAMS, BELL_PARAMS, PERC_PARAMS];
    if capacity < counts.len() * 4 {return TOO_SMALL;}
    let output = unsafe { core::slice::from_raw_parts_mut(output.cast::<i32>(), counts.len()) };
    output.iter_mut().zip(counts).for_each(|(value, count)| *value = count as i32);
    (counts.len() * 4) as i32
}

/// Renders one hit and writes either its samples (columns 0) or its trimmed length followed by a min and a max
/// per column over the display frames.
fn hit(input: *const u8, length: usize, output: *mut u8, capacity: usize, count: usize,
       render: fn(&[f32], f32, f32, &mut [f32])) -> i32 {
    if length % 4 != 0 || length / 4 < HEADER {return BAD_INPUT;}
    let input = unsafe { core::slice::from_raw_parts(input.cast::<f32>(), length / 4) };
    if input.len() != HEADER + count {return OUT_OF_DATE;}
    let (sample_rate, frames, display, columns, bpm) =
        (input[0], input[1] as usize, input[2] as usize, input[3] as usize, input[4]);
    if sample_rate <= 0.0 || frames == 0 {return BAD_INPUT;}
    let mut samples = alloc::vec![0.0f32; frames];
    render(&input[HEADER..], bpm, sample_rate, &mut samples);
    let last = samples.iter().rposition(|value| value.abs() >= SILENT).unwrap_or(0);
    let trimmed = (last + 1 + TAIL_FRAMES).min(frames);
    let output = unsafe { core::slice::from_raw_parts_mut(output.cast::<f32>(), capacity / 4) };
    if columns == 0 {
        if output.len() < trimmed {return TOO_SMALL;}
        output[..trimmed].copy_from_slice(&samples[..trimmed]);
        return (trimmed * 4) as i32;
    }
    if output.len() < 1 + columns * 2 {return TOO_SMALL;}
    output[0] = trimmed as f32;
    for column in 0..columns {
        let from = column * display / columns;
        let to = ((column + 1) * display / columns).max(from + 1).min(trimmed);
        let (low, high) = if from >= to {(0.0, 0.0)} else {
            samples[from..to].iter().fold((0.0f32, 0.0f32), |(low, high), value| (low.min(*value), high.max(*value)))
        };
        output[1 + column * 2] = low;
        output[2 + column * 2] = high;
    }
    ((1 + columns * 2) * 4) as i32
}

macro_rules! hit_export {
    ($name:ident, $count:ident, $render:ident) => {
        #[no_mangle]
        pub extern "C" fn $name(input: *const u8, length: usize, output: *mut u8, capacity: usize) -> i32 {
            hit(input, length, output, capacity, $count, $render)
        }
    };
}

hit_export!(kick, KICK_PARAMS, render_kick);
hit_export!(snare, SNARE_PARAMS, render_snare);
hit_export!(clap, CLAP_PARAMS, render_clap);
hit_export!(tom, TOM_PARAMS, render_tom);
hit_export!(rim, RIM_PARAMS, render_rim);
hit_export!(hat, HAT_PARAMS, render_hat);
hit_export!(cymbal, CYMBAL_PARAMS, render_cymbal);
hit_export!(shaker, SHAKER_PARAMS, render_shaker);
hit_export!(bell, BELL_PARAMS, render_bell);
hit_export!(perc, PERC_PARAMS, render_perc);

/// Params: tune, pitch, sweep, drift, decay, punch, shape, click, tone, skin, rumble, length (bars), duck, drive,
/// velocity, play (0 mono, 1 poly, 2 gate), bright, volume (dB), noise, glide (seconds).
fn render_kick(values: &[f32], bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let play = match values[15] as i32 {
        1 => Play::Poly,
        2 => Play::Gate,
        _ => Play::Mono
    };
    let params = KickParams {
        tune: values[0], pitch: values[1], sweep: values[2], drift: values[3], decay: values[4], punch: values[5],
        shape: values[6], click: values[7], tone: values[8], skin: values[9], rumble: values[10], length: values[11],
        duck: values[12], drive: values[13], velocity: values[14], play,
        bright: values[16], volume: values[17], noise: values[18], glide: values[19]
    };
    let mut kick = Kick::new(sample_rate);
    kick.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(kick, params, output, sample_rate, |out| kick.process(&params, bpm, out));
}

fn play_of(value: f32) -> Play {
    match value as i32 {
        1 => Play::Poly,
        2 => Play::Gate,
        _ => Play::Mono
    }
}

/// Params: tune, ratio, balance, pitch, sweep, decay, punch, shape, level, wire decay, width, curve, click,
/// tone, skin, drive, volume (dB), velocity, play (0 mono, 1 poly, 2 gate), glide (seconds).
fn render_snare(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = SnareParams {
        tune: values[0], ratio: values[1], balance: values[2], pitch: values[3], sweep: values[4], decay: values[5],
        punch: values[6], shape: values[7], level: values[8], wire_decay: values[9], width: values[10],
        curve: values[11], click: values[12], tone: values[13], skin: values[14], drive: values[15],
        volume: values[16], velocity: values[17], play: play_of(values[18]), glide: values[19]
    };
    let mut snare = Snare::new(sample_rate);
    snare.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(snare, params, output, sample_rate, |out| snare.process(&params, out));
}

/// Params: hands, gap, last, spread, attack, decay, snap, drive, tone, resonance, room (dB), room decay,
/// tail, volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
fn render_clap(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = ClapParams {
        hands: values[0], gap: values[1], last: values[2], spread: values[3], attack: values[4], decay: values[5],
        snap: values[6], drive: values[7], tone: values[8], resonance: values[9], room: values[10],
        room_decay: values[11], tail: values[12], volume: values[13], velocity: values[14],
        play: play_of(values[15])
    };
    let mut clap = Clap::new(sample_rate);
    clap.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(clap, params, output, sample_rate, |out| clap.process(&params, out));
}

/// Params: tune, pitch, sweep, drift, decay, punch, shape, sub, ratio, top, length, drive, noise (dB), noise decay,
/// color, air, volume (dB), velocity, play (0 mono, 1 poly, 2 gate), glide (seconds).
fn render_tom(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = TomParams {
        tune: values[0], pitch: values[1], sweep: values[2], drift: values[3], decay: values[4], punch: values[5],
        shape: values[6], sub: values[7], ratio: values[8], top: values[9], length: values[10], drive: values[11],
        noise: values[12], noise_decay: values[13], color: values[14], air: values[15], volume: values[16],
        velocity: values[17], play: play_of(values[18]), glide: values[19]
    };
    let mut tom = Tom::new(sample_rate);
    tom.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(tom, params, output, sample_rate, |out| tom.process(&params, out));
}

/// Params: tune, ratio, balance, high, high ratio, ring, ring high, decay, punch, drive, hard, click, swell, cut,
/// restart (0 or 1), volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
fn render_rim(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = RimParams {
        tune: values[0], ratio: values[1], balance: values[2], high: values[3], high_ratio: values[4],
        ring: values[5], ring_high: values[6], decay: values[7], punch: values[8], drive: values[9], hard: values[10],
        click: values[11], swell: values[12], cut: values[13], restart: values[14] >= 0.5, volume: values[15],
        velocity: values[16], play: play_of(values[17])
    };
    let mut rim = Rim::new(sample_rate);
    rim.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(rim, params, output, sample_rate, |out| rim.process(&params, out));
}

/// Params: tune, color, hold, decay, spread, ring, reso, curve, volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
fn render_hat(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = HatParams {
        tune: values[0], color: values[1], hold: values[2], decay: values[3], spread: values[4], ring: values[5],
        reso: values[6], curve: values[7], volume: values[8], velocity: values[9], play: play_of(values[10])
    };
    let mut hat = Hat::new(sample_rate);
    hat.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(hat, params, output, sample_rate, |out| hat.process(&params, out));
}

/// Params: tune, tone, attack, decay, volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
fn render_cymbal(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = CymbalParams {
        tune: values[0], tone: values[1], attack: values[2], decay: values[3], volume: values[4], velocity: values[5],
        play: play_of(values[6])
    };
    let mut cymbal = Cymbal::new(sample_rate);
    cymbal.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(cymbal, params, output, sample_rate, |out| cymbal.process(&params, out));
}

/// Params: color, attack, decay, curve, volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
fn render_shaker(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = ShakerParams {
        color: values[0], attack: values[1], decay: values[2], curve: values[3], volume: values[4],
        velocity: values[5], play: play_of(values[6])
    };
    let mut shaker = Shaker::new(sample_rate);
    shaker.note_on(0, VELOCITY, &params);
    play_hit!(shaker, params, output, sample_rate, |out| shaker.process(&params, out));
}

/// Params: tune, ratio, balance, color, strike, decay, volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
fn render_bell(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = BellParams {
        tune: values[0], ratio: values[1], balance: values[2], color: values[3], strike: values[4], decay: values[5],
        volume: values[6], velocity: values[7], play: play_of(values[8])
    };
    let mut bell = Bell::new(sample_rate);
    bell.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(bell, params, output, sample_rate, |out| bell.process(&params, out));
}

/// Params: tune, ratio, index, bite, pitch (semitones), sweep, decay, curve, noise, drive (dB), volume (dB), velocity,
/// play (0 mono, 1 poly, 2 gate).
fn render_perc(values: &[f32], _bpm: f32, sample_rate: f32, output: &mut [f32]) {
    let params = PercParams {
        tune: values[0], ratio: values[1], index: values[2], bite: values[3], pitch: values[4], sweep: values[5],
        decay: values[6], curve: values[7], noise: values[8], drive: values[9], volume: values[10],
        velocity: values[11], play: play_of(values[12])
    };
    let mut perc = Perc::new(sample_rate);
    perc.note_on(0, VELOCITY, 0.0, &params);
    play_hit!(perc, params, output, sample_rate, |out| perc.process(&params, out));
}

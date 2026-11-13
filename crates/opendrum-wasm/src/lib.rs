//! The openDrum preview module: own memory, no imports, renders one hit with the real engine so the /testing
//! preview plays what the device will play. Raw pointer ABI like `stretch-wasm`.

extern crate alloc;

use alloc::vec::Vec;
use opendrum::kick::{Kick, KickParams, Play};
use opendrum::snare::{Snare, SnareParams};
use opendrum::clap::{Clap, ClapParams};
use opendrum::tom::{Tom, TomParams};

/// The order of the floats `render_kick` reads, the preview writes them in this order.
pub const KICK_PARAMS: usize = 20;
pub const SNARE_PARAMS: usize = 20;
pub const CLAP_PARAMS: usize = 16;
pub const TOM_PARAMS: usize = 20;

#[no_mangle]
pub extern "C" fn alloc_floats(count: usize) -> *mut f32 {
    let mut buffer = Vec::<f32>::with_capacity(count);
    let pointer = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub extern "C" fn free_floats(pointer: *mut f32, count: usize) {
    unsafe { drop(Vec::from_raw_parts(pointer, 0, count)) };
}

#[no_mangle]
pub extern "C" fn kick_param_count() -> usize {KICK_PARAMS}

/// Params: tune, pitch, sweep, drift, decay, punch, shape, click, tone, skin, rumble, length (bars), duck, drive,
/// velocity, play (0 mono, 1 poly, 2 gate), bright, volume (dB), noise, glide (seconds). Renders one hit of `velocity` into `output[0..frames]`.
#[no_mangle]
pub extern "C" fn render_kick(params: *const f32, velocity: f32, bpm: f32, sample_rate: f32, output: *mut f32,
                              frames: usize) {
    let values = unsafe { core::slice::from_raw_parts(params, KICK_PARAMS) };
    let output = unsafe { core::slice::from_raw_parts_mut(output, frames) };
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
    kick.note_on(0, velocity, 0.0, &params);
    kick.process(&params, bpm, output);
}

#[no_mangle]
pub extern "C" fn snare_param_count() -> usize {SNARE_PARAMS}

fn play_of(value: f32) -> Play {
    match value as i32 {
        1 => Play::Poly,
        2 => Play::Gate,
        _ => Play::Mono
    }
}

/// Params: tune, ratio, balance, pitch, sweep, decay, punch, shape, level, wire decay, width, curve, click,
/// tone, skin, drive, volume (dB), velocity, play (0 mono, 1 poly, 2 gate), glide (seconds).
#[no_mangle]
pub extern "C" fn render_snare(params: *const f32, velocity: f32, sample_rate: f32, output: *mut f32, frames: usize) {
    let values = unsafe { core::slice::from_raw_parts(params, SNARE_PARAMS) };
    let output = unsafe { core::slice::from_raw_parts_mut(output, frames) };
    let params = SnareParams {
        tune: values[0], ratio: values[1], balance: values[2], pitch: values[3], sweep: values[4], decay: values[5],
        punch: values[6], shape: values[7], level: values[8], wire_decay: values[9], width: values[10],
        curve: values[11], click: values[12], tone: values[13], skin: values[14], drive: values[15],
        volume: values[16], velocity: values[17], play: play_of(values[18]), glide: values[19]
    };
    let mut snare = Snare::new(sample_rate);
    snare.note_on(0, velocity, 0.0, &params);
    snare.process(&params, output);
}

#[no_mangle]
pub extern "C" fn clap_param_count() -> usize {CLAP_PARAMS}

/// Params: hands, gap, last, spread, attack, decay, snap, drive, tone, resonance, room (dB), room decay,
/// tail, volume (dB), velocity, play (0 mono, 1 poly, 2 gate).
#[no_mangle]
pub extern "C" fn render_clap(params: *const f32, velocity: f32, sample_rate: f32, output: *mut f32, frames: usize) {
    let values = unsafe { core::slice::from_raw_parts(params, CLAP_PARAMS) };
    let output = unsafe { core::slice::from_raw_parts_mut(output, frames) };
    let params = ClapParams {
        hands: values[0], gap: values[1], last: values[2], spread: values[3], attack: values[4], decay: values[5],
        snap: values[6], drive: values[7], tone: values[8], resonance: values[9], room: values[10],
        room_decay: values[11], tail: values[12], volume: values[13], velocity: values[14],
        play: play_of(values[15])
    };
    let mut clap = Clap::new(sample_rate);
    clap.note_on(0, velocity, 0.0, &params);
    clap.process(&params, output);
}

#[no_mangle]
pub extern "C" fn tom_param_count() -> usize {TOM_PARAMS}

/// Params: tune, pitch, sweep, drift, decay, punch, shape, sub, ratio, top, length, drive, noise (dB), noise decay,
/// color, air, volume (dB), velocity, play (0 mono, 1 poly, 2 gate), glide (seconds).
#[no_mangle]
pub extern "C" fn render_tom(params: *const f32, velocity: f32, sample_rate: f32, output: *mut f32, frames: usize) {
    let values = unsafe { core::slice::from_raw_parts(params, TOM_PARAMS) };
    let output = unsafe { core::slice::from_raw_parts_mut(output, frames) };
    let params = TomParams {
        tune: values[0], pitch: values[1], sweep: values[2], drift: values[3], decay: values[4], punch: values[5],
        shape: values[6], sub: values[7], ratio: values[8], top: values[9], length: values[10], drive: values[11],
        noise: values[12], noise_decay: values[13], color: values[14], air: values[15], volume: values[16],
        velocity: values[17], play: play_of(values[18]), glide: values[19]
    };
    let mut tom = Tom::new(sample_rate);
    tom.note_on(0, velocity, 0.0, &params);
    tom.process(&params, output);
}

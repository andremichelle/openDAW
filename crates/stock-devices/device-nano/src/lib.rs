//! Nano, a polyphonic one-sample instrument, as a runtime-loadable device. It plays ONE loaded sample (its
//! `file` pointer) per note, each voice a pitch-rate read head with linear interpolation and a squared
//! attack/release envelope, transposed against a root key / octave, confined to a start/end region (start
//! past end plays backwards) and optionally cycling a crossfaded loop (see `voice.rs`). Voices are a plain
//! fixed pool: pushed on note-on, freed when they finish.
//!
//! The sample is resolved through the engine: the device observes its `file` pointer; the engine resolves it
//! to the AudioFileBox, requests the frames (Route F), and pushes the handle through `sample_changed`. Each
//! block the device calls `resolve_sample(handle)`: `None` while it loads (voices are dropped), the frames
//! once ready. The read-head positions publish through a float broadcast at the box address + `[1001]`.
//!
//! A project saved before the region / loop / envelope fields existed loads with their schema defaults,
//! which reproduce the original two-parameter Nano sample for sample (`tests/legacy_parity.rs`).

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, int_value, Block, EventRecord, Instrument, ParamValue, Ports, EVENT_NOTE_ON};
use math::db_to_gain;
use math::value_mapping::{Decibel, Exponential, Linear, LinearInteger};

mod voice;
use voice::{NanoVoice, Playback};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const MAX_VOICES: usize = 64;
const POSITION_SLOTS: u32 = 16; // the editor paints up to 16 playheads; the slot after the last holds -1
const LEGACY_ATTACK_SECONDS: f32 = 0.003; // the original Nano's fixed attack, the schema default

// The Nano box's field-key paths (the stable schema keys). `[10]`, `[15]` and `[20]` are the original fields.
const VOLUME_FIELD: [u16; 1] = [10];
const OCTAVE_FIELD: [u16; 1] = [11];
const ROOT_KEY_FIELD: [u16; 1] = [14];
const SAMPLE_POINTER: [u16; 1] = [15];
const RELEASE_FIELD: [u16; 1] = [20];
const ATTACK_FIELD: [u16; 1] = [21];
const SAMPLE_START_FIELD: [u16; 1] = [22];
const SAMPLE_END_FIELD: [u16; 1] = [23];
const LOOP_FIELD: [u16; 1] = [24];
const LOOP_FADE_FIELD: [u16; 1] = [25];
const LOOP_START_FIELD: [u16; 1] = [26];
const LOOP_END_FIELD: [u16; 1] = [27];
const POSITIONS_PATH: [u16; 1] = [1001];

const VOLUME_MAPPING: Decibel = Decibel::default_volume();
const OCTAVE_MAPPING: LinearInteger = LinearInteger {min: -3, max: 3};
const ROOT_KEY_MAPPING: LinearInteger = LinearInteger {min: 0, max: 127};
const RELEASE_MAPPING: Exponential = Exponential {min: 0.001, max: 8.0}; // seconds
const ATTACK_MAPPING: Exponential = Exponential {min: 0.001, max: 5.0}; // seconds
const REGION_MAPPING: Linear = Linear::unipolar();
const LOOP_FADE_MAPPING: Exponential = Exponential {min: 0.001, max: 1.0}; // seconds

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block: a fixed voice pool,
/// the resolved parameter values, the sample rate, the bound sample handle, and the parameter / sample /
/// broadcast binding ids the engine pushes against.
pub struct NanoState {
    voices: [NanoVoice; MAX_VOICES],
    gain: f32,
    octave: i32,
    root_key: i32,
    attack: u32,  // in samples
    release: u32, // in samples
    sample_start: f32,
    sample_end: f32,
    loop_enabled: bool,
    loop_fade_seconds: f32,
    loop_start: f32,
    loop_end: f32,
    sample_rate: f32,
    sample: Option<u32>, // the resolved sample handle while the `file` pointer is bound; `None` when unbound
    gain_id: u32,
    octave_id: u32,
    root_key_id: u32,
    release_id: u32,
    attack_id: u32,
    sample_start_id: u32,
    sample_end_id: u32,
    loop_id: u32,
    loop_fade_id: u32,
    loop_start_id: u32,
    loop_end_id: u32,
    sample_id: u32,
    positions_id: u32,
    positions_ptr: u32
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct Nano;

impl Instrument for Nano {
    type State = NanoState;

    fn init(state: &mut NanoState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life
        state.gain = 1.0; // schema defaults; the engine pushes the real values right after
        state.octave = 0;
        state.root_key = 60;
        state.attack = (LEGACY_ATTACK_SECONDS * sample_rate) as u32;
        state.release = sample_rate as u32;
        state.sample_start = 0.0;
        state.sample_end = 1.0;
        state.loop_enabled = false;
        state.loop_fade_seconds = 0.05;
        state.loop_start = 0.0;
        state.loop_end = 1.0;
        state.sample = None;
        state.gain_id = abi::bind_parameter(&VOLUME_FIELD);
        state.octave_id = abi::bind_parameter(&OCTAVE_FIELD);
        state.root_key_id = abi::bind_parameter(&ROOT_KEY_FIELD);
        state.release_id = abi::bind_parameter(&RELEASE_FIELD);
        state.attack_id = abi::bind_parameter(&ATTACK_FIELD);
        state.sample_start_id = abi::bind_parameter(&SAMPLE_START_FIELD);
        state.sample_end_id = abi::bind_parameter(&SAMPLE_END_FIELD);
        state.loop_id = abi::bind_parameter(&LOOP_FIELD);
        state.loop_fade_id = abi::bind_parameter(&LOOP_FADE_FIELD);
        state.loop_start_id = abi::bind_parameter(&LOOP_START_FIELD);
        state.loop_end_id = abi::bind_parameter(&LOOP_END_FIELD);
        state.sample_id = abi::observe_sample(&SAMPLE_POINTER);
        state.positions_id = abi::bind_broadcast(&POSITIONS_PATH, POSITION_SLOTS);
    }

    fn handle_event(state: &mut NanoState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            if let Some(slot) = state.voices.iter_mut().find(|voice| !voice.is_active()) {
                slot.start(event.id, event.pitch, event.cent, event.velocity);
            }
        } else if let Some(voice) = state.voices.iter_mut().find(|voice| voice.is_active() && voice.id() == event.id) {
            voice.stop(state.attack);
        }
    }

    fn process_audio(state: &mut NanoState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        let sample = state.sample.and_then(abi::resolve_sample);
        let Some(sample) = sample else {
            for voice in state.voices.iter_mut() {
                voice.force_stop();
            }
            publish_positions(state);
            return;
        };
        let left = sample.plane(0);
        let right = if sample.channel_count > 1 {sample.plane(1)} else {left};
        let loop_fade_frames = if state.loop_enabled {
            (state.loop_fade_seconds as f64 * sample.sample_rate as f64).max(1.0)
        } else {
            0.0
        };
        let playback = Playback {
            rate_ratio: sample.sample_rate as f64 / state.sample_rate as f64,
            root_key: state.root_key,
            octave: state.octave,
            gain: state.gain,
            attack: state.attack,
            release: state.release,
            sample_start: state.sample_start,
            sample_end: state.sample_end,
            loop_enabled: state.loop_enabled,
            loop_fade_frames,
            loop_start: state.loop_start,
            loop_end: state.loop_end
        };
        for voice in state.voices.iter_mut() {
            if voice.is_active() && voice.process(out_left, out_right, left, right, &playback) {
                voice.force_stop();
            }
        }
        publish_positions(state);
    }

    fn parameter_changed(state: &mut NanoState, id: u32, value: ParamValue) {
        if id == state.gain_id {
            state.gain = db_to_gain(float_value(value, &VOLUME_MAPPING));
        } else if id == state.octave_id {
            state.octave = int_value(value, &OCTAVE_MAPPING);
        } else if id == state.root_key_id {
            state.root_key = int_value(value, &ROOT_KEY_MAPPING);
        } else if id == state.release_id {
            state.release = (float_value(value, &RELEASE_MAPPING) * state.sample_rate) as u32;
        } else if id == state.attack_id {
            state.attack = (float_value(value, &ATTACK_MAPPING) * state.sample_rate) as u32;
        } else if id == state.sample_start_id {
            state.sample_start = float_value(value, &REGION_MAPPING);
        } else if id == state.sample_end_id {
            state.sample_end = float_value(value, &REGION_MAPPING);
        } else if id == state.loop_id {
            state.loop_enabled = bool_value(value);
        } else if id == state.loop_fade_id {
            state.loop_fade_seconds = float_value(value, &LOOP_FADE_MAPPING);
        } else if id == state.loop_start_id {
            state.loop_start = float_value(value, &REGION_MAPPING);
        } else if id == state.loop_end_id {
            state.loop_end = float_value(value, &REGION_MAPPING);
        }
    }

    fn sample_changed(state: &mut NanoState, id: u32, sample: Option<u32>) {
        // The sample (its `file` pointer), reactively delivered: a resident handle, or `None` on remove.
        if id == state.sample_id {
            state.sample = sample;
        }
    }

    fn reset(state: &mut NanoState) {
        for voice in state.voices.iter_mut() {
            voice.force_stop();
        }
    }
}

/// Publish the active read heads (in source frames) to the `[1001]` float broadcast the editor paints as
/// playheads: active positions first, `-1` terminating the list. Skipped until the engine drains the slot
/// (`broadcast_ptr` stays `0`).
fn publish_positions(state: &mut NanoState) {
    if state.positions_ptr == 0 {
        state.positions_ptr = abi::broadcast_ptr(state.positions_id);
    }
    if state.positions_ptr == 0 {
        return;
    }
    let slots = unsafe { core::slice::from_raw_parts_mut(state.positions_ptr as *mut f32, POSITION_SLOTS as usize) };
    let mut count = 0usize;
    for voice in state.voices.iter() {
        if voice.is_active() && count < slots.len() {
            slots[count] = voice.position() as f32;
            count += 1;
        }
    }
    if count < slots.len() {
        slots[count] = -1.0;
    }
}

/// Host-independent entry for tests: clear the stereo output, dispatch the supplied events through the SDK
/// template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead.
pub fn render(state: &mut NanoState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32], sample_rate: f32) {
    state.sample_rate = sample_rate;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<Nano>(state, [&mut *out_left, &mut *out_right], events, &block);
    Nano::finish(state, [out_left, out_right]);
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// What the host wires this device as (read at load): an instrument that voices notes into audio.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block. The voice pool is fixed, so the
/// size does not depend on `sample_rate`.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<NanoState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<NanoState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Nano>(ports);
}

/// Boot hook: bind this device's parameters + its sample reference with the host, and stash the sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Nano as Instrument>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Nano as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    match id {
        0 => float_value(value, &VOLUME_MAPPING),
        1 => int_value(value, &OCTAVE_MAPPING) as f32,
        2 => int_value(value, &ROOT_KEY_MAPPING) as f32,
        3 => float_value(value, &RELEASE_MAPPING),
        4 => float_value(value, &ATTACK_MAPPING),
        5 | 6 | 9 | 10 => float_value(value, &REGION_MAPPING),
        7 => if bool_value(value) {1.0} else {0.0},
        8 => float_value(value, &LOOP_FADE_MAPPING),
        _ => f32::NAN
    }
}

/// Apply an observed sample reference (its `file` pointer), by the id `observe_sample` returned. `present != 0`
/// means a resident `handle`, `0` means the pointer is unbound.
#[no_mangle]
pub extern "C" fn sample_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    let sample = if present != 0 {Some(handle)} else {None};
    unsafe { abi::with_state(state_ptr, |state| <Nano as Instrument>::sample_changed(state, id, sample)) }
}

/// Transport STOP: drop every voice so playback starts silent.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Nano as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    //! The Nano voice DSP is covered in `voice.rs`. Here: with no sample resident (the native `resolve_sample`
    //! stub returns none), the device stays silent and drops voices, mirroring the TS loader-empty behaviour.
    use super::*;

    const SR: f32 = 48_000.0;

    fn note_on(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 1.0, cent: 0.0, duration: 0.0}
    }

    #[test]
    fn silent_without_a_resident_sample() {
        let mut state: NanoState = unsafe { core::mem::zeroed() };
        state.sample = Some(1); // a handle is bound, but the native resolve stub returns none (not resident)
        let (mut left, mut right) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        assert_eq!(left.iter().fold(0.0f32, |acc, value| acc.max(value.abs())), 0.0, "no audio until a sample is resident");
    }
}

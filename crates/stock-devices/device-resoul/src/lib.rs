//! re-soul, a polyphonic sampler instrument, as a runtime-loadable device: a faithful port of the (retired)
//! TS `ReSoulDeviceProcessor`. It plays ONE loaded sample (its `file` pointer) per note, each voice a
//! pitch-rate read head with linear interpolation and a squared attack/release envelope, extended over Nano
//! by a root key (the note that plays the sample at its native rate), an octave shift, a start/end region
//! and reverse playback (see `voice.rs`). Voices are a plain fixed pool: pushed on note-on, freed when they
//! finish.
//!
//! The sample is resolved through the engine: the device declares its `file` pointer path with
//! `observe_sample`; the engine resolves it to the AudioFileBox, requests the frames (Route F), and pushes
//! the resolved handle through `sample_changed`. Each block the device calls `resolve_sample(handle)`:
//! `None` while it loads (voices are dropped, as in the TS), the frames once ready.
//!
//! The read-head positions publish through a float broadcast at the box address + `[1001]` (the path the
//! device editor's playhead painter subscribes to — the TS `positionsAddress`).
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(state_ptr, id, kind, value, modulation)`, `sample_changed`, `reset`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, int_value, Block, EventRecord, Instrument, ParamValue, Ports, EVENT_NOTE_ON};
use math::db_to_gain;
use math::value_mapping::{Decibel, Exponential, Linear, LinearInteger};

mod voice;
use voice::ReSoulVoice;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

const MAX_VOICES: usize = 64;
const POSITION_SLOTS: u32 = 16; // the editor paints up to 16 playheads; slot after the last holds -1

// The ReSoul box's field-key paths (the stable schema keys): volume `[10]` (decibel), octave `[11]`,
// reverse `[12]`, root key `[14]`, the sample `file` pointer `[15]`, attack `[20]` / release `[21]`
// (seconds, exponential), and the unit sample region `[22]`/`[23]`. `[1001]` is the positions broadcast.
const VOLUME_FIELD: [u16; 1] = [10];
const OCTAVE_FIELD: [u16; 1] = [11];
const REVERSE_FIELD: [u16; 1] = [12];
const ROOT_KEY_FIELD: [u16; 1] = [14];
const SAMPLE_POINTER: [u16; 1] = [15];
const ATTACK_FIELD: [u16; 1] = [20];
const RELEASE_FIELD: [u16; 1] = [21];
const SAMPLE_START_FIELD: [u16; 1] = [22];
const SAMPLE_END_FIELD: [u16; 1] = [23];
const POSITIONS_PATH: [u16; 1] = [1001];

const VOLUME_MAPPING: Decibel = Decibel::default_volume();
const OCTAVE_MAPPING: LinearInteger = LinearInteger {min: -3, max: 3};
const ROOT_KEY_MAPPING: LinearInteger = LinearInteger {min: 0, max: 127};
const ATTACK_MAPPING: Exponential = Exponential {min: 0.001, max: 5.0}; // seconds
const RELEASE_MAPPING: Exponential = Exponential {min: 0.001, max: 8.0}; // seconds
const REGION_MAPPING: Linear = Linear::unipolar();

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block: a fixed voice
/// pool, the resolved parameter values, the sample rate, the bound sample handle, and the parameter /
/// sample / broadcast binding ids the engine pushes against.
pub struct ReSoulState {
    voices: [ReSoulVoice; MAX_VOICES],
    gain: f32,
    octave: i32,
    reverse: bool,
    root_key: i32,
    attack: u32,  // attack length in samples
    release: u32, // release length in samples
    sample_start: f32, // unit region
    sample_end: f32,
    sample_rate: f32,
    sample: Option<u32>,
    gain_id: u32,
    octave_id: u32,
    reverse_id: u32,
    root_key_id: u32,
    attack_id: u32,
    release_id: u32,
    sample_start_id: u32,
    sample_end_id: u32,
    sample_id: u32,
    positions_id: u32,
    positions_ptr: u32
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct ReSoul;

impl Instrument for ReSoul {
    type State = ReSoulState;

    fn init(state: &mut ReSoulState, sample_rate: f32) {
        state.sample_rate = sample_rate;
        state.gain = 1.0; // TS defaults; the engine pushes the real values right after
        state.octave = 0;
        state.reverse = false;
        state.root_key = 60;
        state.attack = (0.001 * sample_rate) as u32;
        state.release = (0.1 * sample_rate) as u32;
        state.sample_start = 0.0;
        state.sample_end = 1.0;
        state.sample = None;
        state.gain_id = abi::bind_parameter(&VOLUME_FIELD);
        state.octave_id = abi::bind_parameter(&OCTAVE_FIELD);
        state.reverse_id = abi::bind_parameter(&REVERSE_FIELD);
        state.root_key_id = abi::bind_parameter(&ROOT_KEY_FIELD);
        state.attack_id = abi::bind_parameter(&ATTACK_FIELD);
        state.release_id = abi::bind_parameter(&RELEASE_FIELD);
        state.sample_start_id = abi::bind_parameter(&SAMPLE_START_FIELD);
        state.sample_end_id = abi::bind_parameter(&SAMPLE_END_FIELD);
        state.sample_id = abi::observe_sample(&SAMPLE_POINTER);
        state.positions_id = abi::bind_broadcast(&POSITIONS_PATH, POSITION_SLOTS);
    }

    fn handle_event(state: &mut ReSoulState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let (root_key, octave, reverse) = (state.root_key, state.octave, state.reverse);
            let (attack, release) = (state.attack, state.release);
            if let Some(slot) = state.voices.iter_mut().find(|voice| !voice.is_active()) {
                slot.start(event.id, event.pitch, event.cent, event.velocity, root_key, octave, reverse, attack, release);
            }
        } else if let Some(voice) = state.voices.iter_mut().find(|voice| voice.is_active() && voice.id() == event.id) {
            voice.stop();
        }
    }

    fn process_audio(state: &mut ReSoulState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        let sample = state.sample.and_then(abi::resolve_sample);
        let Some(sample) = sample else {
            for voice in state.voices.iter_mut() {
                voice.force_stop();
            }
            publish_positions(state, 0.0);
            return;
        };
        let left = sample.plane(0);
        let right = if sample.channel_count > 1 {sample.plane(1)} else {left};
        let rate_ratio = sample.sample_rate as f64 / state.sample_rate as f64;
        let gain = state.gain;
        let (sample_start, sample_end) = (state.sample_start, state.sample_end);
        for voice in state.voices.iter_mut() {
            if voice.is_active() && voice.process(out_left, out_right, left, right, rate_ratio, gain, sample_start, sample_end) {
                voice.force_stop();
            }
        }
        publish_positions(state, sample.frame_count as f32);
    }

    fn parameter_changed(state: &mut ReSoulState, id: u32, value: ParamValue) {
        if id == state.gain_id {
            state.gain = db_to_gain(float_value(value, &VOLUME_MAPPING));
        } else if id == state.octave_id {
            state.octave = int_value(value, &OCTAVE_MAPPING);
        } else if id == state.reverse_id {
            state.reverse = bool_value(value);
        } else if id == state.root_key_id {
            state.root_key = int_value(value, &ROOT_KEY_MAPPING);
        } else if id == state.attack_id {
            state.attack = (float_value(value, &ATTACK_MAPPING) * state.sample_rate) as u32;
        } else if id == state.release_id {
            state.release = (float_value(value, &RELEASE_MAPPING) * state.sample_rate) as u32;
        } else if id == state.sample_start_id {
            state.sample_start = float_value(value, &REGION_MAPPING);
        } else if id == state.sample_end_id {
            state.sample_end = float_value(value, &REGION_MAPPING);
        }
    }

    fn sample_changed(state: &mut ReSoulState, id: u32, sample: Option<u32>) {
        if id == state.sample_id {
            state.sample = sample;
        }
    }

    fn reset(state: &mut ReSoulState) {
        for voice in state.voices.iter_mut() {
            voice.force_stop();
        }
    }
}

/// Publish the active read heads (in source frames) to the `[1001]` float broadcast the editor paints as
/// playheads: active positions first, `-1` terminating the list (the TS wire format). Skipped until the
/// engine drains the slot (`broadcast_ptr` stays `0`) or when no UI subscribes.
fn publish_positions(state: &mut ReSoulState, _frame_count: f32) {
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
pub fn render(state: &mut ReSoulState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32], sample_rate: f32) {
    state.sample_rate = sample_rate;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<ReSoul>(state, [&mut *out_left, &mut *out_right], events, &block);
    ReSoul::finish(state, [out_left, out_right]);
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// What the host wires this device as (read at load): an instrument that voices notes into audio.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

/// Bytes the engine must allocate (zeroed) for one instance's state block.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<ReSoulState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<ReSoulState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<ReSoul>(ports);
}

/// Boot hook: bind this device's parameters, its sample reference and the positions broadcast with the
/// host, and stash the sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ReSoul as Instrument>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <ReSoul as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// The sample (its `file` pointer), reactively delivered: `present != 0` means a resident `handle`, `0`
/// means the pointer is unbound.
#[no_mangle]
pub extern "C" fn sample_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    let sample = if present != 0 {Some(handle)} else {None};
    unsafe { abi::with_state(state_ptr, |state| <ReSoul as Instrument>::sample_changed(state, id, sample)) }
}

/// Transport STOP: drop every voice so playback starts silent.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <ReSoul as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    //! The voice DSP is covered in `voice.rs`. Here: with no sample resident (the native `resolve_sample`
    //! stub returns none), the device stays silent and drops voices, mirroring the TS loader-empty behaviour.
    use super::*;

    const SR: f32 = 48_000.0;

    fn note_on(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 1.0, cent: 0.0, duration: 0.0}
    }

    #[test]
    fn silent_without_a_resident_sample() {
        let mut state: ReSoulState = unsafe { core::mem::zeroed() };
        state.sample = Some(1);
        let (mut left, mut right) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        assert_eq!(left.iter().fold(0.0f32, |acc, value| acc.max(value.abs())), 0.0, "no audio until a sample is resident");
    }
}

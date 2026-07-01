//! Nano, a simple one-shot sampler instrument, as a runtime-loadable device: a faithful port of the TS
//! `NanoDeviceProcessor`. It plays ONE loaded sample (its `file` pointer) per note, each voice a pitch-rate
//! read head with linear interpolation and a squared attack/release envelope (see `voice.rs`). It does NOT
//! use the `voicing` framework: voices are a plain fixed pool, pushed on note-on, freed when they finish
//! (the TS `Array<Voice>` with a fixed cap).
//!
//! The sample is resolved through the engine: the device declares its `file` pointer path with
//! `bind_sample`; the engine resolves it to the AudioFileBox, requests the frames (Route F), and pushes the
//! resolved handle through `parameter_changed` under the tagged id. Each block the device calls
//! `resolve_sample(handle)`: `None` while it loads (voices are dropped, as in the TS), the frames once ready.
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(state_ptr, id, kind, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, Block, EventRecord, Instrument, ParamValue, Ports, EVENT_NOTE_ON};
use math::db_to_gain;
use math::value_mapping::{Decibel, Exponential};

mod voice;
use voice::NanoVoice;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const MAX_VOICES: usize = 64;

// The Nano box's field-key paths (the stable schema keys): volume `[10]` (decibel), the sample `file` pointer
// `[15]`, and release `[20]` (seconds, exponential).
const VOLUME_FIELD: [u16; 1] = [10];
const SAMPLE_POINTER: [u16; 1] = [15];
const RELEASE_FIELD: [u16; 1] = [20];

const VOLUME_MAPPING: Decibel = Decibel::default_volume();
const RELEASE_MAPPING: Exponential = Exponential {min: 0.001, max: 8.0}; // seconds

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block: a fixed voice pool,
/// the resolved gain / release, the sample rate, the bound sample handle (+ whether one is bound), and the
/// parameter / sample binding ids the engine pushes against.
pub struct NanoState {
    voices: [NanoVoice; MAX_VOICES],
    gain: f32,
    release: u32, // release length in samples
    sample_rate: f32,
    sample: Option<u32>, // the resolved sample handle while the `file` pointer is bound; `None` when unbound
    gain_id: u32,
    release_id: u32,
    sample_id: u32
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct Nano;

impl Instrument for Nano {
    type State = NanoState;

    fn init(state: &mut NanoState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life
        state.gain = 1.0; // TS defaults; the engine pushes the real values right after
        state.release = sample_rate as u32; // 1 s
        state.sample = None; // no sample until the engine catches up the `file` pointer right after init
        state.gain_id = abi::bind_parameter(&VOLUME_FIELD);
        state.release_id = abi::bind_parameter(&RELEASE_FIELD);
        state.sample_id = abi::observe_sample(&SAMPLE_POINTER);
    }

    fn handle_event(state: &mut NanoState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let sample_rate = state.sample_rate;
            if let Some(slot) = state.voices.iter_mut().find(|voice| !voice.is_active()) {
                slot.start(event.id, event.pitch, event.cent, event.velocity, sample_rate);
            }
        } else if let Some(voice) = state.voices.iter_mut().find(|voice| voice.is_active() && voice.id() == event.id) {
            voice.stop();
        }
    }

    fn process_audio(state: &mut NanoState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        let sample = state.sample.and_then(abi::resolve_sample);
        let Some(sample) = sample else {
            // No sample resident yet (still loading, or none bound): the TS drops the voices when the loader
            // has no data, so free them and stay silent until a sample arrives.
            for voice in state.voices.iter_mut() {
                voice.force_stop();
            }
            return;
        };
        let left = sample.plane(0);
        let right = if sample.channel_count > 1 {sample.plane(1)} else {left};
        let rate_ratio = sample.sample_rate as f64 / state.sample_rate as f64;
        let gain = state.gain;
        let release = state.release;
        for voice in state.voices.iter_mut() {
            if voice.is_active() && voice.process(out_left, out_right, left, right, rate_ratio, gain, release) {
                voice.force_stop();
            }
        }
    }

    fn parameter_changed(state: &mut NanoState, id: u32, value: ParamValue) {
        if id == state.gain_id {
            state.gain = db_to_gain(float_value(value, &VOLUME_MAPPING));
        } else if id == state.release_id {
            state.release = (float_value(value, &RELEASE_MAPPING) * state.sample_rate) as u32;
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
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Nano as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
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

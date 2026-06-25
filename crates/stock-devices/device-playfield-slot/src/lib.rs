//! `device-playfield-slot`, one sample-player slot of the Playfield composite, as a runtime-loadable device:
//! a faithful port of the TS `Playfield/SampleProcessor` + `SampleVoice` voice model. It plays ONE loaded
//! sample (its `file` pointer) with a fixed voice pool: a windowed `start`..`end` read head (reversed when
//! `end < start`), gate modes (Off / On / Loop), and a squared attack / release envelope (see `voice.rs`).
//!
//! In the engine this device is instantiated once per `PlayfieldSampleBox`, with a note filter in front so a
//! slot only sees its own note. Cross-slot behaviour (mute / solo / choke) is the composite's job and is not
//! here; this proves the voice as a single normal instrument first. `polyphone` is per-slot, so it IS here: a
//! monophonic slot force-releases its own voices on retrigger.
//!
//! The sample is resolved through the engine: the device declares its `file` pointer path with `bind_sample`;
//! the engine resolves it (Route F) and pushes the handle through `parameter_changed` under the tagged id.
//! Each block the device calls `resolve_sample(handle)`: `None` while it loads (voices dropped, as in the TS),
//! the frames once ready. A note-on with no resident sample is dropped (the TS empty-loader early return).
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `parameter_changed(state_ptr, id, kind, value)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, int_value, Block, EventRecord, FieldValue, Instrument, ParamValue, Ports, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use math::value_mapping::{Exponential, Linear, LinearInteger};

mod voice;
use voice::SlotVoice;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

/// The slot's fixed per-pad polyphony cap (see `plans/wasm-audio/playfield-composite.md`). TS polyphony is
/// unbounded; a fixed pool is the real-time requirement, with oldest-voice stealing when full.
const MAX_VOICES: usize = 16;

// The PlayfieldSampleBox field-key paths (the stable schema keys, frozen). `file` (the sample pointer),
// `index` (the MIDI note this slot plays, observed as a plain field, NOT a parameter), and the voice
// parameters: `polyphone`, `gate`, `pitch` (cents), `sample-start` / `sample-end` (unipolar), `attack` /
// `release` (seconds). The cross-slot fields (mute / solo / exclude) are the composite's.
const SAMPLE_POINTER: [u16; 1] = [11];
const INDEX_FIELD: [u16; 1] = [15];
// This slot hosts its OWN midi / audio fx chains (it is a composite child): the box keys the composite observes
// and folds the chains around this device. A leaf instrument with no own chains would export 0.
const MIDI_EFFECTS_FIELD: u32 = 12;
const AUDIO_EFFECTS_FIELD: u32 = 13;
const POLYPHONE_FIELD: [u16; 1] = [43];
const GATE_FIELD: [u16; 1] = [44];
const PITCH_FIELD: [u16; 1] = [45];
const SAMPLE_START_FIELD: [u16; 1] = [46];
const SAMPLE_END_FIELD: [u16; 1] = [47];
const ATTACK_FIELD: [u16; 1] = [48];
const RELEASE_FIELD: [u16; 1] = [49];

const GATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
const PITCH_MAPPING: Linear = Linear {min: -1200.0, max: 1200.0}; // cents
const UNIPOLAR: Linear = Linear::unipolar();
const ATTACK_MAPPING: Exponential = Exponential {min: 0.001, max: 5.0}; // seconds
const RELEASE_MAPPING: Exponential = Exponential {min: 0.001, max: 5.0}; // seconds

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block: the fixed voice
/// pool, the engine sample rate, the bound sample handle, the current parameter values the engine pushes (only
/// `pitch` is read per block while a voice runs; the rest are snapshotted at note-on), a monotonic note-on
/// counter for oldest-voice stealing, and the binding ids the engine pushes against.
pub struct PlayfieldSlotState {
    voices: [SlotVoice; MAX_VOICES],
    sample_rate: f32,
    sample: Option<u32>, // the resolved sample handle while the `file` pointer is bound; `None` when unbound
    note_index: i32, // the MIDI note this slot plays; a note-on with a different pitch is ignored. Observed,
    note_index_id: u32,   // not a parameter: the device `observe_field`s `index` and stores the value here.
    gate: i32,
    pitch_cents: f32,
    sample_start: f32,
    sample_end: f32,
    attack_seconds: f32,
    release_seconds: f32,
    polyphone: bool,
    seq: u64,
    gate_id: u32,
    pitch_cents_id: u32,
    sample_start_id: u32,
    sample_end_id: u32,
    attack_seconds_id: u32,
    release_seconds_id: u32,
    polyphone_id: u32,
    sample_id: u32
}

/// The DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]).
pub struct PlayfieldSlot;

impl Instrument for PlayfieldSlot {
    type State = PlayfieldSlotState;

    fn init(state: &mut PlayfieldSlotState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life
        // TS box defaults; the engine pushes the real values right after init.
        state.gate = 0;
        state.pitch_cents = 0.0;
        state.sample_start = 0.0;
        state.sample_end = 1.0;
        state.attack_seconds = 0.001;
        state.release_seconds = 0.020;
        state.polyphone = false;
        state.note_index = 60; // PlayfieldSampleBox default; the engine catches up the real value right after init
        state.note_index_id = abi::observe_field(&INDEX_FIELD); // a plain field observation, NOT a parameter
        state.gate_id = abi::bind_parameter(&GATE_FIELD);
        state.pitch_cents_id = abi::bind_parameter(&PITCH_FIELD);
        state.sample_start_id = abi::bind_parameter(&SAMPLE_START_FIELD);
        state.sample_end_id = abi::bind_parameter(&SAMPLE_END_FIELD);
        state.attack_seconds_id = abi::bind_parameter(&ATTACK_FIELD);
        state.release_seconds_id = abi::bind_parameter(&RELEASE_FIELD);
        state.polyphone_id = abi::bind_parameter(&POLYPHONE_FIELD);
        state.sample = None; // no sample until the engine catches up the `file` pointer right after init
        state.sample_id = abi::observe_sample(&SAMPLE_POINTER);
    }

    fn handle_event(state: &mut PlayfieldSlotState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            // This slot plays only its own note. The composite broadcasts every note to every slot; the slot
            // filters here, by the `index` it observed from its box (so a full instrument, which observes none,
            // would play everything). Choke events are not notes and pass this check.
            if event.pitch as i32 != state.note_index {return}
            // The window is in source frames, so the sample must be resident to start a voice (the TS drops
            // the note when the loader has no data). A two-frame minimum keeps the interpolation in range.
            let sample = state.sample.and_then(abi::resolve_sample);
            let Some(sample) = sample else {return};
            let num_frames = sample.frame_count as usize;
            if num_frames < 2 {return}
            if !state.polyphone {
                for voice in state.voices.iter_mut() {
                    if voice.is_used() {voice.force_release();}
                }
            }
            let seq = state.seq;
            state.seq += 1;
            let index = match state.voices.iter().position(|voice| !voice.is_used()) {
                Some(free) => free,
                None => oldest_voice(&state.voices) // pool full: steal the oldest
            };
            state.voices[index].start(event.id, event.velocity, state.gate, state.attack_seconds,
                state.release_seconds, state.sample_start, state.sample_end, num_frames, state.sample_rate, seq);
        } else if event.kind == EVENT_NOTE_OFF {
            if let Some(voice) = state.voices.iter_mut().find(|voice| voice.is_used() && voice.id() == event.id) {
                voice.release();
            }
        } else if event.kind == EVENT_CHOKE {
            // Choke: another slot in this slot's choke group fired, so force-release every voice here fast.
            for voice in state.voices.iter_mut() {
                if voice.is_used() {
                    voice.force_release();
                }
            }
        }
    }

    fn process_audio(state: &mut PlayfieldSlotState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        let sample = state.sample.and_then(abi::resolve_sample);
        let Some(sample) = sample else {
            // No sample resident yet (still loading, or none bound): drop the voices and stay silent, as the
            // TS does when the loader has no data.
            for voice in state.voices.iter_mut() {
                voice.free();
            }
            return;
        };
        let left = sample.plane(0);
        let right = if sample.channel_count > 1 {sample.plane(1)} else {left};
        let num_frames = sample.frame_count as usize;
        let src_rate = sample.sample_rate;
        let engine_rate = state.sample_rate;
        let pitch = state.pitch_cents; // the one parameter read live while a voice runs
        for voice in state.voices.iter_mut() {
            if voice.is_used() && voice.process(out_left, out_right, left, right, num_frames, src_rate, engine_rate, pitch) {
                voice.free();
            }
        }
    }

    fn parameter_changed(state: &mut PlayfieldSlotState, id: u32, value: ParamValue) {
        if id == state.gate_id {
            state.gate = int_value(value, &GATE_MAPPING);
        } else if id == state.pitch_cents_id {
            state.pitch_cents = float_value(value, &PITCH_MAPPING);
        } else if id == state.sample_start_id {
            state.sample_start = float_value(value, &UNIPOLAR);
        } else if id == state.sample_end_id {
            state.sample_end = float_value(value, &UNIPOLAR);
        } else if id == state.attack_seconds_id {
            state.attack_seconds = float_value(value, &ATTACK_MAPPING);
        } else if id == state.release_seconds_id {
            state.release_seconds = float_value(value, &RELEASE_MAPPING);
        } else if id == state.polyphone_id {
            state.polyphone = bool_value(value);
        }
    }

    fn field_changed(state: &mut PlayfieldSlotState, id: u32, value: FieldValue) {
        // The slot's MIDI note (a plain int32 box field this device observes), delivered on catch-up + edits.
        if id == state.note_index_id {
            state.note_index = match value {
                FieldValue::Int(note) => note,
                _ => panic!("Playfield slot index must be an int field")
            };
        }
    }

    fn sample_changed(state: &mut PlayfieldSlotState, id: u32, sample: Option<u32>) {
        // The slot's sample (its `file` pointer), reactively delivered: a resident handle, or `None` on remove.
        if id == state.sample_id {
            state.sample = sample;
        }
    }

    fn reset(state: &mut PlayfieldSlotState) {
        for voice in state.voices.iter_mut() {
            voice.free();
        }
    }
}

/// The index of the oldest active voice (lowest note-on sequence), stolen when the pool is full.
fn oldest_voice(voices: &[SlotVoice; MAX_VOICES]) -> usize {
    let mut oldest = 0;
    let mut min_seq = voices[0].start_seq();
    for (index, voice) in voices.iter().enumerate() {
        if voice.start_seq() < min_seq {
            min_seq = voice.start_seq();
            oldest = index;
        }
    }
    oldest
}

/// Host-independent entry for tests: clear the stereo output, dispatch the supplied events through the SDK
/// template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead.
pub fn render(state: &mut PlayfieldSlotState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32], sample_rate: f32) {
    state.sample_rate = sample_rate;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<PlayfieldSlot>(state, [&mut *out_left, &mut *out_right], events, &block);
    PlayfieldSlot::finish(state, [out_left, out_right]);
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
    core::mem::size_of::<PlayfieldSlotState>() as u32
}

/// The box field keys hosting this device's OWN midi / audio fx chains when it runs as a composite child. The
/// composite reads these to observe each chain and fold it around the device, so the keys live with the device.
#[no_mangle]
pub extern "C" fn midi_effects_field() -> u32 {
    MIDI_EFFECTS_FIELD
}

#[no_mangle]
pub extern "C" fn audio_effects_field() -> u32 {
    AUDIO_EFFECTS_FIELD
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<PlayfieldSlotState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<PlayfieldSlot>(ports);
}

/// Boot hook: bind this device's parameters + its sample reference with the host, and stash the sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <PlayfieldSlot as Instrument>::init(state, sample_rate)) }
}

/// Apply a parameter value the host resolved (initial / edit / automation, or the sample handle under the
/// tagged sample id), by the id `init` got back.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <PlayfieldSlot as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}

/// Apply an observed plain field's value (its `index`), by the id `observe_field` returned. Driven by the
/// host's `catchup_and_subscribe`, only inside a transaction. The wire `(kind, bits, len)` decodes to a typed
/// `FieldValue` (`len` is the string length for `FIELD_KIND_STRING`, unused otherwise).
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <PlayfieldSlot as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

/// Transport STOP: drop every voice so the slot starts silent.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <PlayfieldSlot as Instrument>::reset(state)) }
}

/// Apply an observed sample reference (its `file` pointer), by the id `observe_sample` returned. Driven by the
/// host's pointer observer; `present != 0` means a resident `handle`, `0` means the pointer is unbound.
#[no_mangle]
pub extern "C" fn sample_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    let sample = if present != 0 {Some(handle)} else {None};
    unsafe { abi::with_state(state_ptr, |state| <PlayfieldSlot as Instrument>::sample_changed(state, id, sample)) }
}

#[cfg(test)]
mod tests {
    //! The voice DSP is covered in `voice.rs`. Here: with no sample resident (the native `resolve_sample` stub
    //! returns none), the device stays silent and drops voices, mirroring the TS loader-empty behaviour.
    use super::*;

    const SR: f32 = 48_000.0;

    fn note_on(id: u32, pitch: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 1.0, cent: 0.0}
    }

    #[test]
    fn silent_without_a_resident_sample() {
        let mut state: PlayfieldSlotState = unsafe { core::mem::zeroed() };
        state.sample = Some(1); // a handle is bound, but the native resolve stub returns none (not resident)
        let (mut left, mut right) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        render(&mut state, &[note_on(1, 60)], &mut left, &mut right, SR);
        assert_eq!(left.iter().fold(0.0f32, |acc, value| acc.max(value.abs())), 0.0, "no audio until a sample is resident");
    }
}

//! Soundfont, a preset-based sampler instrument, as a runtime-loadable device: a faithful port of the TS
//! `SoundfontDeviceProcessor` / `SoundfontVoice`. It does NOT parse `.sf2` — the host delivers a SIMPLIFIED
//! blob (sample table + region table + preset table + normalized f32 PCM, all SF2 generators already resolved
//! on the main thread; see `blob.rs`). The device observes its `file` pointer (`[10]`) via `observe_soundfont`
//! and its `preset-index` field (`[11]`) via `observe_field`; on a note it selects the preset's regions,
//! matches the note's key + velocity, and voices each match (layering) with the ported pitch/envelope/loop DSP.
//!
//! Exports: `kind()` (instrument), `state_size()`, `process(desc_ptr)`, `init(state_ptr, sample_rate)`,
//! `field_changed(...)`, `soundfont_changed(...)`, `reset(state_ptr)`. No parameters (the TS adapter has none).

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{FieldValue, Block, EventRecord, Instrument, Ports, EVENT_NOTE_ON};
use libm::roundf;

mod blob;
mod voice;
use blob::Soundfont;
use voice::SoundfontVoice;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info) // deposit the message in the engine's panic buffer, then trap (never a silent hang)
}

const MAX_VOICES: usize = 128;

/// Free every voice (transport stop, soundfont swap, or an unresolvable blob).
#[inline]
fn force_stop_all(voices: &mut [SoundfontVoice]) {
    for voice in voices.iter_mut() {
        voice.force_stop();
    }
}

// The Soundfont box's field-key paths: the `file` pointer `[10]` (a SoundfontFileBox) and the `preset-index`
// int field `[11]`.
const SOUNDFONT_POINTER: [u16; 1] = [10];
const PRESET_INDEX_FIELD: [u16; 1] = [11];

/// The device's per-instance state (engine-allocated, zeroed): a fixed voice pool, the resolved soundfont blob
/// handle (`None` while the pointer is unbound / loading), the selected preset index, the sample rate, and the
/// observe ids the engine delivers against.
pub struct SoundfontState {
    voices: [SoundfontVoice; MAX_VOICES],
    soundfont: Option<u32>, // the resolved blob handle while the `file` pointer is bound
    preset_index: u32,
    sample_rate: f32,
    soundfont_id: u32,
    preset_field_id: u32
}

pub struct SoundfontDevice;

impl Instrument for SoundfontDevice {
    type State = SoundfontState;

    fn init(state: &mut SoundfontState, sample_rate: f32) {
        state.sample_rate = sample_rate;
        state.soundfont = None;
        state.preset_index = 0;
        state.soundfont_id = abi::observe_soundfont(&SOUNDFONT_POINTER);
        state.preset_field_id = abi::observe_field(&PRESET_INDEX_FIELD);
    }

    fn handle_event(state: &mut SoundfontState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let Some(handle) = state.soundfont else { return };
            let Some(reference) = abi::resolve_soundfont(handle) else { return };
            let Some(soundfont) = Soundfont::new(reference.ptr, reference.bytes()) else { return };
            let Some((region_start, region_count)) = soundfont.preset_regions(state.preset_index) else { return };
            let velocity_byte = (roundf(event.velocity * 127.0) as u32).min(127); // TS `Math.round(velocity*127)`
            let sample_rate = state.sample_rate;
            for region_index in region_start..region_start + region_count {
                let region = soundfont.region(region_index);
                if !region.matches(event.pitch, velocity_byte) {
                    continue;
                }
                let sample = soundfont.sample(region.sample_index);
                // A matching (preset-zone × instrument-zone) region layers a voice, exactly like the TS loop.
                if let Some(slot) = state.voices.iter_mut().find(|voice| !voice.is_active()) {
                    slot.start(event.id, event.pitch, event.cent, event.velocity, &region, &sample, sample_rate);
                }
            }
        } else {
            // Note-off: release EVERY voice this note id spawned (a note may have layered several).
            for voice in state.voices.iter_mut() {
                if voice.is_active() && voice.id() == event.id {
                    voice.release();
                }
            }
        }
    }

    fn process_audio(state: &mut SoundfontState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        // Resolve the blob ONCE per chunk (a cheap ptr+len fetch); each voice reads its own sample plane from it.
        // If the soundfont is unbound / not yet resident, no voice can sound — free them and stay silent. The
        // `reference` is held in a local so the blob slice it lends `Soundfont` lives for the whole render.
        let reference = match state.soundfont.and_then(abi::resolve_soundfont) {
            Some(reference) => reference,
            None => return force_stop_all(&mut state.voices)
        };
        let Some(soundfont) = Soundfont::new(reference.ptr, reference.bytes()) else {
            return force_stop_all(&mut state.voices);
        };
        for voice in state.voices.iter_mut() {
            if voice.is_active() {
                let sample = soundfont.sample(voice.sample_index());
                if voice.process(out_left, out_right, sample.plane()) {
                    voice.force_stop();
                }
            }
        }
    }

    fn field_changed(state: &mut SoundfontState, id: u32, value: FieldValue) {
        if id == state.preset_field_id {
            if let FieldValue::Int(index) = value {
                state.preset_index = index.max(0) as u32;
            }
        }
    }

    fn soundfont_changed(state: &mut SoundfontState, id: u32, soundfont: Option<u32>) {
        // The blob (and its PCM pointers) changed: drop every voice, since active voices reference the old blob.
        if id == state.soundfont_id {
            state.soundfont = soundfont;
            force_stop_all(&mut state.voices);
        }
    }

    fn reset(state: &mut SoundfontState) {
        force_stop_all(&mut state.voices);
    }
}

/// Host-independent entry for tests: clear the stereo output, dispatch the supplied events through the SDK
/// template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead.
pub fn render(state: &mut SoundfontState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32], sample_rate: f32) {
    state.sample_rate = sample_rate;
    for sample in out_left.iter_mut() {
        *sample = 0.0;
    }
    for sample in out_right.iter_mut() {
        *sample = 0.0;
    }
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<SoundfontDevice>(state, [&mut *out_left, &mut *out_right], events, &block);
    SoundfontDevice::finish(state, [out_left, out_right]);
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<SoundfontState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<SoundfontState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<SoundfontDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <SoundfontDevice as Instrument>::init(state, sample_rate)) }
}

/// Apply the observed `preset-index` int field (`[11]`).
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe { abi::with_state(state_ptr, |state| <SoundfontDevice as Instrument>::field_changed(state, id, FieldValue::from_wire(kind, bits, len))) }
}

/// Apply an observed soundfont reference (its `file` pointer), by the id `observe_soundfont` returned.
#[no_mangle]
pub extern "C" fn soundfont_changed(state_ptr: u32, id: u32, handle: u32, present: u32) {
    let soundfont = if present != 0 {Some(handle)} else {None};
    unsafe { abi::with_state(state_ptr, |state| <SoundfontDevice as Instrument>::soundfont_changed(state, id, soundfont)) }
}

/// Transport STOP: drop every voice so playback starts silent.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <SoundfontDevice as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::{MAGIC, PRESET_STRIDE, REGION_STRIDE, SAMPLE_STRIDE};

    const SR: f32 = 48_000.0;

    // Build a one-preset, one-region, one-sample blob over a DC sample (every frame `amp`), so the output traces
    // the envelope directly. `root_key` == the played pitch so the read runs at native rate.
    fn build_blob(frames: usize, amp: f32, root_key: u32, attack: f32, sustain: f32) -> Vec<u8> {
        let header = 32usize;
        let samples_off = header;
        let regions_off = samples_off + SAMPLE_STRIDE;
        let presets_off = regions_off + REGION_STRIDE;
        let pcm_off = presets_off + PRESET_STRIDE;
        let mut bytes = vec![0u8; pcm_off + frames * 4];
        let u = |b: &mut Vec<u8>, off: usize, v: u32| b[off..off + 4].copy_from_slice(&v.to_le_bytes());
        let f = |b: &mut Vec<u8>, off: usize, v: f32| b[off..off + 4].copy_from_slice(&v.to_le_bytes());
        u(&mut bytes, 0, MAGIC);
        u(&mut bytes, 4, 1); // version
        u(&mut bytes, 8, 1); // sample_count
        u(&mut bytes, 12, 1); // region_count
        u(&mut bytes, 16, 1); // preset_count
        u(&mut bytes, 20, samples_off as u32);
        u(&mut bytes, 24, regions_off as u32);
        u(&mut bytes, 28, presets_off as u32);
        // SampleDesc
        u(&mut bytes, samples_off, pcm_off as u32);
        u(&mut bytes, samples_off + 4, frames as u32);
        f(&mut bytes, samples_off + 8, SR);
        u(&mut bytes, samples_off + 12, 0); // loop_start
        u(&mut bytes, samples_off + 16, frames as u32); // loop_end
        // RegionDesc (key 0..127, vel 0..127, sample 0)
        bytes[regions_off] = 0;
        bytes[regions_off + 1] = 127;
        bytes[regions_off + 2] = 0;
        bytes[regions_off + 3] = 127;
        u(&mut bytes, regions_off + 4, 0); // sample_index
        u(&mut bytes, regions_off + 8, root_key);
        u(&mut bytes, regions_off + 12, 0); // loop_mode off
        f(&mut bytes, regions_off + 16, 0.0); // pan center
        f(&mut bytes, regions_off + 20, attack);
        f(&mut bytes, regions_off + 24, 0.005); // decay
        f(&mut bytes, regions_off + 28, sustain);
        f(&mut bytes, regions_off + 32, 0.05); // release
        // PresetDesc: regions [0,1)
        u(&mut bytes, presets_off, 0);
        u(&mut bytes, presets_off + 4, 1);
        // PCM
        for frame in 0..frames {
            f(&mut bytes, pcm_off + frame * 4, amp);
        }
        bytes
    }

    fn note_on(id: u32, pitch: u32, velocity: f32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity, cent: 0.0, duration: 0.0}
    }

    // The blob view is native-safe for the TABLES (region / preset / sample metadata); only `Sample::plane()`
    // dereferences the (wasm) pointer, which these tests avoid — voices are fed a real `&[f32]` plane instead.

    #[test]
    fn selects_matching_region_and_ramps_over_attack() {
        let blob = build_blob(48_000, 0.5, 60, 0.02, 1.0); // 20 ms attack, full sustain
        let soundfont = Soundfont::new(blob.as_ptr() as u32, &blob).expect("valid blob");
        let region = soundfont.region(0);
        assert!(region.matches(60, 100), "note within the region's full key/vel range");
        assert!(!region.matches(60, 128) || region.vel_hi == 127, "velocity above the range would not match");
        let sample = soundfont.sample(region.sample_index);
        let pcm = vec![0.5f32; 48_000]; // the DC plane the blob describes
        let mut voice = SoundfontVoice::default();
        voice.start(1, 60, 0.0, 1.0, &region, &sample, SR);
        let (mut left, mut right) = (vec![0.0f32; 64], vec![0.0f32; 64]);
        assert!(!voice.process(&mut left, &mut right, &pcm), "still sounding");
        assert!(left[0].abs() < 0.02, "starts near silent (attack ramp from 0): {}", left[0]);
        assert!(left[63] > left[0], "ramps up across the attack");
        assert_eq!(left, right, "pan center feeds both channels equally");
    }

    #[test]
    fn a_non_matching_note_selects_no_region() {
        // A region restricted to keys 60..=64; a note at 40 must not match.
        let mut blob = build_blob(64, 1.0, 60, 0.0, 1.0);
        let regions_off = 32 + SAMPLE_STRIDE;
        blob[regions_off] = 60; // key_lo
        blob[regions_off + 1] = 64; // key_hi
        let soundfont = Soundfont::new(blob.as_ptr() as u32, &blob).unwrap();
        let (start, count) = soundfont.preset_regions(0).unwrap();
        let mut matched = 0;
        for index in start..start + count {
            if soundfont.region(index).matches(40, 100) {
                matched += 1;
            }
        }
        assert_eq!(matched, 0, "a note outside the region's key range matches nothing");
    }

    #[test]
    fn out_of_range_preset_index_falls_back_to_preset_zero() {
        let blob = build_blob(64, 1.0, 60, 0.0, 1.0);
        let soundfont = Soundfont::new(blob.as_ptr() as u32, &blob).unwrap();
        assert_eq!(soundfont.preset_regions(99), soundfont.preset_regions(0), "TS `presets[i] ?? presets[0]`");
    }

    #[test]
    fn a_voice_sounds_the_dc_plane_through_the_envelope() {
        let blob = build_blob(48_000, 0.4, 60, 0.001, 1.0);
        let soundfont = Soundfont::new(blob.as_ptr() as u32, &blob).unwrap();
        let region = soundfont.region(0);
        let sample = soundfont.sample(region.sample_index);
        let pcm = vec![0.4f32; 48_000];
        let mut voice = SoundfontVoice::default();
        voice.start(9, 60, 0.0, 1.0, &region, &sample, SR);
        // Render past the 1 ms attack + 3 ms smoothing so the envelope settles to full sustain (1.0).
        let (mut left, mut right) = (vec![0.0f32; 4096], vec![0.0f32; 4096]);
        assert!(!voice.process(&mut left, &mut right, &pcm), "still sounding");
        let peak = left.iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        // Per channel: DC 0.4 * gain 1.0 * sustain 1.0 * constant-power pan center cos(pi/4)=0.707 ~= 0.283.
        assert!((peak - 0.4 * core::f32::consts::FRAC_1_SQRT_2).abs() < 0.01, "settles to the panned DC level: peak {peak}");
        let _ = note_on(9, 60, 1.0);
    }
}

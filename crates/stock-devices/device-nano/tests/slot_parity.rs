//! A migrated Playfield pad: the retired slot player against Nano with the values the migration writes (volume
//! 0 dB, fixed pitch, root key 60, tail on, slot gate Off = one-shot, On = gated, Loop = loop over the region
//! with no crossfade). Both run through their real device paths with the same sample, events and blocks. The
//! envelopes are not bit-identical (the slot holds its level for the attack length after a release, rounds
//! differently, writes one sample less in reverse), so each scenario checks a tolerance on the difference.

use abi::{EventRecord, FieldValue, Instrument, ParamValue, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_nano::{Nano, NanoState};
use device_playfield_sample::{PlayfieldSlot, PlayfieldSlotState};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;

struct Pad {
    gate: i32,
    pitch_cents: f32,
    start: f32,
    end: f32,
    attack: f32,
    release: f32,
    polyphone: bool
}

impl Default for Pad {
    fn default() -> Self {
        Pad {gate: 0, pitch_cents: 0.0, start: 0.0, end: 1.0, attack: 0.001, release: 0.020, polyphone: false}
    }
}

fn sample(handle: u32, frames: usize, sample_rate: f32) {
    let planar: Vec<f32> = (0..frames).map(|index| {
        let time = index as f32 / sample_rate;
        0.6 * libm::sinf(core::f32::consts::TAU * 220.0 * time) + 0.3 * libm::sinf(core::f32::consts::TAU * 1_337.0 * time)
    }).collect();
    abi::set_native_sample(handle, Box::leak(planar.into_boxed_slice()), 1, sample_rate);
}

fn slot(handle: u32, pad: &Pad) -> PlayfieldSlotState {
    let mut state: PlayfieldSlotState = unsafe {core::mem::zeroed()};
    PlayfieldSlot::init(&mut state, SR);
    let set = |state: &mut PlayfieldSlotState, key: u16, value: ParamValue| PlayfieldSlot::parameter_changed(state, abi::native_parameter_id(&[key]), value);
    set(&mut state, 43, ParamValue::Bool(pad.polyphone));
    set(&mut state, 44, ParamValue::Int(pad.gate));
    set(&mut state, 45, ParamValue::Float(pad.pitch_cents));
    set(&mut state, 46, ParamValue::Float(pad.start));
    set(&mut state, 47, ParamValue::Float(pad.end));
    set(&mut state, 48, ParamValue::Float(pad.attack));
    set(&mut state, 49, ParamValue::Float(pad.release));
    PlayfieldSlot::field_changed(&mut state, abi::observe_field(&[15]), FieldValue::Int(60));
    PlayfieldSlot::sample_changed(&mut state, abi::observe_sample(&[11]), Some(handle));
    state
}

fn nano(handle: u32, pad: &Pad) -> NanoState {
    let mut state: NanoState = unsafe {core::mem::zeroed()};
    Nano::init(&mut state, SR);
    let set = |state: &mut NanoState, key: u16, value: ParamValue| Nano::parameter_changed(state, abi::native_parameter_id(&[key]), value);
    set(&mut state, 10, ParamValue::Float(0.0));
    set(&mut state, 13, ParamValue::Float(pad.pitch_cents));
    set(&mut state, 14, ParamValue::Int(60));
    set(&mut state, 20, ParamValue::Float(pad.release));
    set(&mut state, 21, ParamValue::Float(pad.attack));
    set(&mut state, 22, ParamValue::Float(pad.start));
    set(&mut state, 23, ParamValue::Float(pad.end));
    set(&mut state, 24, ParamValue::Bool(pad.gate == 2));
    set(&mut state, 25, ParamValue::Float(0.001));
    set(&mut state, 26, ParamValue::Float(0.0));
    set(&mut state, 27, ParamValue::Float(1.0));
    set(&mut state, 29, ParamValue::Bool(pad.polyphone));
    set(&mut state, 30, ParamValue::Bool(pad.gate == 0));
    set(&mut state, 31, ParamValue::Bool(true));
    set(&mut state, 32, ParamValue::Bool(true));
    Nano::sample_changed(&mut state, abi::observe_sample(&[15]), Some(handle));
    state
}

fn note(kind: u32, id: u32, at: usize) -> (usize, EventRecord) {
    (at, EventRecord {position: 0.0, offset: 0, kind, id, pitch: 60, velocity: 0.8, cent: 0.0, duration: 0.0})
}

fn blocks(events: &[(usize, EventRecord)], frames: usize, mut render: impl FnMut(&[EventRecord], &mut [f32], &mut [f32])) -> Vec<f32> {
    let mut output = Vec::with_capacity(frames);
    let mut start = 0;
    while start < frames {
        let length = BLOCK.min(frames - start);
        let block_events: Vec<EventRecord> = events.iter().filter(|(at, _)| (start..start + length).contains(at))
            .map(|(at, record)| EventRecord {offset: (at - start) as u32, ..*record}).collect();
        let (mut left, mut right) = (vec![0.0f32; length], vec![0.0f32; length]);
        render(&block_events, &mut left, &mut right);
        output.extend_from_slice(&left);
        start += length;
    }
    output
}

fn render_both(handle: u32, pad: &Pad, events: &[(usize, EventRecord)], frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut slot_state = slot(handle, pad);
    let mut nano_state = nano(handle, pad);
    let expected = blocks(events, frames, |events, left, right| device_playfield_sample::render(&mut slot_state, events, left, right, SR));
    let actual = blocks(events, frames, |events, left, right| device_nano::render(&mut nano_state, events, left, right, SR));
    (expected, actual)
}

/// Renders both and returns (rms of the difference relative to the slot's rms, peak difference).
fn compare(handle: u32, pad: Pad, events: &[(usize, EventRecord)], frames: usize) -> (f32, f32) {
    let (expected, actual) = render_both(handle, &pad, events, frames);
    measure(&expected, &actual)
}

fn measure(expected: &[f32], actual: &[f32]) -> (f32, f32) {
    let energy = expected.iter().map(|value| value * value).sum::<f32>();
    assert!(energy > 1.0, "the slot plays");
    let difference = expected.iter().zip(actual).map(|(slot, nano)| (slot - nano) * (slot - nano)).sum::<f32>();
    let peak = expected.iter().zip(actual).fold(0.0f32, |acc, (slot, nano)| acc.max((slot - nano).abs()));
    ((difference / energy).sqrt(), peak)
}

fn assert_close(name: &str, (relative, peak): (f32, f32)) {
    assert!(relative < 0.02 && peak < 0.07, "{name}: relative rms {relative}, peak {peak}");
}

// A forced release: the slot holds its level for the attack length before the 5 ms fade, Nano fades at once.
fn assert_forced_release_close(name: &str, (relative, peak): (f32, f32)) {
    assert!(relative < 0.05 && peak < 0.25, "{name}: relative rms {relative}, peak {peak}");
}

#[test]
fn gate_off_plays_the_whole_sample_and_ignores_the_note_off() {
    sample(1, 24_000, SR);
    assert_close("gate off", compare(1, Pad::default(), &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_OFF, 1, 1_000)], 30_000));
}

#[test]
fn gate_off_rings_its_release_past_a_chop_end() {
    sample(2, 48_000, SR);
    let pad = Pad {start: 0.25, end: 0.5, release: 0.3, ..Pad::default()};
    assert_close("chop tail", compare(2, pad, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_OFF, 1, 100)], 36_000));
}

#[test]
fn gate_on_releases_on_the_note_off() {
    sample(3, 48_000, SR);
    let pad = Pad {gate: 1, release: 0.1, ..Pad::default()};
    assert_close("gate on", compare(3, pad, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_OFF, 1, 10_000)], 20_000));
}

#[test]
fn gate_on_fades_out_at_the_region_end() {
    sample(4, 48_000, SR);
    let pad = Pad {gate: 1, end: 0.3, ..Pad::default()};
    assert_close("gate on end", compare(4, pad, &[note(EVENT_NOTE_ON, 1, 0)], 20_000));
}

#[test]
fn gate_loop_cycles_the_region_until_the_note_off() {
    sample(5, 48_000, SR);
    let pad = Pad {gate: 2, start: 0.1, end: 0.2, release: 0.05, ..Pad::default()};
    let (expected, actual) = render_both(5, &pad, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_OFF, 1, 40_000)], 46_000);
    // Nano's minimum 1 ms crossfade shortens each cycle by 48 frames, so only the first cycle lines up
    assert_close("first loop cycle", measure(&expected[..4_700], &actual[..4_700]));
    let audible = |buffer: &[f32]| buffer.iter().any(|value| value.abs() > 0.1);
    assert!(audible(&actual[35_000..40_000]), "the pad keeps looping until the note-off");
    assert!(!audible(&actual[44_000..]), "the release ends the loop");
}

#[test]
fn a_reversed_window_plays_backwards() {
    sample(6, 48_000, SR);
    let pad = Pad {start: 0.6, end: 0.2, ..Pad::default()};
    assert_close("reverse", compare(6, pad, &[note(EVENT_NOTE_ON, 1, 0)], 34_000));
}

#[test]
fn a_mono_retrigger_fades_the_first_note() {
    sample(7, 48_000, SR);
    assert_forced_release_close("mono", compare(7, Pad::default(), &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_ON, 2, 3_000)], 12_000));
}

#[test]
fn poly_notes_overlap() {
    sample(8, 48_000, SR);
    let pad = Pad {polyphone: true, ..Pad::default()};
    assert_close("poly", compare(8, pad, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_ON, 2, 3_000)], 12_000));
}

#[test]
fn a_choke_fades_out_fast() {
    sample(9, 48_000, SR);
    let choke = EventRecord {position: 0.0, offset: 0, kind: EVENT_CHOKE, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
    assert_forced_release_close("choke", compare(9, Pad::default(), &[note(EVENT_NOTE_ON, 1, 0), (5_000, choke)], 8_000));
}

#[test]
fn the_pitch_transposes_the_rate() {
    sample(10, 48_000, SR);
    let pad = Pad {pitch_cents: 700.0, ..Pad::default()};
    assert_close("pitch", compare(10, pad, &[note(EVENT_NOTE_ON, 1, 0)], 34_000));
}

#[test]
fn a_sample_at_another_rate_reads_resampled() {
    sample(11, 44_100, 44_100.0);
    assert_close("resample", compare(11, Pad::default(), &[note(EVENT_NOTE_ON, 1, 0)], 50_000));
}

#[test]
fn a_long_attack_and_release() {
    sample(12, 96_000, SR);
    let pad = Pad {gate: 1, attack: 0.2, release: 0.5, ..Pad::default()};
    let (expected, actual) = render_both(12, &pad, &[note(EVENT_NOTE_ON, 1, 0), note(EVENT_NOTE_OFF, 1, 30_000)], 72_000);
    assert_close("long attack", measure(&expected[..30_000], &actual[..30_000]));
    let delay = (0.2 * SR) as usize; // the slot holds its level for the attack length after the note-off
    let last = |buffer: &[f32]| buffer.iter().rposition(|value| value.abs() > 1.0e-4).unwrap();
    let offset = last(&expected) as i64 - last(&actual) as i64 - delay as i64;
    assert!(offset.abs() < 100, "the release ends the attack length earlier, off by {offset}");
}

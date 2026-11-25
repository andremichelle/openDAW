//! The play modes through the real device path (init -> parameters -> sample -> events -> render): pan with the
//! channel strip's law and 5 ms glide, mono retrigger, choke, voice stealing and one-shot.

use abi::{EventRecord, Instrument, ParamValue, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_nano::{render, Nano, NanoState};

const SR: f32 = 48_000.0;
const VOLUME: [u16; 1] = [10];
const ATTACK: [u16; 1] = [21];
const PANNING: [u16; 1] = [28];
const POLYPHONE: [u16; 1] = [29];
const ONE_SHOT: [u16; 1] = [30];

fn nano(handle: u32, frames: usize) -> NanoState {
    let planar: &'static [f32] = Box::leak(vec![1.0f32; frames].into_boxed_slice());
    abi::set_native_sample(handle, planar, 1, SR);
    let mut state: NanoState = unsafe {core::mem::zeroed()};
    Nano::init(&mut state, SR);
    set(&mut state, &VOLUME, ParamValue::Float(0.0));
    set(&mut state, &ATTACK, ParamValue::Float(0.001));
    Nano::sample_changed(&mut state, abi::observe_sample(&[15]), Some(handle));
    state
}

fn set(state: &mut NanoState, path: &[u16], value: ParamValue) {
    Nano::parameter_changed(state, abi::native_parameter_id(path), value);
}

fn event(kind: u32, id: u32, offset: u32, velocity: f32) -> EventRecord {
    EventRecord {position: 0.0, offset, kind, id, pitch: 60, velocity, cent: 0.0, duration: 0.0}
}

fn block(state: &mut NanoState, events: &[EventRecord], frames: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    render(state, events, &mut left, &mut right, SR);
    (left, right)
}

fn peak(buffer: &[f32]) -> f32 {
    buffer.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
}

#[test]
fn a_pan_set_before_playback_applies_at_once() {
    let mut state = nano(21, 48_000);
    set(&mut state, &PANNING, ParamValue::Float(-0.5));
    let (left, right) = block(&mut state, &[event(EVENT_NOTE_ON, 1, 0, 1.0)], 512);
    assert_eq!(left[200], 1.0, "panning left keeps the left side");
    assert_eq!(right[200], 0.5, "and lowers the right linearly");
}

#[test]
fn a_centred_pan_leaves_both_sides_untouched() {
    let mut state = nano(22, 48_000);
    set(&mut state, &PANNING, ParamValue::Float(0.0));
    let (left, right) = block(&mut state, &[event(EVENT_NOTE_ON, 1, 0, 0.7)], 512);
    assert_eq!(left, right);
    assert_eq!(left[200], 0.7);
}

#[test]
fn a_pan_move_while_playing_glides_over_five_ms() {
    let mut state = nano(23, 48_000);
    block(&mut state, &[event(EVENT_NOTE_ON, 1, 0, 1.0)], 512);
    set(&mut state, &PANNING, ParamValue::Float(1.0));
    let (left, right) = block(&mut state, &[], 512);
    assert!(left[0] < 1.0 && left[0] > 0.99, "the glide starts at once");
    assert!((left[119] - 0.5).abs() < 0.01, "half way after 2.5 ms");
    assert_eq!(peak(&left[240..]), 0.0, "fully right after 240 samples");
    assert_eq!(right[511], 1.0);
}

#[test]
fn mono_fades_the_sounding_note_out_on_a_new_note() {
    let mut poly = nano(24, 48_000);
    let (left, _) = block(&mut poly, &[event(EVENT_NOTE_ON, 1, 0, 1.0), event(EVENT_NOTE_ON, 2, 100, 1.0)], 1_024);
    assert!((left[1_000] - 2.0).abs() < 1.0e-6, "poly sums both notes");
    let mut mono = nano(25, 48_000);
    set(&mut mono, &POLYPHONE, ParamValue::Bool(false));
    let (left, _) = block(&mut mono, &[event(EVENT_NOTE_ON, 1, 0, 1.0), event(EVENT_NOTE_ON, 2, 100, 1.0)], 1_024);
    assert!((left[1_000] - 1.0).abs() < 1.0e-6, "mono keeps one note once the 5 ms fade passed");
    assert!(left[100..340].iter().all(|value| *value <= 2.0), "the hand-over never exceeds both notes");
}

#[test]
fn a_choke_fades_every_voice_out_in_five_ms() {
    let mut state = nano(26, 48_000);
    block(&mut state, &[event(EVENT_NOTE_ON, 1, 0, 1.0), event(EVENT_NOTE_ON, 2, 0, 1.0)], 512);
    let (left, _) = block(&mut state, &[event(EVENT_CHOKE, 0, 0, 0.0)], 512);
    assert!(left[0] > 1.9 && left[0] <= 2.0, "the fade starts from the current level");
    assert_eq!(peak(&left[241..]), 0.0, "silent after 5 ms");
}

#[test]
fn a_full_pool_steals_the_oldest_voice() {
    let mut state = nano(27, 48_000);
    let mut events: Vec<EventRecord> = (0..64).map(|id| event(EVENT_NOTE_ON, id, 0, 0.0)).collect();
    events.push(event(EVENT_NOTE_ON, 64, 0, 1.0));
    let (left, _) = block(&mut state, &events, 512);
    assert!((left[200] - 1.0).abs() < 1.0e-6, "the 65th note sounds in place of the oldest");
}

#[test]
fn a_one_shot_plays_on_after_the_note_off() {
    let mut state = nano(28, 4_800);
    set(&mut state, &ONE_SHOT, ParamValue::Bool(true));
    let (left, _) = block(&mut state, &[event(EVENT_NOTE_ON, 1, 0, 1.0), event(EVENT_NOTE_OFF, 1, 256, 0.0)], 4_096);
    assert_eq!(left[4_000], 1.0, "the note-off is ignored");
    let (left, _) = block(&mut state, &[], 1_024);
    assert_eq!(peak(&left[800..]), 0.0, "the region end frees the voice");
}

//! A sample resident as 16 bit PCM must play bit for bit like the same sample resident as the floats a 16 bit
//! WAV decodes to, in Nano and in a Playfield slot. Both are registered side by side.

use abi::{EventRecord, FieldValue, Instrument, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_nano::{Nano, NanoState};
use device_playfield_sample::{PlayfieldSlot, PlayfieldSlotState};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;
const FRAMES: usize = 9_000;

// handles: (floats, ints) per content
const STEREO: (u32, u32) = (1, 2);
const MONO: (u32, u32) = (3, 4);
const SLOW: (u32, u32) = (5, 6);

fn register(pair: (u32, u32), channels: u32, rate: f32, mut seed: u32) {
    let planar: Vec<i16> = (0..FRAMES * channels as usize).map(|_| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 16) as i16
    }).collect();
    let floats: Vec<f32> = planar.iter().map(|value| *value as f32 / 32768.0).collect();
    abi::set_native_sample(pair.0, Box::leak(floats.into_boxed_slice()), channels, rate);
    abi::set_native_sample_i16(pair.1, Box::leak(planar.into_boxed_slice()), channels, rate);
}

fn samples() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        register(STEREO, 2, SR, 0x1357_9BDF);
        register(MONO, 1, SR, 0x2468_ACE0);
        register(SLOW, 2, 44_100.0, 0x0F1E_2D3C);
    });
}

fn events() -> Vec<(usize, EventRecord)> {
    let note = |kind: u32, id: u32, pitch: u32, at: usize| (at, EventRecord {position: 0.0, offset: 0, kind, id, pitch, velocity: 0.8, cent: 0.0, duration: 0.0});
    vec![note(EVENT_NOTE_ON, 1, 60, 0), note(EVENT_NOTE_ON, 2, 65, 700), note(EVENT_NOTE_OFF, 1, 60, 2_600), note(EVENT_NOTE_OFF, 2, 65, 3_100)]
}

fn blocks(frames: usize, mut render: impl FnMut(&[EventRecord], &mut [f32], &mut [f32])) -> Vec<u32> {
    let events = events();
    let mut bits = Vec::with_capacity(frames * 2);
    let mut start = 0;
    while start < frames {
        let length = BLOCK.min(frames - start);
        let block_events: Vec<EventRecord> = events.iter().filter(|(at, _)| (start..start + length).contains(at))
            .map(|(at, record)| EventRecord {offset: (at - start) as u32, ..*record}).collect();
        let (mut left, mut right) = (vec![0.0f32; length], vec![0.0f32; length]);
        render(&block_events, &mut left, &mut right);
        bits.extend(left.iter().chain(right.iter()).map(|value| value.to_bits()));
        start += length;
    }
    bits
}

fn nano(handle: u32, params: &[(u16, ParamValue)]) -> Vec<u32> {
    samples();
    let mut state: NanoState = unsafe {core::mem::zeroed()};
    Nano::init(&mut state, SR);
    Nano::parameter_changed(&mut state, abi::native_parameter_id(&[10]), ParamValue::Float(0.0));
    Nano::parameter_changed(&mut state, abi::native_parameter_id(&[14]), ParamValue::Int(60));
    Nano::parameter_changed(&mut state, abi::native_parameter_id(&[29]), ParamValue::Bool(true));
    for (key, value) in params {Nano::parameter_changed(&mut state, abi::native_parameter_id(&[*key]), *value);}
    Nano::sample_changed(&mut state, abi::observe_sample(&[15]), Some(handle));
    blocks(6_000, |events, left, right| device_nano::render(&mut state, events, left, right, SR))
}

fn slot(handle: u32, params: &[(u16, ParamValue)]) -> Vec<u32> {
    samples();
    let mut state: PlayfieldSlotState = unsafe {core::mem::zeroed()};
    PlayfieldSlot::init(&mut state, SR);
    PlayfieldSlot::parameter_changed(&mut state, abi::native_parameter_id(&[43]), ParamValue::Bool(true));
    for (key, value) in params {PlayfieldSlot::parameter_changed(&mut state, abi::native_parameter_id(&[*key]), *value);}
    PlayfieldSlot::field_changed(&mut state, abi::observe_field(&[15]), FieldValue::Int(60));
    PlayfieldSlot::sample_changed(&mut state, abi::observe_sample(&[11]), Some(handle));
    blocks(6_000, |events, left, right| device_playfield_sample::render(&mut state, events, left, right, SR))
}

fn assert_same(name: &str, as_floats: Vec<u32>, as_ints: Vec<u32>) {
    assert!(as_floats.iter().any(|value| f32::from_bits(*value) != 0.0), "{name}: silent, the comparison would prove nothing");
    assert_eq!(as_ints, as_floats, "{name}: 16 bit frames must render bit-identical");
}

fn nano_same(name: &str, pair: (u32, u32), params: &[(u16, ParamValue)]) {
    assert_same(name, nano(pair.0, params), nano(pair.1, params));
}

fn slot_same(name: &str, pair: (u32, u32), params: &[(u16, ParamValue)]) {
    assert_same(name, slot(pair.0, params), slot(pair.1, params));
}

#[test]
fn nano_plain() {nano_same("plain", STEREO, &[]);}

#[test]
fn nano_mono() {nano_same("mono", MONO, &[(28, ParamValue::Float(0.3))]);}

#[test]
fn nano_at_another_sample_rate() {nano_same("44.1k", SLOW, &[]);}

#[test]
fn nano_tuned() {nano_same("tuned", STEREO, &[(13, ParamValue::Float(0.61)), (11, ParamValue::Int(-1))]);}

#[test]
fn nano_backwards() {nano_same("backwards", STEREO, &[(22, ParamValue::Float(0.9)), (23, ParamValue::Float(0.1))]);}

#[test]
fn nano_looped_with_a_crossfade() {
    nano_same("loop", STEREO, &[(24, ParamValue::Bool(true)), (25, ParamValue::Float(0.4)), (26, ParamValue::Float(0.2)),
        (27, ParamValue::Float(0.5)), (13, ParamValue::Float(0.55))]);
}

#[test]
fn nano_looped_backwards() {
    nano_same("loop backwards", STEREO, &[(22, ParamValue::Float(0.95)), (23, ParamValue::Float(0.05)), (24, ParamValue::Bool(true)),
        (25, ParamValue::Float(0.3)), (26, ParamValue::Float(0.3)), (27, ParamValue::Float(0.7))]);
}

#[test]
fn nano_one_shot_with_a_tail() {
    nano_same("one shot", STEREO, &[(30, ParamValue::Bool(true)), (32, ParamValue::Bool(true)), (23, ParamValue::Float(0.4))]);
}

#[test]
fn slot_gate_off() {slot_same("gate off", STEREO, &[(44, ParamValue::Int(0))]);}

#[test]
fn slot_gate_on_pitched() {slot_same("gate on", STEREO, &[(44, ParamValue::Int(1)), (45, ParamValue::Float(0.62))]);}

#[test]
fn slot_gate_loop() {
    slot_same("gate loop", STEREO, &[(44, ParamValue::Int(2)), (46, ParamValue::Float(0.2)), (47, ParamValue::Float(0.45))]);
}

#[test]
fn slot_reversed() {slot_same("reversed", STEREO, &[(44, ParamValue::Int(1)), (46, ParamValue::Float(0.8)), (47, ParamValue::Float(0.1))]);}

#[test]
fn slot_mono_at_another_rate() {
    slot_same("mono", MONO, &[(45, ParamValue::Float(0.4))]);
    slot_same("44.1k", SLOW, &[]);
}

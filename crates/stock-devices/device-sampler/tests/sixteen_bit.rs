//! A sample resident as 16 bit PCM must play bit for bit like the same sample resident as the floats a 16 bit
//! WAV decodes to. Both are registered side by side and rendered through the real device path.

use abi::{EventRecord, Instrument, ParamValue, Table, EVENT_NOTE_OFF, EVENT_NOTE_ON, TABLE_NONE};
use device_sampler::zones::{Zone, ZONE_COLUMNS};
use device_sampler::{render, Sampler, SamplerState};

const SR: f32 = 48_000.0;
const FLOATS: u32 = 1;
const INTS: u32 = 2;
const SLOW_FLOATS: u32 = 3;
const SLOW_INTS: u32 = 4;
const MONO_FLOATS: u32 = 5;
const MONO_INTS: u32 = 6;
const FRAMES: usize = 6_000;
const AMP_ATTACK: [u16; 2] = [50, 2];
const AMP_RELEASE: [u16; 2] = [50, 6];
const GLIDE: [u16; 1] = [21];
const TUNE: [u16; 1] = [25];

fn noise(frames: usize, mut seed: u32) -> Vec<i16> {
    (0..frames).map(|_| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 16) as i16
    }).collect()
}

fn register(floats: u32, ints: u32, planar: Vec<i16>, channels: u32, rate: f32) {
    let as_floats: Vec<f32> = planar.iter().map(|value| *value as f32 / 32768.0).collect();
    abi::set_native_sample(floats, Box::leak(as_floats.into_boxed_slice()), channels, rate);
    abi::set_native_sample_i16(ints, Box::leak(planar.into_boxed_slice()), channels, rate);
}

fn samples() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        register(FLOATS, INTS, noise(FRAMES * 2, 0x1234_5678), 2, SR);
        register(SLOW_FLOATS, SLOW_INTS, noise(FRAMES * 2, 0x0BAD_F00D), 2, 44_100.0);
        register(MONO_FLOATS, MONO_INTS, noise(FRAMES, 0x00C0_FFEE), 1, SR);
    });
}

fn zone(sample: u32) -> Zone {
    Zone {
        sample: Some(sample), group: None, enabled: true, key_low: 0, key_high: 127, key_fade: 0, root_key: 60, velocity_low: 1,
        velocity_high: 127, velocity_fade: 0, transpose: 0, tune: 0.0, key_track: 1.0, gain: 0.0, panning: 0.0,
        sequence: 1, reverse: false, one_shot: false, sample_start: 0, sample_end: i32::MAX, loop_mode: 0,
        loop_start: 0, loop_end: i32::MAX, loop_fade: 0.0, loop_alternate: false
    }
}

fn words(zone: &Zone) -> [u32; 25] {
    [
        zone.sample.unwrap_or(TABLE_NONE), zone.group.unwrap_or(TABLE_NONE), zone.enabled as u32,
        zone.key_low as u32, zone.key_high as u32, zone.key_fade as u32, zone.root_key as u32,
        zone.velocity_low as u32, zone.velocity_high as u32, zone.velocity_fade as u32,
        zone.transpose as u32, zone.tune.to_bits(), zone.key_track.to_bits(),
        zone.gain.to_bits(), zone.panning.to_bits(), zone.sequence as u32, zone.reverse as u32, zone.one_shot as u32,
        zone.sample_start as u32, zone.sample_end as u32, zone.loop_mode as u32, zone.loop_start as u32,
        zone.loop_end as u32, zone.loop_fade.to_bits(), zone.loop_alternate as u32
    ]
}

fn event(kind: u32, id: u32, key: u32, offset: u32) -> EventRecord {
    EventRecord {position: 0.0, offset, kind, id, pitch: key, velocity: 0.8, cent: 0.0, duration: 0.0}
}

// plays the zone on `sample`: a note, a second one a fifth up, both released, in blocks of 128
fn play(sample: u32, shape: &Zone, setup: &dyn Fn(&mut SamplerState)) -> Vec<u32> {
    samples();
    let mut state: Box<SamplerState> = unsafe { Box::new(core::mem::zeroed()) };
    Sampler::init(&mut state, SR);
    Sampler::parameter_changed(&mut state, abi::native_parameter_id(&AMP_ATTACK), ParamValue::Float(0.0));
    setup(&mut state);
    let flat: Vec<u32> = words(&Zone {sample: Some(sample), ..*shape}).to_vec();
    Sampler::table_changed(&mut state, 0, Table::from_words(Box::leak(flat.into_boxed_slice()), ZONE_COLUMNS.len() as u32));
    let mut bits = Vec::new();
    for block in 0..40 {
        let events: Vec<EventRecord> = match block {
            0 => vec![event(EVENT_NOTE_ON, 1, 60, 0)],
            4 => vec![event(EVENT_NOTE_ON, 2, 67, 17)],
            20 => vec![event(EVENT_NOTE_OFF, 1, 60, 5)],
            24 => vec![event(EVENT_NOTE_OFF, 2, 67, 0)],
            _ => Vec::new()
        };
        let (mut left, mut right) = (vec![0.0f32; 128], vec![0.0f32; 128]);
        render(&mut state, &events, &mut left, &mut right);
        bits.extend(left.iter().chain(right.iter()).map(|value| value.to_bits()));
    }
    bits
}

fn assert_same(name: &str, floats: u32, ints: u32, shape: Zone, setup: &dyn Fn(&mut SamplerState)) {
    let as_floats = play(floats, &shape, setup);
    let as_ints = play(ints, &shape, setup);
    assert!(as_floats.iter().any(|value| f32::from_bits(*value) != 0.0), "{name}: silent, the comparison would prove nothing");
    assert_eq!(as_ints, as_floats, "{name}: 16 bit frames must render bit-identical");
}

fn plain(_state: &mut SamplerState) {}

#[test]
fn at_the_root_key() {assert_same("root", FLOATS, INTS, zone(0), &plain);}

#[test]
fn transposed_so_every_read_interpolates() {
    assert_same("tuned", FLOATS, INTS, Zone {root_key: 55, tune: 37.0, transpose: -3, ..zone(0)}, &plain);
}

#[test]
fn at_another_sample_rate() {assert_same("44.1k", SLOW_FLOATS, SLOW_INTS, zone(0), &plain);}

#[test]
fn a_mono_sample() {assert_same("mono", MONO_FLOATS, MONO_INTS, Zone {panning: -0.4, ..zone(0)}, &plain);}

#[test]
fn reversed() {assert_same("reverse", FLOATS, INTS, Zone {reverse: true, root_key: 62, ..zone(0)}, &plain);}

#[test]
fn trimmed_and_one_shot() {
    assert_same("trim", FLOATS, INTS, Zone {sample_start: 300, sample_end: 4_100, one_shot: true, ..zone(0)}, &plain);
}

#[test]
fn looped_while_held() {
    assert_same("gate loop", FLOATS, INTS, Zone {loop_mode: 1, loop_start: 500, loop_end: 1_700, root_key: 57, ..zone(0)}, &plain);
}

#[test]
fn looped_with_a_crossfade() {
    assert_same("loop fade", FLOATS, INTS, Zone {loop_mode: 2, loop_start: 900, loop_end: 2_300, loop_fade: 0.008, ..zone(0)}, &plain);
}

#[test]
fn looped_backwards_with_a_crossfade() {
    assert_same("reverse loop fade", FLOATS, INTS,
        Zone {reverse: true, loop_mode: 2, loop_start: 900, loop_end: 2_300, loop_fade: 0.008, root_key: 63, ..zone(0)}, &plain);
}

#[test]
fn looped_alternating() {
    assert_same("alternate", FLOATS, INTS,
        Zone {loop_mode: 2, loop_alternate: true, loop_start: 400, loop_end: 1_100, root_key: 58, ..zone(0)}, &plain);
}

#[test]
fn with_glide_tune_and_a_long_release() {
    assert_same("glide", FLOATS, INTS, zone(0), &|state| {
        Sampler::parameter_changed(state, abi::native_parameter_id(&GLIDE), ParamValue::Float(0.5));
        Sampler::parameter_changed(state, abi::native_parameter_id(&TUNE), ParamValue::Float(0.7));
        Sampler::parameter_changed(state, abi::native_parameter_id(&AMP_RELEASE), ParamValue::Float(0.6));
    });
}

#[test]
fn past_the_end_of_the_sample() {
    assert_same("past end", FLOATS, INTS, Zone {root_key: 36, ..zone(0)}, &plain);
}

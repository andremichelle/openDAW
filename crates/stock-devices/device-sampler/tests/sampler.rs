//! The Sampler through its real path: tables and parameters pushed the way the engine does, notes dispatched
//! at their offsets, audio rendered. The samples are constants and ramps, so the output says which zone
//! played, how loud and how fast.

use abi::{EventRecord, Instrument, ParamValue, Table, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON, TABLE_NONE};
use device_sampler::zones::{Zone, GROUP_COLUMNS, MODULATION_COLUMNS, ZONE_COLUMNS};
use device_sampler::{active_voices, map_parameter, render, Sampler, SamplerState};

const SR: f32 = 48_000.0;
const ONE: u32 = 1; // a constant 1.0
const HALF: u32 = 2; // a constant 0.5
const QUARTER: u32 = 3; // a constant 0.25
const RAMP: u32 = 4; // frame n holds n
const SLOW_RAMP: u32 = 5; // the same ramp at half the engine's rate
const SPLIT: u32 = 6; // stereo, 1.0 left and 0.0 right
const MISSING: u32 = 7; // never registered: a sample that is still loading
const FRAMES: usize = 48_000;

const VOICES: [u16; 1] = [20];
const GLIDE: [u16; 1] = [21];
const LEGATO: [u16; 1] = [22];
const OCTAVE: [u16; 1] = [23];
const TRANSPOSE: [u16; 1] = [24];
const TUNE: [u16; 1] = [25];
const VOLUME: [u16; 1] = [40];
const PANNING: [u16; 1] = [41];
const MONO: [u16; 1] = [42];
const AMP_ATTACK: [u16; 2] = [50, 2];
const AMP_RELEASE: [u16; 2] = [50, 6];
const MOD_ATTACK: [u16; 2] = [51, 2];
const MOD_SUSTAIN: [u16; 2] = [51, 5];
const LFO_RATE: [u16; 2] = [60, 2];

const AMP: i32 = 0;
const MOD: i32 = 1;
const LFO: i32 = 2;
const VELOCITY: i32 = 4;
const KEY: i32 = 5;
const RANDOM: i32 = 6;
const PITCH: i32 = 0;
const GAIN: i32 = 3;
const PAN: i32 = 4;
const START: i32 = 5;
const DEPTH: i32 = 9;

fn samples() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let leak = |frames: Vec<f32>| -> &'static [f32] {Box::leak(frames.into_boxed_slice())};
        abi::set_native_sample(ONE, leak(vec![1.0; FRAMES]), 1, SR);
        abi::set_native_sample(HALF, leak(vec![0.5; FRAMES]), 1, SR);
        abi::set_native_sample(QUARTER, leak(vec![0.25; FRAMES]), 1, SR);
        abi::set_native_sample(RAMP, leak((0..FRAMES).map(|frame| frame as f32).collect()), 1, SR);
        abi::set_native_sample(SLOW_RAMP, leak((0..FRAMES).map(|frame| frame as f32).collect()), 1, SR * 0.5);
        let mut split = vec![1.0; FRAMES];
        split.extend(vec![0.0; FRAMES]);
        abi::set_native_sample(SPLIT, leak(split), 2, SR);
    });
}

fn zone(sample: u32) -> Zone {
    Zone {
        sample: Some(sample), group: None, enabled: true, key_low: 0, key_high: 127, key_fade: 0, root_key: 60, velocity_low: 1,
        velocity_high: 127, velocity_fade: 0, transpose: 0, tune: 0.0, key_track: 1.0, gain: 0.0, panning: 0.0,
        sequence: 1, reverse: false, one_shot: false, sample_start: 0, sample_end: i32::MAX, loop_mode: 0,
        loop_start: 0, loop_end: i32::MAX, loop_fade: 0.0
    }
}

fn words(zone: &Zone) -> [u32; 24] {
    [
        zone.sample.unwrap_or(TABLE_NONE), zone.group.unwrap_or(TABLE_NONE), zone.enabled as u32,
        zone.key_low as u32, zone.key_high as u32, zone.key_fade as u32, zone.root_key as u32,
        zone.velocity_low as u32, zone.velocity_high as u32, zone.velocity_fade as u32,
        zone.transpose as u32, zone.tune.to_bits(), zone.key_track.to_bits(),
        zone.gain.to_bits(), zone.panning.to_bits(), zone.sequence as u32, zone.reverse as u32, zone.one_shot as u32,
        zone.sample_start as u32, zone.sample_end as u32, zone.loop_mode as u32, zone.loop_start as u32,
        zone.loop_end as u32, zone.loop_fade.to_bits()
    ]
}

fn leaked(words: Vec<u32>, columns: usize) -> Table {
    if words.is_empty() {
        return unsafe { Table::from_wire(0, 0, columns as u32) };
    }
    Table::from_words(Box::leak(words.into_boxed_slice()), columns as u32)
}

struct Rig {
    state: Box<SamplerState>
}

impl Rig {
    fn new() -> Self {
        samples();
        let mut state: Box<SamplerState> = unsafe { Box::new(core::mem::zeroed()) };
        Sampler::init(&mut state, SR);
        let mut rig = Self {state};
        rig.set(&AMP_ATTACK, ParamValue::Float(0.0));
        rig
    }

    fn set(&mut self, path: &[u16], value: ParamValue) {
        Sampler::parameter_changed(&mut self.state, abi::native_parameter_id(path), value);
    }

    fn zones(&mut self, zones: &[Zone]) {
        Sampler::table_changed(&mut self.state, 0, leaked(zones.iter().flat_map(words).collect(), ZONE_COLUMNS.len()));
    }

    // index, round robin, choke, trigger
    fn groups(&mut self, groups: &[[i32; 4]]) {
        let flat = groups.iter().flat_map(|row| row.map(|value| value as u32)).collect();
        Sampler::table_changed(&mut self.state, 0, leaked(flat, GROUP_COLUMNS.len()));
    }

    fn slots(&mut self, slots: &[(i32, i32, f32)]) {
        let flat = slots.iter().flat_map(|(source, target, amount)| [*source as u32, *target as u32, amount.to_bits()]).collect();
        Sampler::table_changed(&mut self.state, 0, leaked(flat, MODULATION_COLUMNS.len()));
    }

    fn run(&mut self, events: &[EventRecord], frames: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        render(&mut self.state, events, &mut left, &mut right);
        (left, right)
    }

    fn left(&mut self, events: &[EventRecord], frames: usize) -> Vec<f32> {self.run(events, frames).0}

    // the level a held note settles at, a few frames in
    fn level(&mut self, events: &[EventRecord]) -> f32 {self.left(events, 64)[63]}

    fn voices(&self) -> usize {active_voices(&self.state)}
}

fn event(kind: u32, id: u32, key: u32, velocity: f32, offset: u32) -> EventRecord {
    EventRecord {position: 0.0, offset, kind, id, pitch: key, velocity, cent: 0.0, duration: 0.0}
}
fn on(id: u32, key: u32) -> EventRecord {event(EVENT_NOTE_ON, id, key, 1.0, 0)}
fn on_at(id: u32, key: u32, velocity: f32) -> EventRecord {event(EVENT_NOTE_ON, id, key, velocity, 0)}
fn off(id: u32, key: u32) -> EventRecord {event(EVENT_NOTE_OFF, id, key, 0.0, 0)}

fn close(a: f32, b: f32) -> bool {(a - b).abs() < 1.0e-4}

// the steady step between consecutive frames of a ramp sample, which is the speed it is read at
fn speed(rendered: &[f32]) -> f32 {rendered[40] - rendered[39]}

#[test]
fn without_zones_a_note_is_silent() {
    let mut rig = Rig::new();
    assert_eq!(rig.left(&[on(1, 60)], 64), vec![0.0; 64]);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn a_zone_plays_its_sample() {
    let mut rig = Rig::new();
    rig.zones(&[zone(HALF)]);
    assert_eq!(rig.left(&[on(1, 60)], 32), vec![0.5; 32]);
    assert_eq!(rig.voices(), 1);
}

#[test]
fn a_sample_that_is_still_loading_is_silent_and_holds_no_voice() {
    let mut rig = Rig::new();
    rig.zones(&[zone(MISSING)]);
    assert_eq!(rig.left(&[on(1, 60)], 64), vec![0.0; 64]);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn a_zone_without_a_sample_is_skipped() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample: None, ..zone(ONE)}, zone(QUARTER)]);
    assert_eq!(rig.level(&[on(1, 60)]), 0.25);
    assert_eq!(rig.voices(), 1);
}

#[test]
fn a_disabled_zone_does_not_play() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {enabled: false, ..zone(ONE)}, zone(QUARTER)]);
    assert_eq!(rig.level(&[on(1, 60)]), 0.25);
    assert_eq!(rig.voices(), 1);
}

#[test]
fn the_note_starts_at_its_offset() {
    let mut rig = Rig::new();
    rig.zones(&[zone(ONE)]);
    let rendered = rig.left(&[event(EVENT_NOTE_ON, 1, 60, 1.0, 10)], 20);
    assert_eq!(rendered[..10], [0.0; 10]);
    assert_eq!(rendered[10..], [1.0; 10]);
}

#[test]
fn a_zone_answers_only_its_keys() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {key_low: 48, key_high: 59, ..zone(ONE)}]);
    for (key, sounds) in [(47, false), (48, true), (59, true), (60, false)] {
        let mut rig = Rig {state: rig_state(&rig)};
        assert_eq!(rig.level(&[on(1, key)]) > 0.0, sounds, "key {key}");
    }
}

fn rig_state(rig: &Rig) -> Box<SamplerState> {
    let mut copy: Box<SamplerState> = unsafe { Box::new(core::mem::zeroed()) };
    unsafe { core::ptr::copy_nonoverlapping(&*rig.state as *const SamplerState, &mut *copy as *mut SamplerState, 1); }
    copy
}

#[test]
fn velocity_layers_pick_their_sample() {
    let mut rig = Rig::new();
    rig.zones(&[
        Zone {velocity_low: 1, velocity_high: 42, ..zone(QUARTER)},
        Zone {velocity_low: 43, velocity_high: 84, ..zone(HALF)},
        Zone {velocity_low: 85, velocity_high: 127, ..zone(ONE)}
    ]);
    for (velocity, expected) in [(0.1, 0.25), (42.0 / 127.0, 0.25), (43.0 / 127.0, 0.5), (0.5, 0.5), (85.0 / 127.0, 1.0), (1.0, 1.0)] {
        let mut rig = Rig {state: rig_state(&rig)};
        assert_eq!(rig.level(&[on_at(1, 60, velocity)]), expected, "velocity {velocity}");
    }
}

#[test]
fn zones_on_the_same_note_are_layered() {
    let mut rig = Rig::new();
    rig.zones(&[zone(HALF), zone(QUARTER)]);
    assert_eq!(rig.level(&[on(1, 60)]), 0.75);
    assert_eq!(rig.voices(), 2);
}

fn robin_rig(round_robin: i32) -> Rig {
    let mut rig = Rig::new();
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.groups(&[[7, round_robin, 0, 0]]);
    rig.zones(&[
        Zone {group: Some(7), sequence: 2, ..zone(HALF)},
        Zone {group: Some(7), sequence: 1, ..zone(ONE)},
        Zone {group: Some(7), sequence: 3, ..zone(QUARTER)}
    ]);
    rig
}

// play a note, read its level, let it go
fn hit(rig: &mut Rig, id: u32, key: u32) -> f32 {
    let level = rig.left(&[on(id, key)], 16)[15];
    rig.left(&[off(id, key)], 2_400);
    level
}

#[test]
fn round_robins_take_turns_in_sequence_order() {
    let mut rig = robin_rig(1);
    let levels: Vec<f32> = (0..7).map(|note| hit(&mut rig, note, 60)).collect();
    assert_eq!(levels, [1.0, 0.5, 0.25, 1.0, 0.5, 0.25, 1.0]);
}

#[test]
fn a_stack_takes_turns_across_all_its_keys() {
    let mut rig = robin_rig(1);
    assert_eq!(hit(&mut rig, 1, 60), 1.0);
    assert_eq!(hit(&mut rig, 2, 60), 0.5);
    assert_eq!(hit(&mut rig, 3, 72), 0.25, "another key of the same stack plays the next one");
    assert_eq!(hit(&mut rig, 4, 60), 1.0);
}

#[test]
fn a_group_without_round_robin_plays_all_its_zones() {
    let mut rig = robin_rig(0);
    assert_eq!(hit(&mut rig, 1, 60), 1.75);
}

#[test]
fn random_round_robins_never_repeat() {
    let mut rig = robin_rig(2);
    let levels: Vec<f32> = (0..60).map(|note| hit(&mut rig, note, 60)).collect();
    assert!(levels.windows(2).all(|pair| pair[0] != pair[1]), "{levels:?}");
    for expected in [1.0, 0.5, 0.25] {
        assert!(levels.contains(&expected), "every member gets its turn");
    }
    assert!(levels.iter().all(|level| [1.0, 0.5, 0.25].contains(level)), "one member per note");
}

#[test]
fn a_zone_without_group_ignores_the_round_robins_of_others() {
    let mut rig = robin_rig(1);
    let mut zones = vec![
        Zone {group: Some(7), sequence: 1, ..zone(ONE)}, Zone {group: Some(7), sequence: 2, ..zone(HALF)}
    ];
    zones.push(Zone {gain: -200.0, ..zone(QUARTER)});
    rig.zones(&zones);
    assert_eq!(hit(&mut rig, 1, 60), 1.0);
    assert_eq!(hit(&mut rig, 2, 60), 0.5, "the ungrouped zone on the same range does not join the stack");
}

#[test]
fn a_release_group_plays_when_the_key_is_let_go() {
    let mut rig = Rig::new();
    rig.groups(&[[1, 0, 0, 1]]);
    rig.zones(&[Zone {group: Some(1), ..zone(HALF)}]);
    assert_eq!(rig.level(&[on(1, 60)]), 0.0, "nothing on the attack");
    assert_eq!(rig.voices(), 0);
    assert_eq!(rig.left(&[off(1, 60)], 32)[31], 0.5);
    assert_eq!(rig.voices(), 1);
}

#[test]
fn a_release_sample_answers_to_the_velocity_the_key_was_played_with() {
    let mut rig = Rig::new();
    rig.groups(&[[1, 0, 0, 1]]);
    rig.zones(&[
        Zone {group: Some(1), velocity_low: 1, velocity_high: 63, ..zone(QUARTER)},
        Zone {group: Some(1), velocity_low: 64, velocity_high: 127, ..zone(ONE)}
    ]);
    rig.left(&[on_at(1, 60, 0.2)], 16);
    assert_eq!(rig.left(&[off(1, 60)], 32)[31], 0.25);
}

#[test]
fn a_release_sample_plays_to_its_end_without_a_note_off() {
    let mut rig = Rig::new();
    rig.groups(&[[1, 0, 0, 1]]);
    rig.zones(&[Zone {group: Some(1), sample_end: 100, ..zone(ONE)}]);
    rig.left(&[on(1, 60)], 16);
    let rendered = rig.left(&[off(1, 60)], 200);
    assert_eq!(rendered[99], 1.0);
    assert_eq!(rendered[100], 0.0);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn a_note_off_without_a_note_plays_no_release_sample() {
    let mut rig = Rig::new();
    rig.groups(&[[1, 0, 0, 1]]);
    rig.zones(&[Zone {group: Some(1), ..zone(ONE)}]);
    assert_eq!(rig.left(&[off(9, 60)], 32), vec![0.0; 32]);
}

#[test]
fn attack_and_release_groups_share_a_key() {
    let mut rig = Rig::new();
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.groups(&[[1, 0, 0, 0], [2, 0, 0, 1]]);
    rig.zones(&[Zone {group: Some(1), ..zone(ONE)}, Zone {group: Some(2), ..zone(QUARTER)}]);
    assert_eq!(rig.level(&[on(1, 60)]), 1.0);
    let rendered = rig.left(&[off(1, 60)], 2_400);
    assert_eq!(rendered[2_399], 0.25, "the attack voice fell away, the release sample holds");
}

fn choke_rig() -> Rig {
    let mut rig = Rig::new();
    rig.groups(&[[1, 0, 5, 0], [2, 0, 5, 0], [3, 0, 6, 0], [4, 0, 0, 0]]);
    rig.zones(&[
        Zone {group: Some(1), key_low: 42, key_high: 42, one_shot: true, ..zone(ONE)},
        Zone {group: Some(2), key_low: 46, key_high: 46, one_shot: true, ..zone(HALF)},
        Zone {group: Some(3), key_low: 49, key_high: 49, one_shot: true, ..zone(QUARTER)},
        Zone {group: Some(4), key_low: 36, key_high: 36, one_shot: true, ..zone(QUARTER)}
    ]);
    rig
}

#[test]
fn a_note_cuts_the_voices_of_its_choke_number() {
    let mut rig = choke_rig();
    rig.left(&[on(1, 46)], 64);
    let rendered = rig.left(&[on(2, 42)], 2_400);
    assert_eq!(rendered[2_399], 1.0, "only the new note is left");
    assert_eq!(rig.voices(), 1);
    assert!(rendered[10] > 1.0, "the cut voice falls within milliseconds, not at once");
}

#[test]
fn other_choke_numbers_and_no_choke_are_left_alone() {
    let mut rig = choke_rig();
    rig.left(&[on(1, 49), on(2, 36)], 64);
    rig.left(&[on(3, 42)], 2_400);
    assert_eq!(rig.voices(), 3);
}

#[test]
fn a_note_does_not_choke_its_own_layers() {
    let mut rig = Rig::new();
    rig.groups(&[[1, 0, 5, 0]]);
    rig.zones(&[Zone {group: Some(1), ..zone(HALF)}, Zone {group: Some(1), ..zone(QUARTER)}]);
    assert_eq!(rig.left(&[on(1, 60)], 2_400)[2_399], 0.75);
}

#[test]
fn more_notes_than_voices_let_the_oldest_go() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(2));
    rig.zones(&[
        Zone {key_low: 60, key_high: 60, ..zone(ONE)}, Zone {key_low: 61, key_high: 61, ..zone(HALF)},
        Zone {key_low: 62, key_high: 62, ..zone(QUARTER)}
    ]);
    rig.left(&[on(1, 60)], 16);
    rig.left(&[on(2, 61)], 16);
    let rendered = rig.left(&[on(3, 62)], 2_400);
    assert_eq!(rendered[2_399], 0.75, "the first note is gone, the two newest hold");
    assert_eq!(rig.voices(), 2);
}

#[test]
fn one_voice_replaces_the_note_before() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(1));
    rig.zones(&[Zone {key_low: 60, key_high: 60, ..zone(ONE)}, Zone {key_low: 61, key_high: 61, ..zone(HALF)}]);
    rig.left(&[on(1, 60)], 16);
    assert_eq!(rig.left(&[on(2, 61)], 2_400)[2_399], 0.5);
    assert_eq!(rig.voices(), 1);
}

#[test]
fn legato_carries_the_held_note_to_the_new_key() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(1));
    rig.set(&LEGATO, ParamValue::Bool(true));
    rig.zones(&[zone(RAMP)]);
    assert_eq!(speed(&rig.left(&[on(1, 60)], 64)), 1.0);
    let carried = rig.left(&[on(2, 72)], 64);
    assert_eq!(speed(&carried), 2.0, "the same voice, an octave up");
    assert!(carried[0] > 60.0, "the sample was not started again");
    assert_eq!(rig.voices(), 1);
    rig.left(&[off(1, 60)], 64);
    assert_eq!(rig.voices(), 1, "the first key's note off no longer owns the voice");
    rig.left(&[off(2, 72)], 24_000);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn legato_needs_a_held_note() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(1));
    rig.set(&LEGATO, ParamValue::Bool(true));
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.zones(&[zone(RAMP)]);
    rig.left(&[on(1, 60)], 64);
    rig.left(&[off(1, 60)], 2_400);
    assert_eq!(rig.left(&[on(2, 60)], 8)[..3], [0.0, 1.0, 2.0], "nothing is held, the sample starts again");
}

#[test]
fn legato_with_several_voices_is_plain_polyphony() {
    let mut rig = Rig::new();
    rig.set(&LEGATO, ParamValue::Bool(true));
    rig.zones(&[zone(ONE)]);
    rig.left(&[on(1, 60)], 16);
    rig.left(&[on(2, 64)], 16);
    assert_eq!(rig.voices(), 2);
}

#[test]
fn a_key_above_the_root_plays_faster() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
    for (key, expected) in [(60, 1.0), (72, 2.0), (48, 0.5)] {
        let mut rig = Rig {state: rig_state(&rig)};
        assert!(close(speed(&rig.left(&[on(1, key)], 64)), expected), "key {key}");
    }
}

#[test]
fn key_tracking_scales_how_far_the_key_moves_the_pitch() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, key_track: 0.0, ..zone(RAMP)}]);
    assert!(close(speed(&rig.left(&[on(1, 84)], 64)), 1.0), "no tracking: every key plays the root");
    let mut half = Rig::new();
    half.zones(&[Zone {sample_start: 100, key_track: 0.5, ..zone(RAMP)}]);
    assert!(close(speed(&half.left(&[on(1, 84)], 64)), 2.0), "half tracking: two octaves of keys are one of pitch");
}

#[test]
fn zone_and_device_tuning_add_up() {
    let step = |zone_fields: Zone, octave: i32, transpose: i32, tune: f32| {
        let mut rig = Rig::new();
        rig.zones(&[Zone {sample_start: 100, ..zone_fields}]);
        rig.set(&OCTAVE, ParamValue::Int(octave));
        rig.set(&TRANSPOSE, ParamValue::Int(transpose));
        rig.set(&TUNE, ParamValue::Float(tune));
        speed(&rig.left(&[on(1, 60)], 64))
    };
    assert!(close(step(Zone {transpose: 12, ..zone(RAMP)}, 0, 0, 0.0), 2.0));
    assert!(close(step(Zone {tune: 100.0, transpose: 11, ..zone(RAMP)}, 0, 0, 0.0), 2.0), "100 cents are a semitone");
    assert!(close(step(zone(RAMP), -1, 0, 0.0), 0.5));
    assert!(close(step(zone(RAMP), 0, 12, 0.0), 2.0));
    assert!(close(step(zone(RAMP), 1, -12, 0.0), 1.0), "an octave up and twelve semitones down cancel");
    assert!(close(step(Zone {root_key: 48, ..zone(RAMP)}, 0, 0, 0.0), 2.0), "a lower root plays higher");
    assert!(close(step(zone(RAMP), 0, 0, 50.0), 2.0f32.powf(0.5 / 12.0)));
}

#[test]
fn the_cents_of_a_note_bend_it() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
    let note = EventRecord {cent: 1_200.0, ..on(1, 60)};
    assert!(close(speed(&rig.left(&[note], 64)), 2.0));
}

#[test]
fn a_sample_at_another_rate_plays_at_its_own_speed() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(SLOW_RAMP)}]);
    assert!(close(speed(&rig.left(&[on(1, 60)], 64)), 0.5));
}

#[test]
fn zone_gain_and_device_volume_multiply() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {gain: -6.0, ..zone(ONE)}]);
    let zone_only = rig.level(&[on(1, 60)]);
    assert!(close(zone_only, 10.0f32.powf(-6.0 / 20.0)));
    let mut both = Rig::new();
    both.zones(&[Zone {gain: -6.0, ..zone(ONE)}]);
    both.set(&VOLUME, ParamValue::Float(-6.0));
    assert!(close(both.level(&[on(1, 60)]), zone_only * zone_only));
}

#[test]
fn panning_is_the_sum_of_zone_and_device() {
    let pans = |zone_pan: f32, device_pan: f32| {
        let mut rig = Rig::new();
        rig.zones(&[Zone {panning: zone_pan, ..zone(ONE)}]);
        rig.set(&PANNING, ParamValue::Float(device_pan));
        let (left, right) = rig.run(&[on(1, 60)], 64);
        (left[63], right[63])
    };
    assert_eq!(pans(0.0, 0.0), (1.0, 1.0), "centred, both channels are untouched");
    assert_eq!(pans(-1.0, 0.0), (1.0, 0.0));
    assert_eq!(pans(0.0, 1.0), (0.0, 1.0));
    assert_eq!(pans(-1.0, 1.0), (1.0, 1.0), "opposite pans cancel");
    assert_eq!(pans(1.0, 1.0), (0.0, 1.0), "the sum is clamped");
    assert_eq!(pans(0.5, 0.0), (0.5, 1.0));
}

#[test]
fn a_stereo_sample_keeps_its_channels_until_mono_folds_them() {
    let mut rig = Rig::new();
    rig.zones(&[zone(SPLIT)]);
    let (left, right) = rig.run(&[on(1, 60)], 64);
    assert_eq!((left[63], right[63]), (1.0, 0.0));
    let mut folded = Rig::new();
    folded.zones(&[zone(SPLIT)]);
    folded.set(&MONO, ParamValue::Float(1.0));
    let (left, right) = folded.run(&[on(1, 60)], 64);
    assert_eq!((left[63], right[63]), (0.5, 0.5));
}

#[test]
fn velocity_to_gain_follows_the_amount() {
    let level = |amount: f32, velocity: f32| {
        let mut rig = Rig::new();
        rig.zones(&[zone(ONE)]);
        rig.slots(&[(VELOCITY, GAIN, amount)]);
        rig.level(&[on_at(1, 60, velocity)])
    };
    assert_eq!(level(0.0, 0.25), 1.0, "no amount, velocity does not matter");
    assert_eq!(level(1.0, 1.0), 1.0, "full velocity is full level at any amount");
    assert!(close(level(1.0, 0.5), 0.25), "the level falls with the square");
    assert!(close(level(0.5, 0.5), 0.75 * 0.75));
    assert_eq!(level(1.0, 0.0), 0.0);
    assert!(close(level(-1.0, 0.25), 0.75 * 0.75), "a negative amount turns it around: soft is loud");
    assert_eq!(level(-1.0, 1.0), 0.0);
}

#[test]
fn several_gain_slots_add_up_and_never_go_below_silence() {
    let mut rig = Rig::new();
    rig.zones(&[zone(ONE)]);
    rig.slots(&[(VELOCITY, GAIN, 1.0), (VELOCITY, GAIN, 1.0)]);
    assert_eq!(rig.level(&[on_at(1, 60, 0.25)]), 0.0);
    assert!(rig.left(&[], 64).iter().all(|value| *value >= 0.0));
}

#[test]
fn key_and_random_reach_pitch_and_pan() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, key_track: 0.0, ..zone(RAMP)}]);
    rig.slots(&[(KEY, PITCH, 0.25)]);
    assert!(close(speed(&rig.left(&[on(1, 120)], 64)), 2.0), "a key at the top of the range, a quarter of 48 semitones");
    let mut centre = Rig::new();
    centre.zones(&[Zone {sample_start: 100, key_track: 0.0, ..zone(RAMP)}]);
    centre.slots(&[(KEY, PITCH, 0.25)]);
    assert!(close(speed(&centre.left(&[on(1, 60)], 64)), 1.0), "the middle key is the source's zero");
    let mut spread = Rig::new();
    spread.zones(&[zone(ONE)]);
    spread.slots(&[(RANDOM, PAN, 1.0)]);
    spread.set(&AMP_RELEASE, ParamValue::Float(0.001));
    let mut seen = Vec::new();
    for note in 0..8 {
        let (left, right) = spread.run(&[on(note, 60)], 64);
        assert!(left[63] == 1.0 || right[63] == 1.0, "the pan law keeps one side at full level");
        assert_eq!((left[10], right[10]), (left[63], right[63]), "the random value holds for the whole note");
        seen.push((left[63], right[63]));
        spread.left(&[off(note, 60)], 2_400);
    }
    seen.dedup();
    assert!(seen.len() > 4, "each note draws its own");
}

#[test]
fn an_lfo_on_pitch_moves_the_speed() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
    rig.slots(&[(LFO, PITCH, 0.25)]);
    rig.set(&LFO_RATE, ParamValue::Float(30.0));
    let rendered = rig.left(&[on(1, 60)], 1_600);
    let steps: Vec<f32> = rendered.windows(2).map(|pair| pair[1] - pair[0]).collect();
    let (slowest, fastest) = steps.iter().fold((f32::MAX, 0.0f32), |(low, high), step| (low.min(*step), high.max(*step)));
    assert!(fastest > 1.9 && fastest <= 2.0 + 1.0e-3, "an octave up at the top of the cycle: {fastest}");
    assert!(slowest < 0.55 && slowest >= 0.5 - 1.0e-3, "an octave down at the bottom: {slowest}");
    assert_eq!(steps[0], 1.0, "the LFO restarts at zero with the note");
}

#[test]
fn the_second_envelope_reaches_its_targets() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
    rig.set(&MOD_ATTACK, ParamValue::Float(0.0));
    rig.set(&MOD_SUSTAIN, ParamValue::Float(1.0));
    rig.slots(&[(MOD, PITCH, 0.25)]);
    assert!(close(speed(&rig.left(&[on(1, 60)], 64)), 2.0), "at its sustain of one it adds a quarter of 48 semitones");
}

#[test]
fn env_depth_scales_what_the_second_envelope_does() {
    let step = |velocity: f32, depth_amount: f32| {
        let mut rig = Rig::new();
        rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
        rig.set(&MOD_ATTACK, ParamValue::Float(0.0));
        rig.set(&MOD_SUSTAIN, ParamValue::Float(1.0));
        rig.slots(&[(MOD, PITCH, 0.25), (VELOCITY, DEPTH, depth_amount)]);
        speed(&rig.left(&[on_at(1, 60, velocity)], 64))
    };
    assert!(close(step(1.0, 0.0), 2.0));
    assert!(close(step(1.0, -1.0), 1.0), "the depth is taken to nothing");
    assert!(close(step(0.5, -1.0), 2.0f32.powf(0.5)), "half the depth, half the octave");
    assert!(close(step(1.0, -4.0), 1.0), "a depth below nothing stays nothing");
}

#[test]
fn env_depth_from_the_second_envelope_itself_is_ignored() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
    rig.set(&MOD_ATTACK, ParamValue::Float(0.0));
    rig.set(&MOD_SUSTAIN, ParamValue::Float(1.0));
    rig.slots(&[(MOD, PITCH, 0.25), (MOD, DEPTH, -1.0)]);
    assert!(close(speed(&rig.left(&[on(1, 60)], 64)), 2.0));
}

#[test]
fn velocity_moves_the_sample_start() {
    let first = |velocity: f32| {
        let mut rig = Rig::new();
        rig.zones(&[Zone {sample_start: 1_000, sample_end: 3_000, ..zone(RAMP)}]);
        rig.slots(&[(VELOCITY, START, 0.5)]);
        rig.left(&[on_at(1, 60, velocity)], 4)[1]
    };
    assert_eq!(first(1.0), 2_001.0, "half the zone's length further in");
    assert_eq!(first(0.5), 1_501.0);
}

#[test]
fn the_amp_envelope_as_a_source_starts_at_nothing() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 1_000, sample_end: 3_000, ..zone(RAMP)}]);
    rig.slots(&[(AMP, START, 1.0)]);
    assert_eq!(rig.left(&[on(1, 60)], 4)[1], 1_001.0, "at the note's start no envelope has risen yet");
}

#[test]
fn unknown_sources_and_targets_do_nothing() {
    let mut rig = Rig::new();
    rig.zones(&[zone(ONE)]);
    rig.slots(&[(99, GAIN, 1.0), (VELOCITY, 99, 1.0), (-1, -1, 1.0)]);
    assert_eq!(rig.level(&[on_at(1, 60, 0.5)]), 0.0, "an unknown source reads as nothing, which a gain slot follows down");
    let mut plain = Rig::new();
    plain.zones(&[zone(ONE)]);
    plain.slots(&[(VELOCITY, 99, 1.0)]);
    assert_eq!(plain.level(&[on_at(1, 60, 0.5)]), 1.0);
}

#[test]
fn a_glide_starts_from_the_note_before() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {sample_start: 100, ..zone(RAMP)}]);
    rig.set(&GLIDE, ParamValue::Float(0.1));
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    assert!(close(speed(&rig.left(&[on(1, 60)], 64)), 1.0), "the first note has nowhere to glide from");
    rig.left(&[off(1, 60)], 2_400);
    let glided = rig.left(&[on(2, 72)], 9_600);
    let early = glided[41] - glided[40];
    assert!(early > 1.0 && early < 1.1, "it starts at the pitch of the note before: {early}");
    assert!(close(glided[9_599] - glided[9_598], 2.0), "and arrives at its own");
}

#[test]
fn a_one_shot_plays_on_after_the_note_off_and_others_fall() {
    let mut rig = Rig::new();
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.zones(&[
        Zone {key_low: 60, key_high: 60, one_shot: true, sample_end: 4_800, ..zone(ONE)},
        Zone {key_low: 61, key_high: 61, ..zone(ONE)}
    ]);
    rig.left(&[on(1, 60), on(2, 61)], 16);
    let rendered = rig.left(&[off(1, 60), off(2, 61)], 2_400);
    assert_eq!(rendered[2_399], 1.0, "the held sample is gone, the one shot is still there");
    assert_eq!(rig.voices(), 1);
    rig.left(&[], 4_800);
    assert_eq!(rig.voices(), 0, "it ended with its sample");
}

#[test]
fn a_voice_keeps_its_zone_when_the_table_moves_on() {
    let mut rig = Rig::new();
    rig.zones(&[zone(HALF)]);
    rig.left(&[on(1, 60)], 16);
    rig.zones(&[]);
    assert_eq!(rig.left(&[], 16), vec![0.5; 16], "the sounding note is untouched");
    rig.zones(&[zone(QUARTER)]);
    assert_eq!(rig.left(&[on(2, 60)], 16)[15], 0.75, "the next note reads the new table");
}

#[test]
fn a_table_with_the_wrong_number_of_columns_is_ignored() {
    let mut rig = Rig::new();
    rig.zones(&[zone(HALF)]);
    Sampler::table_changed(&mut rig.state, 0, leaked(vec![1, 2, 3, 4, 5], 5));
    assert_eq!(rig.level(&[on(1, 60)]), 0.5);
}

#[test]
fn a_stop_silences_everything() {
    let mut rig = Rig::new();
    rig.zones(&[zone(ONE)]);
    rig.left(&[on(1, 60), on(2, 64)], 16);
    Sampler::reset(&mut rig.state);
    assert_eq!(rig.voices(), 0);
    assert_eq!(rig.left(&[], 16), vec![0.0; 16]);
}

#[test]
fn a_choke_event_lets_every_voice_fall_fast() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {one_shot: true, ..zone(ONE)}]);
    rig.left(&[on(1, 60), on(2, 64)], 16);
    let rendered = rig.left(&[event(EVENT_CHOKE, 0, 0, 0.0, 0)], 2_400);
    assert!(rendered[0] > 0.0 && rendered[2_399] == 0.0);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn keys_outside_the_midi_range_are_clamped() {
    let mut rig = Rig::new();
    rig.zones(&[Zone {key_low: 127, key_high: 127, key_track: 0.0, ..zone(ONE)}]);
    assert_eq!(rig.level(&[on(1, 500)]), 1.0);
}

#[test]
fn many_zones_and_notes_stay_within_the_voice_pool() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(64));
    let zones: Vec<Zone> = (0..40).map(|_| Zone {gain: -40.0, ..zone(ONE)}).collect();
    rig.zones(&zones);
    for note in 0..20 {
        rig.left(&[on(note, 60)], 64);
    }
    let rendered = rig.left(&[], 4_800);
    assert!(rendered.iter().all(|value| value.is_finite()));
    assert!(rig.voices() <= 80);
}

#[test]
fn the_parity_probe_maps_every_parameter() {
    let expected: [(f32, f32); 36] = [
        (1.0, 64.0), (0.0, 5.0), (0.0, 1.0), (-3.0, 3.0), (-12.0, 12.0), (-100.0, 100.0), (0.0, 3.0), (20.0, 20_000.0),
        (0.0, 1.0), (f32::NEG_INFINITY, 0.0), (-1.0, 1.0), (0.0, 1.0),
        (0.0, 5.0), (0.001, 8.0), (0.0, 5.0), (0.001, 8.0), (0.0, 1.0), (0.001, 8.0),
        (0.0, 5.0), (0.001, 8.0), (0.0, 5.0), (0.001, 8.0), (0.0, 1.0), (0.001, 8.0),
        (0.0, 3.0), (0.01, 30.0), (0.0, 5.0), (0.0, 5.0), (0.0, 1.0), (0.0, 1.0),
        (0.0, 3.0), (0.01, 30.0), (0.0, 5.0), (0.0, 5.0), (0.0, 1.0), (0.0, 1.0)
    ];
    for (id, (low, high)) in expected.iter().enumerate() {
        let (at_zero, at_one) = (map_parameter(id as u32, 0.0), map_parameter(id as u32, 1.0));
        assert!(at_zero == *low || close(at_zero, *low), "parameter {id} at 0: {at_zero}");
        assert!(close(at_one, *high), "parameter {id} at 1: {at_one}");
    }
    assert!(map_parameter(36, 0.5).is_nan());
}

fn mono_rig(legato: bool) -> Rig {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(1));
    rig.set(&LEGATO, ParamValue::Bool(legato));
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.zones(&[
        Zone {key_low: 60, key_high: 60, ..zone(ONE)}, Zone {key_low: 62, key_high: 62, ..zone(HALF)},
        Zone {key_low: 64, key_high: 64, ..zone(QUARTER)}
    ]);
    rig
}

#[test]
fn one_voice_goes_back_to_the_key_still_held() {
    let mut rig = mono_rig(false);
    rig.left(&[on(1, 60)], 64);
    assert_eq!(rig.left(&[on(2, 62)], 2_400)[2_399], 0.5);
    assert_eq!(rig.left(&[off(2, 62)], 2_400)[2_399], 1.0, "the first key is still down, its sample plays again");
    assert_eq!(rig.voices(), 1);
    rig.left(&[off(1, 60)], 2_400);
    assert_eq!(rig.voices(), 0, "its own note off ends it");
}

#[test]
fn one_voice_walks_back_through_every_held_key() {
    let mut rig = mono_rig(false);
    rig.left(&[on(1, 60)], 64);
    rig.left(&[on(2, 62)], 64);
    assert_eq!(rig.left(&[on(3, 64)], 2_400)[2_399], 0.25);
    assert_eq!(rig.left(&[off(3, 64)], 2_400)[2_399], 0.5);
    assert_eq!(rig.left(&[off(2, 62)], 2_400)[2_399], 1.0);
    rig.left(&[off(1, 60)], 2_400);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn letting_go_of_a_key_below_the_sounding_one_changes_nothing() {
    let mut rig = mono_rig(false);
    rig.left(&[on(1, 60)], 64);
    rig.left(&[on(2, 62)], 2_400);
    assert_eq!(rig.left(&[off(1, 60)], 2_400)[2_399], 0.5, "the sounding key plays on");
    rig.left(&[off(2, 62)], 2_400);
    assert_eq!(rig.voices(), 0, "nothing is held any more, nothing comes back");
}

#[test]
fn a_key_played_again_is_only_held_once_it_is_down() {
    let mut rig = mono_rig(false);
    rig.left(&[on(1, 60)], 64);
    rig.left(&[off(1, 60)], 2_400);
    rig.left(&[on(2, 62)], 64);
    rig.left(&[off(2, 62)], 2_400);
    assert_eq!(rig.voices(), 0, "the released first key does not come back");
}

#[test]
fn going_back_keeps_the_velocity_the_key_was_played_with() {
    let mut rig = mono_rig(false);
    rig.slots(&[(VELOCITY, GAIN, 1.0)]);
    rig.left(&[on_at(1, 60, 0.5)], 64);
    rig.left(&[on(2, 62)], 2_400);
    assert!(close(rig.left(&[off(2, 62)], 2_400)[2_399], 0.25));
}

#[test]
fn legato_glides_back_to_the_key_still_held() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(1));
    rig.set(&LEGATO, ParamValue::Bool(true));
    rig.zones(&[zone(RAMP)]);
    rig.left(&[on(1, 60)], 64);
    assert_eq!(speed(&rig.left(&[on(2, 72)], 64)), 2.0);
    let back = rig.left(&[off(2, 72)], 64);
    assert_eq!(speed(&back), 1.0, "the same voice, back at the first key");
    assert!(back[0] > 100.0, "the sample was not started again");
    assert_eq!(rig.voices(), 1);
    rig.left(&[off(1, 60)], 24_000);
    assert_eq!(rig.voices(), 0);
}

#[test]
fn several_voices_never_go_back() {
    let mut rig = Rig::new();
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.zones(&[Zone {key_low: 60, key_high: 60, ..zone(ONE)}, Zone {key_low: 62, key_high: 62, ..zone(HALF)}]);
    rig.left(&[on(1, 60)], 64);
    rig.left(&[on(2, 62)], 64);
    assert_eq!(rig.left(&[off(2, 62)], 2_400)[2_399], 1.0, "the first note simply plays on");
    assert_eq!(rig.voices(), 1);
}

#[test]
fn more_held_keys_than_the_stack_remembers_drop_the_oldest() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(1));
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.zones(&[Zone {key_track: 0.0, ..zone(ONE)}]);
    for note in 0..20 {
        rig.left(&[on(note, 40 + note)], 16);
    }
    for note in (4..20).rev() {
        rig.left(&[off(note, 40 + note)], 2_400);
    }
    assert_eq!(rig.voices(), 0, "sixteen keys were remembered, the four oldest are forgotten");
}

#[test]
fn a_synced_lfo_snaps_to_the_nearest_note_length() {
    use device_sampler::synced_hertz;
    assert!(close(synced_hertz(2.0, 120.0), 2.0), "a quarter note at 120 bpm");
    assert!(close(synced_hertz(2.3, 120.0), 2.0));
    assert!(close(synced_hertz(3.5, 120.0), 4.0), "nearer to the eighth, as an interval");
    assert!(close(synced_hertz(0.5, 120.0), 0.5), "one bar");
    assert!(close(synced_hertz(0.001, 120.0), 0.0625), "never slower than eight bars");
    assert!(close(synced_hertz(500.0, 120.0), 16.0), "never faster than a thirty-second");
    assert!(close(synced_hertz(2.0, 60.0), 2.0), "at 60 bpm the same rate is an eighth");
    assert!(close(synced_hertz(3.0, 120.0), 3.0), "a dotted value sits on the sixth");
}

#[test]
fn a_short_loop_stays_inside_its_points_far_above_the_root() {
    let mut rig = Rig::new();
    // the ramp holds its frame number, so the output shows where the read head is
    rig.zones(&[Zone {loop_mode: 2, loop_start: 100, loop_end: 108, root_key: 0, ..zone(RAMP)}]);
    let rendered = rig.left(&[on(1, 96)], 4_800);
    assert!(rendered[400..].iter().all(|value| (99.0..=109.0).contains(value)), "the read head left the loop");
}

#[test]
fn release_samples_respect_the_voice_limit() {
    let mut rig = Rig::new();
    rig.set(&VOICES, ParamValue::Int(2));
    rig.set(&AMP_RELEASE, ParamValue::Float(0.001));
    rig.groups(&[[7, 0, 0, 1]]);
    rig.zones(&[Zone {group: Some(7), ..zone(ONE)}]);
    for note in 0..12 {
        rig.left(&[on(note, 60)], 16);
        rig.left(&[off(note, 60)], 16);
    }
    rig.left(&[], 4_800);
    assert!(rig.voices() <= 2, "{} release voices sound with a limit of 2", rig.voices());
}

use super::*;
use abi::BlockFlags;

const BAR: f64 = 3840.0;

#[derive(Clone, Copy)]
struct Rhythm {steps: i32, pulses: i32, rotate: i32, rate: i32, accents: i32, accent_rotate: i32, bursts: i32,
               burst_rotate: i32, repeats: i32, fade: f32}

impl Default for Rhythm {
    fn default() -> Self {
        Rhythm {steps: 16, pulses: 4, rotate: 0, rate: 6, accents: 0, accent_rotate: 0, bursts: 0, burst_rotate: 0, repeats: 3, fade: 0.0}
    }
}

#[derive(Clone, Copy)]
struct LaneSpec {note: u32, velocity: f32, chance: f32, gate: i32, mute: bool, solo: bool, rhythms: [Rhythm; 8]}

impl Default for LaneSpec {
    fn default() -> Self {
        LaneSpec {note: 60, velocity: 0.5, chance: 1.0, gate: 0, mute: false, solo: false, rhythms: [Rhythm::default(); 8]}
    }
}

fn words(lanes: &[LaneSpec]) -> Table {
    let mut words = Vec::new();
    for (index, lane) in lanes.iter().enumerate() {
        words.extend([index as u32, lane.note, lane.velocity.to_bits(), lane.chance.to_bits(), lane.gate as u32,
            lane.mute as u32, lane.solo as u32]);
        for rhythm in &lane.rhythms {
            words.extend([rhythm.steps as u32, rhythm.pulses as u32, rhythm.rotate as u32, rhythm.rate as u32,
                rhythm.accents as u32, rhythm.accent_rotate as u32, rhythm.bursts as u32, rhythm.burst_rotate as u32,
                rhythm.repeats as u32, rhythm.fade.to_bits()]);
        }
    }
    Table::from_words(Box::leak(words.into_boxed_slice()), COLUMNS as u32)
}

fn state(lanes: &[LaneSpec]) -> Box<EuclidState> {
    let mut state: Box<EuclidState> = unsafe { Box::new(core::mem::zeroed()) };
    seed(&mut state);
    state.set_table(words(lanes));
    state
}

const PLAYING: u32 = BlockFlags::TRANSPORTING;

// every event of `[from, to)` rendered in blocks of 128 pulses
fn render(state: &mut EuclidState, from: f64, to: f64, input: &[EventRecord]) -> Vec<EventRecord> {
    let mut all = Vec::new();
    let mut at = from;
    let mut first = true;
    while at < to {
        let end = (at + 128.0).min(to);
        let mut out = [blank(); 256];
        let flags = PLAYING | if first {BlockFlags::DISCONTINUOUS} else {0};
        let passing: Vec<EventRecord> = input.iter().filter(|event| event.position >= at && event.position < end).copied().collect();
        let count = state.process(at, end, flags, &passing, &mut out);
        all.extend_from_slice(&out[..count]);
        at = end;
        first = false;
    }
    all
}

fn ons(events: &[EventRecord]) -> Vec<(f64, u32, f32, f64)> {
    events.iter().filter(|event| event.kind == EVENT_NOTE_ON && event.id & OWN_IDS != 0)
        .map(|event| (event.position, event.pitch, (event.velocity * 1000.0).round() / 1000.0, event.duration)).collect()
}

#[test]
fn plays_the_hits_on_the_sixteenth_grid() {
    let mut state = state(&[LaneSpec::default()]);
    let events = render(&mut state, 0.0, BAR, &[]);
    assert_eq!(ons(&events), vec![(0.0, 60, 0.5, 240.0), (960.0, 60, 0.5, 240.0), (1920.0, 60, 0.5, 240.0), (2880.0, 60, 0.5, 240.0)]);
    let offs: Vec<f64> = events.iter().filter(|event| event.kind == EVENT_NOTE_OFF).map(|event| event.position).collect();
    assert_eq!(offs, vec![240.0, 1200.0, 2160.0, 3120.0]);
}

#[test]
fn accents_play_at_full_velocity() {
    let mut lane = LaneSpec::default();
    lane.rhythms[0].accents = 2;
    let mut state = state(&[lane]);
    let velocities: Vec<f32> = ons(&render(&mut state, 0.0, BAR, &[])).iter().map(|on| on.2).collect();
    assert_eq!(velocities, vec![1.0, 0.5, 1.0, 0.5]);
}

#[test]
fn next_hit_lasts_until_the_lanes_next_hit() {
    let mut lane = LaneSpec {gate: 1, ..LaneSpec::default()};
    lane.rhythms[0].pulses = 3;
    let mut state = state(&[lane]);
    let lengths: Vec<f64> = ons(&render(&mut state, 0.0, BAR, &[])).iter().map(|on| on.3).collect();
    // x....x....x..... at 1/16: hits on steps 0, 5, 10 (Bjorklund 3 of 16 is x....x....x.....)
    assert_eq!(lengths, vec![1200.0, 1200.0, 1440.0]);
}

#[test]
fn a_burst_plays_evenly_spaced_triggers_that_fade() {
    let mut lane = LaneSpec::default();
    lane.rhythms[0] = Rhythm {pulses: 1, bursts: 1, repeats: 4, fade: 0.75, ..Rhythm::default()};
    let mut state = state(&[lane]);
    assert_eq!(ons(&render(&mut state, 0.0, BAR, &[])),
        vec![(0.0, 60, 0.5, 60.0), (60.0, 60, 0.375, 60.0), (120.0, 60, 0.25, 60.0), (180.0, 60, 0.125, 60.0)]);
}

#[test]
fn a_negative_fade_lets_the_burst_rise() {
    let mut lane = LaneSpec {velocity: 1.0, ..LaneSpec::default()};
    lane.rhythms[0] = Rhythm {pulses: 1, bursts: 1, repeats: 3, fade: -1.0, ..Rhythm::default()};
    let mut state = state(&[lane]);
    let velocities: Vec<f32> = ons(&render(&mut state, 0.0, BAR, &[])).iter().map(|on| on.2).collect();
    assert_eq!(velocities, vec![0.5, 1.0]);
}

#[test]
fn two_lanes_on_one_note_send_one_note_on_the_louder() {
    let quiet = LaneSpec {velocity: 0.3, ..LaneSpec::default()};
    let loud = LaneSpec {velocity: 0.9, ..LaneSpec::default()};
    let mut state = state(&[quiet, loud]);
    let events = ons(&render(&mut state, 0.0, BAR, &[]));
    assert_eq!(events.len(), 4);
    assert!(events.iter().all(|on| on.2 == 0.9));
}

#[test]
fn mute_and_solo_silence_lanes() {
    let kick = LaneSpec {note: 36, ..LaneSpec::default()};
    let snare = LaneSpec {note: 38, mute: true, ..LaneSpec::default()};
    let hat = LaneSpec {note: 42, ..LaneSpec::default()};
    let mut state = state(&[kick, snare, hat]);
    let pitches: Vec<u32> = ons(&render(&mut state, 0.0, 960.0, &[])).iter().map(|on| on.1).collect();
    assert_eq!(pitches, vec![36, 42]);
    let mut state = super::tests::state(&[kick, snare, LaneSpec {solo: true, ..hat}]);
    let pitches: Vec<u32> = ons(&render(&mut state, 0.0, 960.0, &[])).iter().map(|on| on.1).collect();
    assert_eq!(pitches, vec![42]);
}

#[test]
fn length_restarts_every_lane() {
    let mut state = state(&[LaneSpec::default()]);
    state.length = 6;
    let positions: Vec<f64> = ons(&render(&mut state, 0.0, BAR, &[])).iter().map(|on| on.0).collect();
    // six sixteenths: steps 0 and 4 hit, then the lane starts again at 1440 and 2880
    assert_eq!(positions, vec![0.0, 960.0, 1440.0, 2400.0, 2880.0]);
}

#[test]
fn the_global_rate_doubles_the_steps() {
    let mut state = state(&[LaneSpec::default()]);
    state.rate = 3;
    let positions: Vec<f64> = ons(&render(&mut state, 0.0, 1920.0, &[])).iter().map(|on| on.0).collect();
    assert_eq!(positions, vec![0.0, 480.0, 960.0, 1440.0]);
}

#[test]
fn triplet_and_dotted_rates() {
    assert_eq!(note_value(6), 0.25);
    assert!((note_value(7) - 1.0 / 6.0).abs() < 1e-12);
    assert_eq!(note_value(8), 0.375);
    assert_eq!(note_value(0), 1.0);
    assert_eq!(note_value(11), 0.1875);
}

#[test]
fn a_new_pattern_waits_for_the_next_bar() {
    let mut lane = LaneSpec::default();
    lane.rhythms[1] = Rhythm {pulses: 16, ..Rhythm::default()};
    let mut state = state(&[lane]);
    let first = render(&mut state, 0.0, 128.0, &[]);
    assert_eq!(ons(&first).len(), 1);
    state.requested = 1;
    let mut out = [blank(); 256];
    let count = state.process(128.0, BAR + 512.0, PLAYING, &[], &mut out);
    let positions: Vec<f64> = ons(&out[..count]).iter().map(|on| on.0).collect();
    assert_eq!(positions, vec![960.0, 1920.0, 2880.0, BAR, BAR + 240.0, BAR + 480.0]);
}

#[test]
fn off_plays_nothing_but_passes_the_input_through() {
    let mut state = state(&[LaneSpec::default()]);
    state.requested = OFF;
    let incoming = EventRecord {position: 100.0, kind: EVENT_NOTE_ON, id: 7, pitch: 64, velocity: 1.0, duration: 240.0, ..blank()};
    let events = render(&mut state, 0.0, BAR, &[incoming]);
    assert!(ons(&events).is_empty());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id, 7);
}

#[test]
fn chance_is_the_same_on_every_render() {
    let lane = LaneSpec {chance: 0.5, rhythms: [Rhythm {pulses: 16, ..Rhythm::default()}; 8], ..LaneSpec::default()};
    let first = ons(&render(&mut state(&[lane]), 0.0, BAR * 4.0, &[]));
    let second = ons(&render(&mut state(&[lane]), 0.0, BAR * 4.0, &[]));
    assert_eq!(first, second);
    assert!(first.len() > 16 && first.len() < 48, "about half of 64 steps play: {}", first.len());
    let silent = LaneSpec {chance: 0.0, ..lane};
    assert!(ons(&render(&mut state(&[silent]), 0.0, BAR, &[])).is_empty());
}

#[test]
fn stopping_the_transport_ends_every_note() {
    let mut state = state(&[LaneSpec {gate: 1, ..LaneSpec::default()}]);
    render(&mut state, 0.0, 128.0, &[]);
    let mut out = [blank(); 256];
    let count = state.process(128.0, 256.0, 0, &[], &mut out);
    assert_eq!(out[..count].iter().filter(|event| event.kind == EVENT_NOTE_OFF).count(), 1);
    assert_eq!(state.retained_count, 0);
}

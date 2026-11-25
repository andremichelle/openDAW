//! Stop with Hold, full event buffers, jumps in split blocks, time signatures, ties under retrigger, walk cost
//! far into a song, and the held note's cent (#526).

use std::collections::HashSet;
use abi::{native_parameter_id, Bar, BlockFlags, EventRecord, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_arpeggio::*;

const PLAYING: u32 = BlockFlags::TRANSPORTING;
const JUMP: u32 = BlockFlags::TRANSPORTING | BlockFlags::DISCONTINUOUS;

fn seeded() -> ArpState {
    let mut state: ArpState = unsafe { core::mem::zeroed() };
    seed(&mut state);
    state
}

fn blank() -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn note(position: f64, duration: f64, pitch: u32, cent: f32) -> EventRecord {
    EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id: pitch, pitch, velocity: 0.8, cent, duration}
}

fn release(position: f64, pitch: u32) -> EventRecord {
    EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: pitch, pitch, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn param(state: &mut ArpState, key: u16, value: ParamValue) {
    apply_parameter(state, native_parameter_id(&[key]), value);
}

fn lane(state: &mut ArpState, lane: Lane, values: &[(usize, i32)]) {
    let mut all = match lane {
        Lane::Velocity | Lane::Gate | Lane::Chance => [100; STEP_COUNT],
        Lane::Ratchet => [1; STEP_COUNT],
        _ => [0; STEP_COUNT]
    };
    for (slot, value) in values {
        all[*slot] = *value;
    }
    set_lane(state, lane, &all);
}

fn signature(nominator: f64, denominator: f64) -> impl Fn(f64) -> Bar {
    move |position| {
        let beat = ((3840.0 / denominator) as i64) as f64;
        let length = beat * nominator;
        Bar {start: (position / length).floor() * length, length, beat}
    }
}

fn three_four(position: f64) -> Bar {signature(3.0, 4.0)(position)}
fn six_eight(position: f64) -> Bar {signature(6.0, 8.0)(position)}

/// Render [from, to) in blocks of `block` pulses with an output buffer of `capacity` events.
fn render_in(state: &mut ArpState, input: &[EventRecord], from: f64, to: f64, block: f64, flags: u32,
             capacity: usize, bar_at: BarAt) -> Vec<EventRecord> {
    let mut result = Vec::new();
    let mut position = from;
    let mut first = true;
    while position < to {
        let end = (position + block).min(to);
        let slice: Vec<EventRecord> = input.iter().filter(|event| event.position >= position && event.position < end).copied().collect();
        let mut out = vec![blank(); capacity];
        let block_flags = if first { flags } else { flags & !BlockFlags::DISCONTINUOUS };
        let written = process_in(state, position, end, block_flags, &slice, &mut out, bar_at);
        assert!(written <= capacity);
        result.extend_from_slice(&out[..written]);
        position = end;
        first = false;
    }
    result
}

fn render(state: &mut ArpState, input: &[EventRecord], from: f64, to: f64, block: f64, flags: u32) -> Vec<EventRecord> {
    render_in(state, input, from, to, block, flags, 1024, abi::bar_at)
}

fn ons(events: &[EventRecord]) -> Vec<EventRecord> {
    events.iter().filter(|event| event.kind == EVENT_NOTE_ON).copied().collect()
}

fn on_pitches(events: &[EventRecord]) -> Vec<u32> {
    ons(events).iter().map(|event| event.pitch).collect()
}

// ---------- 1. Hold and Stop ----------

#[test]
fn hold_stops_when_the_transport_stops() {
    let mut state = seeded();
    param(&mut state, 17, ParamValue::Bool(true));
    let input = [note(0.0, 3840.0, 60, 0.0), note(0.0, 3840.0, 64, 0.0)];
    let playing = render(&mut state, &input, 0.0, 960.0, 120.0, PLAYING);
    assert_eq!(ons(&playing).len(), 4);
    // Stop: the sequencer releases its notes, the paused quanta carry no flags.
    let released = [release(960.0, 60), release(960.0, 64)];
    let stopped = render(&mut state, &released, 960.0, 3840.0, 120.0, 0);
    assert!(ons(&stopped).is_empty(), "the latch must not keep arpeggiating after Stop");
}

#[test]
fn hold_starts_fresh_when_playback_starts() {
    let mut state = seeded();
    param(&mut state, 17, ParamValue::Bool(true));
    let live = [note(0.0, 100.0, 72, 0.0)];
    let stopped = render(&mut state, &live, 0.0, 480.0, 120.0, 0);
    assert_eq!(on_pitches(&stopped), vec![72, 72], "live hold works while stopped");
    let playing = render(&mut state, &[note(480.0, 960.0, 60, 0.0)], 480.0, 1440.0, 120.0, PLAYING);
    assert!(on_pitches(&playing).iter().all(|pitch| *pitch == 60), "{:?}", on_pitches(&playing));
}

#[test]
fn hold_replaces_the_latch_when_keys_change_between_two_steps() {
    let mut state = seeded();
    param(&mut state, 17, ParamValue::Bool(true));
    param(&mut state, 12, ParamValue::Int(0)); // 1/1
    let input = [note(0.0, 1000.0, 60, 0.0), note(2000.0, 500.0, 72, 0.0)];
    let events = render(&mut state, &input, 0.0, 3840.0 * 3.0, 480.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 72, 72], "72 was pressed after all keys were up");
}

#[test]
fn hold_adds_a_key_pressed_while_another_is_down_between_two_steps() {
    let mut state = seeded();
    param(&mut state, 17, ParamValue::Bool(true));
    param(&mut state, 12, ParamValue::Int(0));
    let input = [note(0.0, 3000.0, 60, 0.0), note(2000.0, 500.0, 72, 0.0)];
    let events = render(&mut state, &input, 0.0, 3840.0 * 3.0, 480.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 72, 60]);
}

// ---------- 2. full event buffers ----------

#[test]
fn every_note_on_gets_a_note_off_when_the_buffer_is_small() {
    for capacity in [3usize, 8, 17, 64] {
        let mut state = seeded();
        param(&mut state, 12, ParamValue::Int(16)); // 1/128
        param(&mut state, 13, ParamValue::Float(2.0));
        lane(&mut state, Lane::Kind, &[(0, STEP_CHORD as i32), (1, STEP_CHORD as i32), (2, STEP_TIE as i32)]);
        lane(&mut state, Lane::Ratchet, &(0..STEP_COUNT).map(|slot| (slot, 7)).collect::<Vec<_>>());
        let input: Vec<EventRecord> = (0..12).map(|index| note(0.0, 3840.0, 48 + index * 2, 0.0)).collect();
        let mut events = render_in(&mut state, &input, 0.0, 3840.0, 128.0, PLAYING, capacity, abi::bar_at);
        events.extend(render_in(&mut state, &[], 3840.0, 3840.0 * 40.0, 128.0, PLAYING, capacity, abi::bar_at));
        let started: HashSet<u32> = events.iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.id).collect();
        let ended: Vec<u32> = events.iter().filter(|event| event.kind == EVENT_NOTE_OFF).map(|event| event.id).collect();
        let ended_set: HashSet<u32> = ended.iter().copied().collect();
        assert!(!started.is_empty());
        assert_eq!(ended.len(), ended_set.len(), "capacity {capacity}: one note-off per note");
        assert_eq!(started, ended_set, "capacity {capacity}: every note-on is released");
    }
}

#[test]
fn a_jump_with_a_small_buffer_releases_every_note() {
    let mut state = seeded();
    param(&mut state, 13, ParamValue::Float(2.0));
    lane(&mut state, Lane::Kind, &[(0, STEP_CHORD as i32)]);
    let input: Vec<EventRecord> = (0..10).map(|index| note(0.0, 3840.0, 60 + index, 0.0)).collect();
    let mut events = render_in(&mut state, &input, 0.0, 240.0, 240.0, PLAYING, 64, abi::bar_at);
    events.extend(render_in(&mut state, &[], 0.0, 3840.0, 240.0, JUMP, 4, abi::bar_at));
    let started: HashSet<u32> = events.iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.id).collect();
    let ended: HashSet<u32> = events.iter().filter(|event| event.kind == EVENT_NOTE_OFF).map(|event| event.id).collect();
    assert_eq!(started.len(), 10);
    assert_eq!(started, ended);
}

#[test]
fn a_backward_jump_with_a_small_buffer_releases_every_note_soon() {
    let mut state = seeded();
    param(&mut state, 13, ParamValue::Float(2.0));
    lane(&mut state, Lane::Kind, &[(0, STEP_CHORD as i32)]);
    let far = 3840.0 * 100.0;
    let input: Vec<EventRecord> = (0..10).map(|index| note(far, 3840.0, 60 + index, 0.0)).collect();
    let mut events = render_in(&mut state, &input, far, far + 240.0, 240.0, PLAYING, 64, abi::bar_at);
    // Jump back into a short loop that never reaches the notes' original end again.
    events.extend(render_in(&mut state, &[], 0.0, 240.0, 240.0, JUMP, 4, abi::bar_at));
    events.extend(render_in(&mut state, &[], 240.0, 960.0, 240.0, PLAYING, 4, abi::bar_at));
    let started: HashSet<u32> = events.iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.id).collect();
    let ended: HashSet<u32> = events.iter().filter(|event| event.kind == EVENT_NOTE_OFF).map(|event| event.id).collect();
    assert_eq!(started.len(), 10);
    assert_eq!(started, ended);
}

// ---------- 3. a jump inside a block split by parameter updates ----------

#[test]
fn a_jump_reaches_only_the_first_sub_range() {
    let mut state = seeded();
    // The upstream re-sends what sounds at `from` only when it sees the jump, like the sequencer.
    let mut pulls: Vec<u32> = Vec::new();
    let mut pull = |from: f64, _to: f64, flags: u32, out: &mut [EventRecord]| {
        pulls.push(flags);
        if flags & BlockFlags::DISCONTINUOUS != 0 {
            out[0] = note(from, 3840.0, 60, 0.0);
            1
        } else {
            0
        }
    };
    let mut boundaries = vec![300.0, f64::INFINITY].into_iter();
    let mut advance = |_state: &mut ArpState, _boundary: f64| boundaries.next().unwrap();
    let mut out = [blank(); 64];
    let mut transform = |state: &mut ArpState, from: f64, to: f64, flags: u32, input: &[EventRecord], output: &mut [EventRecord]|
        process(state, from, to, flags, input, output);
    let written = abi::render_sub_ranges(&mut state, 0.0, 480.0, JUMP, &mut out, 100.0, &mut pull, &mut advance, &mut transform);
    let events = &out[..written];
    assert_eq!(pulls, vec![JUMP, PLAYING, PLAYING]);
    assert_eq!(events.iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.position).collect::<Vec<_>>(), vec![0.0, 240.0]);
    let first_off = events.iter().find(|event| event.kind == EVENT_NOTE_OFF).unwrap();
    assert_eq!(first_off.position, 240.0, "the first step is not cut at the update boundary");
}

// ---------- 7. time signatures ----------

#[test]
fn retrigger_bar_follows_a_three_four_signature() {
    let mut state = seeded();
    param(&mut state, 18, ParamValue::Int(RETRIGGER_BAR));
    let chord: Vec<EventRecord> = [60, 62, 64, 65, 67].iter().map(|pitch| note(0.0, 1e6, *pitch, 0.0)).collect();
    let events = render_in(&mut state, &chord, 0.0, 2880.0 * 2.0, 240.0, PLAYING, 1024, three_four);
    let pitches = on_pitches(&events);
    assert_eq!(pitches.len(), 24);
    assert_eq!(pitches[11], 62, "step 11 of the bar");
    assert_eq!(pitches[12], 60, "a 3/4 bar is 12 sixteenths, the pattern restarts there");
}

#[test]
fn retrigger_beat_follows_the_signature_denominator() {
    let mut state = seeded();
    param(&mut state, 18, ParamValue::Int(RETRIGGER_BEAT));
    let chord: Vec<EventRecord> = [60, 64, 67].iter().map(|pitch| note(0.0, 1e6, *pitch, 0.0)).collect();
    let events = render_in(&mut state, &chord, 0.0, 2880.0, 240.0, PLAYING, 1024, six_eight);
    assert_eq!(on_pitches(&events), [60, 64].repeat(6), "an eighth beat holds two sixteenths");
}

#[test]
fn retrigger_bar_in_four_four_matches_the_native_default() {
    let chord: Vec<EventRecord> = [60, 64, 67].iter().map(|pitch| note(0.0, 1e6, *pitch, 0.0)).collect();
    let mut native = seeded();
    param(&mut native, 18, ParamValue::Int(RETRIGGER_BAR));
    let mut explicit = seeded();
    param(&mut explicit, 18, ParamValue::Int(RETRIGGER_BAR));
    let expected = render(&mut native, &chord, 0.0, 3840.0 * 3.0, 100.0, PLAYING);
    let events = render_in(&mut explicit, &chord, 0.0, 3840.0 * 3.0, 100.0, PLAYING, 1024, |position| signature(4.0, 4.0)(position));
    assert_eq!(on_pitches(&events), on_pitches(&expected));
}

// ---------- 8. ties under retrigger ----------

#[test]
fn a_tie_beyond_a_beat_retrigger_does_not_extend_the_note() {
    let mut state = seeded();
    param(&mut state, 18, ParamValue::Int(RETRIGGER_BEAT));
    lane(&mut state, Lane::Kind, &[(4, STEP_TIE as i32)]);
    let events = render(&mut state, &[note(0.0, 1e6, 60, 0.0)], 0.0, 960.0, 240.0, PLAYING);
    let notes = ons(&events);
    assert_eq!(notes.len(), 4);
    assert!(notes.iter().all(|event| event.duration == 240.0), "slot 4 never plays under Beat retrigger");
}

#[test]
fn a_tie_within_the_beat_still_extends_the_note() {
    let mut state = seeded();
    param(&mut state, 18, ParamValue::Int(RETRIGGER_BEAT));
    lane(&mut state, Lane::Kind, &[(2, STEP_TIE as i32)]);
    let events = render(&mut state, &[note(0.0, 1e6, 60, 0.0)], 0.0, 960.0, 240.0, PLAYING);
    let notes = ons(&events);
    assert_eq!(notes.iter().map(|event| event.duration).collect::<Vec<_>>(), vec![240.0, 480.0, 240.0]);
}

// ---------- 9. walk cost ----------

#[test]
fn walk_and_random_other_are_cheap_far_into_a_song() {
    let state = seeded();
    for mode in [14, 17] {
        let mut walker = seeded();
        param(&mut walker, 10, ParamValue::Int(mode));
        let start = std::time::Instant::now();
        let far = 1_000_000_000_000i64;
        let values: Vec<i64> = (far..far + 2000).map(|step| walk_index(&walker, step, 7)).collect();
        assert!(start.elapsed().as_millis() < 200, "mode {mode}");
        for window in values.windows(2) {
            let delta = (window[1] - window[0]).rem_euclid(7);
            if mode == 14 { assert_ne!(delta, 0) } else { assert!(delta == 0 || delta == 1 || delta == 6) }
        }
        assert_eq!(walk_index(&walker, far + 77, 7), values[77], "mode {mode} is a function of the step");
    }
    let _ = state;
}

#[test]
fn random_other_alternates_two_notes_and_never_repeats() {
    let mut state = seeded();
    param(&mut state, 10, ParamValue::Int(14));
    for count in 2..12i64 {
        let values: Vec<i64> = (-50..3000).map(|step| walk_index(&state, step, count)).collect();
        for window in values.windows(2) {
            assert_ne!(window[0], window[1], "count {count}");
        }
        let mut histogram = vec![0; count as usize];
        values.iter().for_each(|value| histogram[*value as usize] += 1);
        let expected = values.len() / count as usize;
        assert!(histogram.iter().all(|bucket| *bucket > expected / 2), "count {count} {histogram:?}");
    }
}

#[test]
fn walk_keeps_its_place_when_the_note_count_changes() {
    let mut state = seeded();
    param(&mut state, 10, ParamValue::Int(17));
    let start = std::time::Instant::now();
    for step in 0..200_000i64 {
        walk_index(&state, step * 997, 3 + step % 9);
    }
    assert!(start.elapsed().as_millis() < 2000);
}

// ---------- #526 cents ----------

#[test]
fn the_held_note_cent_reaches_every_emitted_note() {
    let mut state = seeded();
    param(&mut state, 11, ParamValue::Int(2));
    lane(&mut state, Lane::Kind, &[(2, STEP_CHORD as i32)]);
    lane(&mut state, Lane::Ratchet, &[(1, 3)]);
    let input = [note(0.0, 1e6, 60, 12.5), note(0.0, 1e6, 64, -30.0)];
    let events = render(&mut state, &input, 0.0, 240.0 * 8.0, 100.0, PLAYING);
    let notes = ons(&events);
    assert!(notes.len() > 8);
    for event in notes {
        let cent = if event.pitch % 12 == 0 { 12.5 } else { -30.0 };
        assert_eq!(event.cent, cent, "pitch {} at {}", event.pitch, event.position);
    }
    assert!(events.iter().filter(|event| event.kind == EVENT_NOTE_OFF).all(|event| event.cent == 0.0));
}

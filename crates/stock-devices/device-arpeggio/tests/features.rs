//! The enhanced Arpeggio: walks, order, hold, retrigger, offset, the step lanes (rest / tie / chord, velocity,
//! gate, transpose, octave, chance, ratchet), and invariants (block segmentation, loops, note pairing).

use std::collections::HashMap;
use abi::{native_parameter_id, BlockFlags, EventRecord, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
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

fn note(position: f64, duration: f64, pitch: u32, velocity: f32) -> EventRecord {
    EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id: pitch, pitch, velocity, cent: 0.0, duration}
}

fn param(state: &mut ArpState, key: u16, value: ParamValue) {
    apply_parameter(state, native_parameter_id(&[key]), value);
}

fn set_mode(state: &mut ArpState, mode: i32) {param(state, 10, ParamValue::Int(mode))}
fn set_octaves(state: &mut ArpState, octaves: i32) {param(state, 11, ParamValue::Int(octaves))}
fn set_gate(state: &mut ArpState, gate: f32) {param(state, 13, ParamValue::Float(gate))}
fn set_repeat(state: &mut ArpState, repeat: i32) {param(state, 14, ParamValue::Int(repeat))}
fn set_order(state: &mut ArpState, order: i32) {param(state, 16, ParamValue::Int(order))}
fn set_hold(state: &mut ArpState, hold: bool) {param(state, 17, ParamValue::Bool(hold))}
fn set_retrigger(state: &mut ArpState, retrigger: i32) {param(state, 18, ParamValue::Int(retrigger))}
fn set_offset(state: &mut ArpState, offset: i32) {param(state, 19, ParamValue::Int(offset))}

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

/// Render [from, to) in blocks of `block` pulses, delivering each input event in its block.
fn render(state: &mut ArpState, input: &[EventRecord], from: f64, to: f64, block: f64, flags: u32) -> Vec<EventRecord> {
    let mut result = Vec::new();
    let mut position = from;
    let mut first = true;
    while position < to {
        let end = (position + block).min(to);
        let slice: Vec<EventRecord> = input.iter().filter(|event| event.position >= position && event.position < end).copied().collect();
        let mut out = [blank(); 1024];
        let block_flags = if first { flags } else { flags & !BlockFlags::DISCONTINUOUS };
        let written = process(state, position, end, block_flags, &slice, &mut out);
        result.extend_from_slice(&out[..written]);
        position = end;
        first = false;
    }
    result
}

fn ons(events: &[EventRecord]) -> Vec<EventRecord> {
    events.iter().filter(|event| event.kind == EVENT_NOTE_ON).copied().collect()
}

fn on_pitches(events: &[EventRecord]) -> Vec<u32> {
    ons(events).iter().map(|event| event.pitch).collect()
}

fn on_positions(events: &[EventRecord]) -> Vec<f64> {
    ons(events).iter().map(|event| event.position).collect()
}

fn chord(pitches: &[u32]) -> Vec<EventRecord> {
    pitches.iter().map(|pitch| note(0.0, 1_000_000.0, *pitch, 0.8)).collect()
}

fn walk(mode: i32, count: i64, steps: i64) -> Vec<i64> {
    let mut state = seeded();
    set_mode(&mut state, mode);
    (0..steps).map(|step| walk_index(&mut state, step, count)).collect()
}

// ---------- walks ----------

#[test]
fn deterministic_walks_for_four_notes() {
    assert_eq!(walk(0, 4, 8), vec![0, 1, 2, 3, 0, 1, 2, 3], "Up");
    assert_eq!(walk(1, 4, 8), vec![3, 2, 1, 0, 3, 2, 1, 0], "Down");
    assert_eq!(walk(2, 4, 10), vec![0, 1, 2, 3, 2, 1, 0, 1, 2, 3], "UpDown");
    assert_eq!(walk(3, 4, 10), vec![3, 2, 1, 0, 1, 2, 3, 2, 1, 0], "DownUp");
    assert_eq!(walk(4, 4, 10), vec![0, 1, 2, 3, 3, 2, 1, 0, 0, 1], "Up & Down");
    assert_eq!(walk(5, 4, 10), vec![3, 2, 1, 0, 0, 1, 2, 3, 3, 2], "Down & Up");
    assert_eq!(walk(6, 4, 8), vec![0, 3, 1, 2, 0, 3, 1, 2], "Converge");
    assert_eq!(walk(7, 4, 8), vec![2, 1, 3, 0, 2, 1, 3, 0], "Diverge");
    assert_eq!(walk(8, 4, 8), vec![0, 3, 1, 2, 1, 3, 0, 3], "Con & Diverge");
    assert_eq!(walk(9, 4, 8), vec![0, 3, 1, 3, 2, 3, 0, 3], "Pinky Up");
    assert_eq!(walk(10, 4, 10), vec![0, 3, 1, 3, 2, 3, 1, 3, 0, 3], "Pinky UpDown");
    assert_eq!(walk(11, 4, 8), vec![0, 1, 0, 2, 0, 3, 0, 1], "Thumb Up");
    assert_eq!(walk(12, 4, 10), vec![0, 1, 0, 2, 0, 3, 0, 2, 0, 1], "Thumb UpDown");
}

#[test]
fn deterministic_walks_for_odd_counts() {
    assert_eq!(walk(6, 3, 6), vec![0, 2, 1, 0, 2, 1], "Converge 3");
    assert_eq!(walk(7, 3, 6), vec![1, 2, 0, 1, 2, 0], "Diverge 3");
    assert_eq!(walk(6, 7, 7), vec![0, 6, 1, 5, 2, 4, 3], "Converge 7");
    assert_eq!(walk(7, 7, 7), vec![3, 4, 2, 5, 1, 6, 0], "Diverge 7");
    assert_eq!(walk(2, 3, 8), vec![0, 1, 2, 1, 0, 1, 2, 1], "UpDown 3");
    assert_eq!(walk(9, 2, 4), vec![0, 1, 0, 1], "Pinky Up 2");
    assert_eq!(walk(11, 2, 4), vec![0, 1, 0, 1], "Thumb Up 2");
}

#[test]
fn every_walk_stays_in_range_for_every_count() {
    for mode in 0..MODE_COUNT {
        for count in 1..=40i64 {
            for (step, index) in walk(mode, count, 300).iter().enumerate() {
                assert!((0..count).contains(index), "mode {mode} count {count} step {step} -> {index}");
            }
        }
    }
}

#[test]
fn a_single_note_always_plays_index_zero() {
    for mode in 0..MODE_COUNT {
        assert!(walk(mode, 1, 50).iter().all(|index| *index == 0), "mode {mode}");
    }
}

#[test]
fn random_is_deterministic_per_seed_and_changes_with_the_seed() {
    let mut first = seeded();
    set_mode(&mut first, 13);
    let a: Vec<i64> = (0..64).map(|step| walk_index(&mut first, step, 8)).collect();
    let b: Vec<i64> = (0..64).map(|step| walk_index(&mut first, step, 8)).collect();
    assert_eq!(a, b);
    set_seed(&mut first, 12345);
    let c: Vec<i64> = (0..64).map(|step| walk_index(&mut first, step, 8)).collect();
    assert_ne!(a, c);
}

#[test]
fn random_is_roughly_uniform() {
    let mut state = seeded();
    set_mode(&mut state, 13);
    let mut histogram = [0; 4];
    for step in 0..8000 {
        histogram[walk_index(&mut state, step, 4) as usize] += 1;
    }
    for bucket in histogram {
        assert!((1600..2400).contains(&bucket), "{histogram:?}");
    }
}

#[test]
fn random_other_never_repeats_and_ignores_the_evaluation_history() {
    for count in 2..9 {
        let forward = walk(14, count, 3000);
        for window in forward.windows(2) {
            assert_ne!(window[0], window[1], "count {count}");
        }
        let mut state = seeded();
        set_mode(&mut state, 14);
        for step in [2999i64, 17, 1500, 0, 2998, 1] {
            assert_eq!(walk_index(&mut state, step, count), forward[step as usize], "count {count} step {step}");
        }
    }
}

#[test]
fn walk_moves_by_at_most_one_and_ignores_the_evaluation_history() {
    let count = 7;
    let forward = walk(17, count, 3000);
    let mut stays = 0;
    let mut forwards = 0;
    for window in forward.windows(2) {
        let delta = (window[1] - window[0]).rem_euclid(count);
        assert!(delta == 0 || delta == 1 || delta == count - 1, "{window:?}");
        if delta == 0 { stays += 1 }
        if delta == 1 { forwards += 1 }
    }
    assert!((1200..1800).contains(&forwards), "forward {forwards}");
    assert!((500..1000).contains(&stays), "stay {stays}");
    let mut state = seeded();
    set_mode(&mut state, 17);
    for step in [2500i64, 3, 2999, 1000] {
        assert_eq!(walk_index(&mut state, step, count), forward[step as usize]);
    }
}

#[test]
fn shuffle_plays_every_note_once_per_cycle_and_varies() {
    let count = 6;
    let sequence = walk(15, count, 600);
    let mut cycles = Vec::new();
    for cycle in sequence.chunks(count as usize) {
        let mut sorted = cycle.to_vec();
        sorted.sort();
        assert_eq!(sorted, (0..count).collect::<Vec<_>>());
        cycles.push(cycle.to_vec());
    }
    cycles.dedup();
    assert!(cycles.len() > 10, "cycles should differ");
}

#[test]
fn random_once_repeats_one_permutation() {
    let count = 6;
    let sequence = walk(16, count, 120);
    let first = sequence[..count as usize].to_vec();
    let mut sorted = first.clone();
    sorted.sort();
    assert_eq!(sorted, (0..count).collect::<Vec<_>>());
    for cycle in sequence.chunks(count as usize) {
        assert_eq!(cycle, &first[..]);
    }
}

// ---------- pool, order, octaves ----------

#[test]
fn played_order_follows_the_start_and_pitch_order_sorts() {
    let input = [note(0.0, 1e6, 67, 0.8), note(10.0, 1e6, 60, 0.8), note(20.0, 1e6, 64, 0.8)];
    let mut played = seeded();
    let events = render(&mut played, &input, 0.0, 240.0 * 7.0, 10.0, PLAYING);
    // steps at 0 (pool 67), 240 (67, 60, 64 in played order) ...
    assert_eq!(on_pitches(&events), vec![67, 60, 64, 67, 60, 64, 67]);
    let mut pitch = seeded();
    set_order(&mut pitch, ORDER_PITCH);
    let events = render(&mut pitch, &input, 0.0, 240.0 * 7.0, 10.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![67, 64, 67, 60, 64, 67, 60]);
}

#[test]
fn octaves_expand_the_pool_upward() {
    let mut state = seeded();
    set_octaves(&mut state, 3);
    let events = render(&mut state, &chord(&[60, 64]), 0.0, 240.0 * 6.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 64, 72, 76, 84, 88]);
}

#[test]
fn offset_rotates_the_walk_start() {
    let mut state = seeded();
    set_offset(&mut state, 1);
    let events = render(&mut state, &chord(&[60, 64, 67]), 0.0, 240.0 * 4.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![64, 67, 60, 64]);
}

#[test]
fn repeat_holds_each_walk_step() {
    let mut state = seeded();
    set_repeat(&mut state, 2);
    let events = render(&mut state, &chord(&[60, 64]), 0.0, 240.0 * 6.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 60, 64, 64, 60, 60]);
}

// ---------- retrigger ----------

#[test]
fn retrigger_off_keeps_the_absolute_phase() {
    let mut state = seeded();
    let input = [note(240.0 * 5.0, 1e6, 60, 0.8), note(240.0 * 5.0, 1e6, 64, 0.8), note(240.0 * 5.0, 1e6, 67, 0.8)];
    let events = render(&mut state, &input, 0.0, 240.0 * 8.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![67, 60, 64], "grid step 5 -> 5 % 3 = 2");
}

#[test]
fn retrigger_note_restarts_at_the_first_note() {
    let mut state = seeded();
    set_retrigger(&mut state, RETRIGGER_NOTE);
    let input = [note(240.0 * 5.0, 240.0 * 3.0, 60, 0.8), note(240.0 * 5.0, 240.0 * 3.0, 64, 0.8),
        note(240.0 * 10.0, 1e6, 60, 0.8), note(240.0 * 10.0, 1e6, 64, 0.8)];
    let events = render(&mut state, &input, 0.0, 240.0 * 13.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 64, 60, 60, 64, 60], "restarts after the gap at step 10");
}

#[test]
fn retrigger_bar_restarts_every_bar() {
    let mut state = seeded();
    set_retrigger(&mut state, RETRIGGER_BAR);
    let events = render(&mut state, &chord(&[60, 64, 67]), 0.0, 3840.0 * 2.0, 240.0, PLAYING);
    let pitches = on_pitches(&events);
    assert_eq!(pitches[0], 60);
    assert_eq!(pitches[16], 60, "bar 2 starts again at the first note");
    assert_eq!(pitches[15], 60, "16 % 3 = 0 -> step 15 is index 0");
}

#[test]
fn retrigger_beat_restarts_every_beat() {
    let mut state = seeded();
    set_retrigger(&mut state, RETRIGGER_BEAT);
    let events = render(&mut state, &chord(&[60, 64, 67, 71, 72]), 0.0, 3840.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), [60, 64, 67, 71].repeat(4));
}

// ---------- hold ----------

#[test]
fn hold_keeps_playing_after_release() {
    let mut state = seeded();
    set_hold(&mut state, true);
    let input = [note(0.0, 500.0, 60, 0.8), note(0.0, 500.0, 64, 0.8)];
    let events = render(&mut state, &input, 0.0, 240.0 * 6.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 64, 60, 64, 60, 64]);
    let mut released = seeded();
    let events = render(&mut released, &input, 0.0, 240.0 * 6.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 64, 60]);
}

#[test]
fn hold_replaces_the_latch_after_all_keys_were_up_and_adds_while_down() {
    let mut state = seeded();
    set_hold(&mut state, true);
    let input = [
        note(0.0, 500.0, 60, 0.8),
        note(240.0, 300.0, 64, 0.8),     // added while 60 is down
        note(240.0 * 4.0, 100.0, 72, 0.8) // all up before -> replaces
    ];
    let events = render(&mut state, &input, 0.0, 240.0 * 7.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 64, 60, 64, 72, 72, 72]);
}

#[test]
fn hold_off_drops_the_latch() {
    let mut state = seeded();
    set_hold(&mut state, true);
    render(&mut state, &[note(0.0, 100.0, 60, 0.8)], 0.0, 480.0, 240.0, PLAYING);
    set_hold(&mut state, false);
    let events = render(&mut state, &[], 480.0, 1440.0, 240.0, PLAYING);
    assert!(ons(&events).is_empty());
}

#[test]
fn hold_works_with_live_notes_on_a_stopped_transport() {
    let mut state = seeded();
    set_hold(&mut state, true);
    let input = [note(0.0, f64::INFINITY, 60, 0.8),
        EventRecord {position: 300.0, offset: 0, kind: EVENT_NOTE_OFF, id: 60, pitch: 60, velocity: 0.0, cent: 0.0, duration: 0.0}];
    let events = render(&mut state, &input, 0.0, 240.0 * 5.0, 60.0, 0);
    assert_eq!(on_pitches(&events), vec![60; 5]);
}

#[test]
fn a_jump_clears_the_latch() {
    let mut state = seeded();
    set_hold(&mut state, true);
    render(&mut state, &[note(0.0, 100.0, 60, 0.8)], 0.0, 480.0, 240.0, PLAYING);
    let events = render(&mut state, &[], 0.0, 960.0, 240.0, JUMP);
    assert!(ons(&events).is_empty());
}

// ---------- step lanes ----------

#[test]
fn a_rest_silences_its_step_and_still_advances_the_walk() {
    let mut state = seeded();
    lane(&mut state, Lane::Kind, &[(1, STEP_REST as i32)]);
    let events = render(&mut state, &chord(&[60, 64, 67]), 0.0, 240.0 * 4.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 67, 60]);
    assert_eq!(on_positions(&events), vec![0.0, 480.0, 720.0]);
}

#[test]
fn a_tie_extends_the_previous_note() {
    let mut state = seeded();
    lane(&mut state, Lane::Kind, &[(1, STEP_TIE as i32), (2, STEP_TIE as i32)]);
    set_gate(&mut state, 0.5);
    let events = render(&mut state, &chord(&[60, 64]), 0.0, 240.0 * 4.0, 240.0, PLAYING);
    let notes = ons(&events);
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0].pitch, 60);
    assert_eq!(notes[0].duration, 240.0 * 2.0 + 120.0, "two tie steps plus the gated last step");
    let off = events.iter().find(|event| event.kind == EVENT_NOTE_OFF && event.id == notes[0].id).unwrap();
    assert_eq!(off.position, 600.0);
    assert_eq!(notes[1].position, 720.0);
    assert_eq!(notes[1].pitch, 64, "step 3 -> walk index 3 % 2");
}

#[test]
fn a_tie_wraps_around_the_pattern_end() {
    let mut state = seeded();
    set_length(&mut state, 4);
    lane(&mut state, Lane::Kind, &[(0, STEP_TIE as i32)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 8.0, 240.0, PLAYING);
    let notes = ons(&events);
    assert_eq!(on_positions(&events), vec![240.0, 480.0, 720.0, 1200.0, 1440.0, 1680.0]);
    assert_eq!(notes[2].duration, 480.0, "step 3 ties into step 0 of the next cycle");
}

#[test]
fn a_tie_after_a_rest_plays_nothing() {
    let mut state = seeded();
    lane(&mut state, Lane::Kind, &[(0, STEP_REST as i32), (1, STEP_TIE as i32)]);
    set_length(&mut state, 2);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 6.0, 240.0, PLAYING);
    assert!(ons(&events).is_empty());
}

#[test]
fn a_tie_after_a_failed_chance_plays_nothing() {
    let mut state = seeded();
    set_length(&mut state, 2);
    lane(&mut state, Lane::Kind, &[(1, STEP_TIE as i32)]);
    lane(&mut state, Lane::Chance, &[(0, 0)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 8.0, 240.0, PLAYING);
    assert!(ons(&events).is_empty());
}

#[test]
fn a_chord_step_plays_the_whole_pool() {
    let mut state = seeded();
    lane(&mut state, Lane::Kind, &[(1, STEP_CHORD as i32)]);
    lane(&mut state, Lane::Transpose, &[(1, 2)]);
    let events = render(&mut state, &chord(&[60, 64, 67]), 0.0, 240.0 * 3.0, 240.0, PLAYING);
    let mut at_step_one: Vec<u32> = ons(&events).iter().filter(|event| event.position == 240.0).map(|event| event.pitch).collect();
    at_step_one.sort();
    assert_eq!(at_step_one, vec![62, 66, 69]);
    assert_eq!(on_pitches(&events).last(), Some(&67), "step 2 -> walk index 2");
}

#[test]
fn velocity_lane_scales_the_magnet() {
    let mut state = seeded();
    lane(&mut state, Lane::Velocity, &[(0, 50), (1, 0)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 3.0, 240.0, PLAYING);
    let velocities: Vec<f32> = ons(&events).iter().map(|event| event.velocity).collect();
    assert_eq!(velocities, vec![0.5, 0.0, 1.0]);
}

#[test]
fn gate_lane_multiplies_the_global_gate() {
    let mut state = seeded();
    set_gate(&mut state, 0.5);
    lane(&mut state, Lane::Gate, &[(0, 200), (1, 50), (2, 0)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 4.0, 240.0, PLAYING);
    let durations: Vec<f64> = ons(&events).iter().map(|event| event.duration).collect();
    assert_eq!(durations, vec![240.0, 60.0, 1.0, 120.0]);
}

#[test]
fn transpose_and_octave_lanes_shift_the_note() {
    let mut state = seeded();
    lane(&mut state, Lane::Transpose, &[(0, 7), (1, -12)]);
    lane(&mut state, Lane::Octave, &[(1, 1), (2, -2)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 3.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![67, 60, 36]);
}

#[test]
fn notes_below_zero_are_dropped() {
    let mut state = seeded();
    lane(&mut state, Lane::Octave, &[(0, -2)]);
    lane(&mut state, Lane::Transpose, &[(0, -12)]);
    let events = render(&mut state, &chord(&[20]), 0.0, 240.0 * 2.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![20]);
}

#[test]
fn chance_is_deterministic_per_seed() {
    let render_with = |seed_value: u32| {
        let mut state = seeded();
        set_seed(&mut state, seed_value);
        set_length(&mut state, 1);
        lane(&mut state, Lane::Chance, &[(0, 50)]);
        on_positions(&render(&mut state, &chord(&[60]), 0.0, 240.0 * 400.0, 240.0, PLAYING))
    };
    let first = render_with(7);
    assert_eq!(first, render_with(7));
    assert_ne!(first, render_with(8));
    assert!((160..240).contains(&first.len()), "about half of 400 steps: {}", first.len());
}

#[test]
fn chance_zero_and_hundred() {
    let mut never = seeded();
    lane(&mut never, Lane::Chance, &[(0, 0)]);
    set_length(&mut never, 1);
    assert!(ons(&render(&mut never, &chord(&[60]), 0.0, 240.0 * 50.0, 240.0, PLAYING)).is_empty());
    let mut always = seeded();
    set_length(&mut always, 1);
    assert_eq!(ons(&render(&mut always, &chord(&[60]), 0.0, 240.0 * 50.0, 240.0, PLAYING)).len(), 50);
}

#[test]
fn ratchets_split_the_step() {
    let mut state = seeded();
    lane(&mut state, Lane::Ratchet, &[(0, 3)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0, 240.0, PLAYING);
    assert_eq!(on_positions(&events), vec![0.0, 80.0, 160.0]);
    assert!(ons(&events).iter().all(|event| event.duration == 80.0));
}

#[test]
fn ratchets_survive_tiny_blocks() {
    let mut state = seeded();
    lane(&mut state, Lane::Ratchet, &[(0, 7)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0, 3.0, PLAYING);
    assert_eq!(ons(&events).len(), 7);
    for (hit, event) in ons(&events).iter().enumerate() {
        assert!((event.position - hit as f64 * 240.0 / 7.0).abs() < 1e-9);
    }
}

#[test]
fn a_tied_ratchet_extends_only_the_last_hit() {
    let mut state = seeded();
    lane(&mut state, Lane::Ratchet, &[(0, 2)]);
    lane(&mut state, Lane::Kind, &[(1, STEP_TIE as i32)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 480.0, 480.0, PLAYING);
    let durations: Vec<f64> = ons(&events).iter().map(|event| event.duration).collect();
    assert_eq!(durations, vec![120.0, 360.0]);
}

#[test]
fn a_jump_drops_pending_ratchet_hits() {
    let mut state = seeded();
    lane(&mut state, Lane::Ratchet, &[(0, 4)]);
    render(&mut state, &chord(&[60]), 0.0, 30.0, 30.0, PLAYING);
    let events = render(&mut state, &[], 3000.0, 3100.0, 100.0, JUMP);
    assert!(ons(&events).is_empty());
}

#[test]
fn pattern_length_wraps_the_lanes() {
    let mut state = seeded();
    set_length(&mut state, 3);
    lane(&mut state, Lane::Kind, &[(2, STEP_REST as i32)]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0 * 9.0, 240.0, PLAYING);
    assert_eq!(on_positions(&events), vec![0.0, 240.0, 720.0, 960.0, 1440.0, 1680.0]);
}

#[test]
fn set_lane_clamps_out_of_range_values() {
    let mut state = seeded();
    set_lane(&mut state, Lane::Ratchet, &[99; STEP_COUNT]);
    set_lane(&mut state, Lane::Transpose, &[-99; STEP_COUNT]);
    set_lane(&mut state, Lane::Kind, &[9; STEP_COUNT]);
    let events = render(&mut state, &chord(&[60]), 0.0, 240.0, 240.0, PLAYING);
    let notes = ons(&events);
    assert_eq!(notes.len(), 7);
    assert!(notes.iter().all(|event| event.pitch == 48));
    set_length(&mut state, 0);
    set_length(&mut state, 1000);
}

// ---------- invariants ----------

struct Config {mode: i32, octaves: i32, rate: i32, gate: f32, order: i32, hold: bool, retrigger: i32, offset: i32, seed: u32, length: i32,
    lanes: Vec<(Lane, Vec<i32>)>}

fn random_config(rng: &mut u64) -> Config {
    let mut next = |bound: u64| {
        *rng ^= *rng << 13;
        *rng ^= *rng >> 7;
        *rng ^= *rng << 17;
        *rng % bound
    };
    let mut lanes = Vec::new();
    let values = |next: &mut dyn FnMut(u64) -> u64, low: i32, high: i32| -> Vec<i32> {
        (0..STEP_COUNT).map(|_| low + next((high - low + 1) as u64) as i32).collect()
    };
    lanes.push((Lane::Kind, values(&mut next, 0, 3)));
    lanes.push((Lane::Velocity, values(&mut next, 0, 100)));
    lanes.push((Lane::Gate, values(&mut next, 0, 200)));
    lanes.push((Lane::Transpose, values(&mut next, -12, 12)));
    lanes.push((Lane::Octave, values(&mut next, -2, 2)));
    lanes.push((Lane::Chance, values(&mut next, 0, 100)));
    lanes.push((Lane::Ratchet, values(&mut next, 1, 7)));
    Config {
        mode: next(MODE_COUNT as u64) as i32, octaves: 1 + next(5) as i32, rate: 6 + next(11) as i32,
        gate: next(200) as f32 / 100.0, order: next(2) as i32, hold: next(2) == 1, retrigger: next(4) as i32,
        offset: next(16) as i32, seed: next(1_000_000) as u32, length: 1 + next(64) as i32, lanes
    }
}

fn configured(config: &Config) -> ArpState {
    let mut state = seeded();
    set_mode(&mut state, config.mode);
    set_octaves(&mut state, config.octaves);
    param(&mut state, 12, ParamValue::Int(config.rate));
    set_gate(&mut state, config.gate);
    set_order(&mut state, config.order);
    set_hold(&mut state, config.hold);
    set_retrigger(&mut state, config.retrigger);
    set_offset(&mut state, config.offset);
    set_seed(&mut state, config.seed);
    set_length(&mut state, config.length);
    for (lane, values) in &config.lanes {
        set_lane(&mut state, *lane, values);
    }
    state
}

fn test_input(seed_value: u64) -> Vec<EventRecord> {
    let mut events = Vec::new();
    for index in 0..5u64 {
        let start = ((seed_value * 7 + index * 331) % 3000) as f64;
        let duration = 200.0 + ((seed_value * 13 + index * 97) % 3000) as f64;
        events.push(EventRecord {position: start, offset: 0, kind: EVENT_NOTE_ON, id: index as u32, pitch: 48 + (index as u32 * 5) % 30,
            velocity: 0.3 + index as f32 * 0.1, cent: 0.0, duration});
    }
    events.sort_by(|left, right| left.position.partial_cmp(&right.position).unwrap());
    events
}

fn signature(events: &[EventRecord]) -> Vec<(u64, u32, u32, u32, u64)> {
    let mut list: Vec<_> = events.iter().map(|event| (event.position.to_bits(), event.kind, event.pitch, event.velocity.to_bits(), event.duration.to_bits())).collect();
    list.sort();
    list
}

#[test]
fn the_output_does_not_depend_on_the_block_size() {
    let mut rng = 0x1234_5678_9ABC_DEF1u64;
    for scenario in 0..400 {
        let config = random_config(&mut rng);
        let input = test_input(scenario);
        let mut whole = configured(&config);
        let reference = signature(&render(&mut whole, &input, 0.0, 7680.0, 16.0, PLAYING));
        for block in [1.0, 5.0, 37.0, 128.0] {
            let mut split = configured(&config);
            assert_eq!(signature(&render(&mut split, &input, 0.0, 7680.0, block, PLAYING)), reference, "scenario {scenario} block {block}");
        }
    }
}

#[test]
fn every_note_on_gets_exactly_one_note_off() {
    let mut rng = 0xDEAD_BEEF_0BAD_F00Du64;
    for scenario in 0..400 {
        let config = random_config(&mut rng);
        let mut state = configured(&config);
        let mut events = render(&mut state, &test_input(scenario), 0.0, 7680.0, 8.0, PLAYING);
        let mut out = [blank(); 1024];
        let written = release_all_into(&mut state, 7680.0, &mut out);
        events.extend_from_slice(&out[..written]);
        let mut open: HashMap<u32, f64> = HashMap::new();
        for event in &events {
            if event.kind == EVENT_NOTE_ON {
                assert!(open.insert(event.id, event.position).is_none(), "scenario {scenario}: id {} started twice", event.id);
            } else {
                let start = open.remove(&event.id).unwrap_or_else(|| panic!("scenario {scenario}: note-off without note-on {}", event.id));
                assert!(event.position >= start, "scenario {scenario}: note-off before its note-on");
            }
        }
        assert!(open.is_empty(), "scenario {scenario}: {} notes never released", open.len());
    }
}

#[test]
fn a_loop_replays_the_same_events() {
    let mut rng = 0x0F0F_F0F0_1357_9BDFu64;
    for scenario in 0..200 {
        let config = random_config(&mut rng);
        let input = test_input(scenario);
        let mut state = configured(&config);
        // The jump releases what still sounds from the first pass, so compare the note-ons.
        let first = signature(&ons(&render(&mut state, &input, 0.0, 3840.0, 16.0, PLAYING)));
        let second = signature(&ons(&render(&mut state, &input, 0.0, 3840.0, 16.0, JUMP)));
        assert_eq!(first, second, "scenario {scenario}");
    }
}

#[test]
fn defaults_reproduce_the_legacy_up_arp() {
    let mut state = seeded();
    let events = render(&mut state, &chord(&[60, 64, 67]), 0.0, 240.0 * 6.0, 240.0, PLAYING);
    assert_eq!(on_pitches(&events), vec![60, 64, 67, 60, 64, 67]);
    assert!(ons(&events).iter().all(|event| event.duration == 240.0 && event.velocity == 1.0));
}

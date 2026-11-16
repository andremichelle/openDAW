use abi::{Bar, BlockFlags, EventRecord, Harmony, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_guitar::device::{self, param, State};
use device_guitar::strum;

const RATE: f32 = 48_000.0;
const MAJOR: i32 = 0b1001_0001;
// The native harmony is one global test seam, tests that set it take turns.
static HARMONY: std::sync::Mutex<()> = std::sync::Mutex::new(());

const BLANK: EventRecord = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};

fn four_four(pulse: f64) -> Bar {
    Bar {start: (pulse / 3840.0).floor() * 3840.0, length: 3840.0, beat: 960.0}
}

fn three_four(pulse: f64) -> Bar {
    Bar {start: (pulse / 2880.0).floor() * 2880.0, length: 2880.0, beat: 960.0}
}

fn state() -> Box<State> {
    let mut state: Box<State> = unsafe {Box::new_zeroed().assume_init()};
    state.init_in_place(RATE);
    state
}

fn pattern(state: &mut State, kinds: &[i32]) {
    slot_pattern(state, 0, kinds);
}

fn slot_pattern(state: &mut State, slot: usize, kinds: &[i32]) {
    let mut lane = [0i32; 64];
    lane[..kinds.len()].copy_from_slice(kinds);
    state.set_lane(slot, 0, &lane);
    state.set_length(slot, kinds.len() as i32);
}

fn playing() -> BlockFlags {
    BlockFlags::create(true, false, true, false)
}

fn strokes(state: &mut State, from: f64, to: f64, bar_at: fn(f64) -> Bar) -> Vec<EventRecord> {
    let mut out = [BLANK; 64];
    let count = device::generate(state, from, to, playing(), bar_at, &mut out);
    out[..count].to_vec()
}

fn render(state: &mut State, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    for (chunk_left, chunk_right) in left.chunks_mut(128).zip(right.chunks_mut(128)) {
        device::render(state, [chunk_left, chunk_right]);
    }
    (left, right)
}

fn rms(signal: &[f32]) -> f32 {
    (signal.iter().map(|value| value * value).sum::<f32>() / signal.len().max(1) as f32).sqrt()
}

#[test]
fn the_pattern_places_its_strokes_on_the_rate_grid() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, 0, 0, 0, strum::UP, 0, 0, 0]);
    let events = strokes(&mut state, 0.0, 3840.0, four_four);
    let found: Vec<(f64, u32)> = events.iter().map(|event| (event.position, event.pitch)).collect();
    assert_eq!(found, vec![(0.0, 1), (960.0, 2), (1920.0, 1), (2880.0, 2)]);
}

#[test]
fn half_and_double_rate() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::UP]);
    device::apply_parameter(&mut state, param::RATE, ParamValue::Int(0));
    assert_eq!(strokes(&mut state, 0.0, 960.0, four_four).len(), 2);
    device::apply_parameter(&mut state, param::RATE, ParamValue::Int(2));
    assert_eq!(strokes(&mut state, 0.0, 960.0, four_four).len(), 8);
}

#[test]
fn blocks_split_anywhere_yield_the_same_strokes() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, 0, strum::UP, strum::MUTE]);
    let whole: Vec<f64> = strokes(&mut state, 0.0, 7680.0, four_four).iter().map(|event| event.position).collect();
    let mut split = Vec::new();
    let mut from = 0.0;
    while from < 7680.0 {
        let to = (from + 97.3f64).min(7680.0);
        split.extend(strokes(&mut state, from, to, four_four).iter().map(|event| event.position));
        from = to;
    }
    assert_eq!(whole, split);
}

#[test]
fn the_pattern_restarts_with_every_bar() {
    let mut state = state();
    let mut kinds = vec![0; 16];
    kinds[0] = strum::BASS;
    kinds[12] = strum::DOWN;
    pattern(&mut state, &kinds);
    let events = strokes(&mut state, 0.0, 2880.0 * 2.0, three_four);
    let kinds: Vec<u32> = events.iter().map(|event| event.pitch).collect();
    assert_eq!(kinds, vec![strum::BASS as u32, strum::BASS as u32]);
}

#[test]
fn the_slot_switches_the_playing_pattern_at_once() {
    let mut state = state();
    slot_pattern(&mut state, 0, &[strum::DOWN, 0, 0, 0]);
    slot_pattern(&mut state, 15, &[0, strum::UP, 0, 0]);
    let first: Vec<u32> = strokes(&mut state, 0.0, 960.0, four_four).iter().map(|event| event.pitch).collect();
    assert_eq!(first, vec![strum::DOWN as u32]);
    device::apply_parameter(&mut state, param::SLOT, ParamValue::Int(15));
    let events = strokes(&mut state, 960.0, 1920.0, four_four);
    let second: Vec<(f64, u32)> = events.iter().map(|event| (event.position, event.pitch)).collect();
    assert_eq!(second, vec![(1200.0, strum::UP as u32)]);
}

#[test]
fn every_slot_keeps_its_own_length() {
    let mut state = state();
    slot_pattern(&mut state, 0, &[strum::DOWN, 0]);
    slot_pattern(&mut state, 1, &[strum::DOWN, 0, 0, 0, 0, 0, 0, 0]);
    let count = |state: &mut State| strokes(state, 0.0, 3840.0, four_four).len();
    assert_eq!(count(&mut state), 8);
    device::apply_parameter(&mut state, param::SLOT, ParamValue::Int(1));
    assert_eq!(count(&mut state), 2);
}

#[test]
fn keys_mode_strums_nothing_on_its_own() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    device::apply_parameter(&mut state, param::MODE, ParamValue::Int(1));
    assert!(strokes(&mut state, 0.0, 3840.0, four_four).is_empty());
}

#[test]
fn notes_land_on_separate_strings_and_stop_on_release() {
    let mut state = state();
    for (id, pitch) in [(1u32, 48u32), (2, 52), (3, 55)] {
        device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id, pitch, velocity: 0.9, ..BLANK});
    }
    let (left, _) = render(&mut state, 9600);
    assert!(rms(&left[4800..]) > 1.0e-3);
    let display = state.display();
    let sounding: Vec<usize> = (0..6).filter(|string| display[*string] >= 0).collect();
    assert_eq!(sounding.len(), 3);
    for (id, pitch) in [(1u32, 48u32), (2, 52), (3, 55)] {
        device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_OFF, id, pitch, ..BLANK});
    }
    let (left, _) = render(&mut state, 24000);
    assert!(rms(&left[19200..]) < 1.0e-4);
}

#[test]
fn a_stroke_strums_the_chord_track_and_stays_silent_without_a_chord() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    assert_eq!(state.display(), [-1, 3, 2, 0, 1, 0]);
    let (left, right) = render(&mut state, 24000);
    assert!(rms(&left) > 1.0e-3 && rms(&right) > 1.0e-3);
    assert!(left.iter().chain(right.iter()).all(|value| value.is_finite() && value.abs() < 2.0));
    let mut silent = self::state();
    pattern(&mut silent, &[strum::DOWN]);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: None});
    let events = strokes(&mut silent, 0.0, 240.0, four_four);
    device::handle(&mut silent, &events[0]);
    let (left, _) = render(&mut silent, 4800);
    assert_eq!(rms(&left), 0.0);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

fn pack(tab: [i32; 6]) -> i32 {
    tab.iter().enumerate().fold(0, |packed, (string, fret)| packed | (if *fret < 0 {31} else {*fret}) << (string * 5))
}

#[test]
fn a_custom_shape_plays_its_exact_frets_without_the_chord_track() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    let mut shapes = [pack([-1; 6]); 16];
    shapes[2] = pack([12, 0, 0, 0, 12, 0]);
    state.set_shapes(&shapes);
    device::apply_parameter(&mut state, param::CHORD, ParamValue::Int(3));
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: None});
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    assert_eq!(state.display(), [12, 0, 0, 0, 12, 0]);
    let (left, _) = render(&mut state, 9600);
    assert!(rms(&left) > 1.0e-3);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn every_pick_of_a_repeated_two_string_pick_plays_both_strings() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = state();
    let mut kinds = [0; 8];
    kinds[4] = strum::PICK;
    kinds[6] = strum::PICK;
    slot_pattern(&mut state, 0, &kinds);
    state.set_lane(0, 1, &[1 | 1 << 4; 64]);
    let mut shapes = [pack([-1; 6]); 16];
    shapes[0] = pack([3, -1, 0, 0, 3, -1]);
    state.set_shapes(&shapes);
    device::apply_parameter(&mut state, param::CHORD, ParamValue::Int(1));
    let events = strokes(&mut state, 0.0, 3840.0, four_four);
    assert_eq!(events.len(), 4);
    for event in &events {
        device::handle(&mut state, event);
        assert_eq!(state.lit(), 1 | 1 << 4, "stroke at {}", event.position);
        render(&mut state, 4800);
    }
}

#[test]
fn the_velocity_variation_is_one_value_for_the_whole_step() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::PICK, strum::DOWN, strum::PICK]);
    state.set_lane(0, 1, &[0b111111; 64]);
    device::apply_parameter(&mut state, param::VELOCITY_VARIATION, ParamValue::Float(1.0));
    let mut levels = Vec::new();
    for event in strokes(&mut state, 0.0, 960.0, four_four) {
        device::handle(&mut state, &event);
        let velocities: Vec<f32> = state.scheduled_velocities().collect();
        assert!(velocities.len() > 1);
        assert!(velocities.iter().all(|velocity| *velocity == velocities[0]), "{velocities:?}");
        levels.push(velocities[0]);
        render(&mut state, 9600);
    }
    assert!(levels.windows(2).any(|pair| pair[0] != pair[1]), "steps still vary: {levels:?}");
}

#[test]
fn a_step_carries_the_bend_of_every_string_to_the_stroke() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::DOWN]);
    state.set_lane(0, 4, &[0, 4 | 2 << 12, 0, 0]);
    let events = strokes(&mut state, 0.0, 480.0, four_four);
    let bends: Vec<i32> = events.iter().map(|event| event.duration as i32 >> 6).collect();
    let masks: Vec<i32> = events.iter().map(|event| event.duration as i32 & 0b111111).collect();
    assert_eq!(bends, vec![0, 4 | 2 << 12]);
    assert_eq!(masks, vec![0b111111, 0b111111]);
}

#[test]
fn only_the_bent_string_bends() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    state.set_lane(0, 4, &[3 << 12; 64]);
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    let mut bends: Vec<(u8, f32)> = state.scheduled_bends().collect();
    bends.sort_by_key(|(string, _)| *string);
    assert_eq!(bends, vec![(1, 0.0), (2, 0.0), (3, 0.0), (4, 1.0), (5, 0.0)]);
}

fn three_bars_then_three_four(pulse: f64) -> Bar {
    if pulse < 3840.0 * 3.0 {
        four_four(pulse)
    } else {
        let start = 11520.0 + ((pulse - 11520.0) / 2880.0).floor() * 2880.0;
        Bar {start, length: 2880.0, beat: 960.0}
    }
}

#[test]
fn a_two_bar_pattern_alternates_across_a_signature_change() {
    let mut state = state();
    let mut kinds = [0; 24];
    kinds[0] = strum::BASS;
    kinds[12] = strum::DOWN;
    pattern(&mut state, &kinds);
    let first = |state: &mut State, start: f64| -> Vec<u32> {
        strokes(state, start, start + 240.0, three_bars_then_three_four).iter().map(|event| event.pitch).collect()
    };
    let bass = vec![strum::BASS as u32];
    let down = vec![strum::DOWN as u32];
    for start in [0.0, 3840.0, 7680.0] {
        first(&mut state, start);
    }
    assert_eq!(first(&mut state, 11520.0), down, "the fourth bar is odd");
    assert_eq!(first(&mut state, 14400.0), bass);
    assert_eq!(first(&mut state, 11520.0), down, "after a jump back");
}

#[test]
fn a_played_note_keeps_ringing_through_a_step_without_chord_and_a_stop() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: None});
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::STOP]);
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id: 5, pitch: 60, velocity: 0.8, ..BLANK});
    let (before, _) = render(&mut state, 4800);
    for event in strokes(&mut state, 0.0, 480.0, four_four) {
        device::handle(&mut state, &event);
    }
    let (after, _) = render(&mut state, 9600);
    assert!(rms(&after[4800..]) > rms(&before) * 0.3, "before {} after {}", rms(&before), rms(&after[4800..]));
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn bass_ignores_bends_and_a_moved_pick_keeps_its_own() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let bends = |kind: i32, mask: i32, packed: i32| {
        let mut state = state();
        pattern(&mut state, &[kind]);
        state.set_lane(0, 1, &[mask; 64]);
        state.set_lane(0, 4, &[packed; 64]);
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        let mut scheduled: Vec<(u8, f32)> = state.scheduled_bends().collect();
        scheduled.sort_by_key(|(string, _)| *string);
        scheduled
    };
    assert_eq!(bends(strum::BASS, 0b111111, 4 << 3), vec![(1, 0.0)]);
    assert_eq!(bends(strum::PICK, 0b000001, 2), vec![(1, 0.5)]);
}

#[test]
fn the_first_played_note_stops_at_its_note_off() {
    let mut state = state();
    device::apply_parameter(&mut state, param::MODE, ParamValue::Int(1));
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id: 0, pitch: 52, velocity: 0.8, ..BLANK});
    render(&mut state, 4800);
    assert_ne!(state.sounding(), 0);
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_OFF, id: 0, pitch: 52, ..BLANK});
    render(&mut state, 48000);
    assert_eq!(state.sounding(), 0);
}

#[test]
fn a_partial_strum_after_a_chord_change_stops_the_strings_that_moved() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::DOWN]);
    state.set_lane(0, 1, &[0b111111, 0b111000, 0, 0]);
    let events = strokes(&mut state, 0.0, 480.0, four_four);
    device::handle(&mut state, &events[0]);
    render(&mut state, 9600);
    assert_eq!(state.sounding(), 0b111110);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    device::handle(&mut state, &events[1]);
    render(&mut state, 48000);
    assert_eq!(state.sounding() & 0b000111, 0, "the moved bass strings still ring: {:#08b}", state.sounding());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

fn seven_sixteen(pulse: f64) -> Bar {
    Bar {start: (pulse / 1680.0).floor() * 1680.0, length: 1680.0, beat: 240.0}
}

#[test]
fn every_bar_of_an_odd_signature_starts_on_its_downbeat() {
    let mut state = state();
    device::apply_parameter(&mut state, param::RATE, ParamValue::Int(0));
    pattern(&mut state, &[strum::BASS, strum::DOWN, strum::DOWN, strum::DOWN]);
    let events = strokes(&mut state, 0.0, 1680.0 * 3.0, seven_sixteen);
    let bass: Vec<f64> = events.iter().filter(|event| event.pitch == strum::BASS as u32).map(|event| event.position).collect();
    assert_eq!(bass, vec![0.0, 1680.0, 3360.0]);
}

#[test]
fn a_strum_over_played_notes_still_queued_keeps_ringing() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    device::apply_parameter(&mut state, param::SPEED, ParamValue::Float(1.0));
    for (id, pitch) in [(1u32, 60u32), (2, 64), (3, 67)] {
        device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id, pitch, velocity: 0.8, ..BLANK});
    }
    render(&mut state, 48);
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    assert!(state.scheduled_bends().count() == 5, "the played plucks still queued are dropped");
    render(&mut state, 72000);
    assert_eq!(state.sounding() & 0b111110, 0b111110, "{:#08b}", state.sounding());
}

#[test]
fn a_late_chord_note_takes_a_free_string_instead_of_a_held_one() {
    let mut state = state();
    device::apply_parameter(&mut state, param::MODE, ParamValue::Int(1));
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id: 1, pitch: 45, velocity: 0.8, ..BLANK});
    render(&mut state, 64);
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id: 2, pitch: 49, velocity: 0.8, ..BLANK});
    render(&mut state, 4800);
    let sounding = state.sounding();
    assert_eq!(sounding.count_ones(), 2, "{sounding:#08b}");
}

#[test]
fn two_notes_that_fit_one_string_pluck_it_once() {
    let mut state = state();
    device::apply_parameter(&mut state, param::MODE, ParamValue::Int(1));
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id: 1, pitch: 40, velocity: 0.8, ..BLANK});
    device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id: 2, pitch: 41, velocity: 0.8, ..BLANK});
    device::render(&mut state, [&mut [], &mut []]);
    let queued: Vec<(u8, f32)> = state.scheduled_bends().collect();
    assert_eq!(queued, vec![(0, 0.0)]);
}

#[test]
fn a_short_played_chord_sounds_on_every_string() {
    let level = |release: bool| {
        let mut state = state();
        device::apply_parameter(&mut state, param::MODE, ParamValue::Int(1));
        let notes = [(1u32, 40u32), (2, 45), (3, 50), (4, 55), (5, 59), (6, 64)];
        for (id, pitch) in notes {
            device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id, pitch, velocity: 0.8, ..BLANK});
        }
        render(&mut state, 48);
        if release {
            for (id, pitch) in notes {
                device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_OFF, id, pitch, ..BLANK});
            }
        }
        let (left, _) = render(&mut state, 2400);
        rms(&left[960..])
    };
    let (short, held) = (level(true), level(false));
    assert!(short > held * 0.8, "short {short} held {held}");
}

#[test]
fn a_new_stroke_drops_the_unplucked_strings_of_the_previous_one() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let mut state = state();
    device::apply_parameter(&mut state, param::SPEED, ParamValue::Float(1.0));
    pattern(&mut state, &[strum::DOWN, strum::UP]);
    let events = strokes(&mut state, 0.0, 480.0, four_four);
    device::handle(&mut state, &events[0]);
    render(&mut state, 480);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    device::handle(&mut state, &events[1]);
    assert_eq!(state.scheduled_bends().count(), 6, "only the new stroke's six strings are queued");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn the_chord_track_plays_when_no_shape_or_an_empty_shape_is_chosen() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    for chord in [0, 2] {
        let mut state = state();
        pattern(&mut state, &[strum::DOWN]);
        let mut shapes = [pack([-1; 6]); 16];
        shapes[0] = pack([12, 0, 0, 0, 12, 0]);
        state.set_shapes(&shapes);
        device::apply_parameter(&mut state, param::CHORD, ParamValue::Int(chord));
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        assert_eq!(state.display(), [-1, 3, 2, 0, 1, 0], "chord {chord}");
    }
}

#[test]
fn every_body_strums_at_a_similar_level_without_clipping() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut levels = Vec::new();
    for body in 0..8 {
        let (mut peak, mut energy) = (0.0f32, 0.0f32);
        for root in [0, 7, 9, 5] {
            let mut state = state();
            pattern(&mut state, &[strum::DOWN]);
            device::apply_parameter(&mut state, param::BODY, ParamValue::Int(body));
            let minor = if root == 9 {0b1000_1001} else {MAJOR};
            abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((root, minor))});
            let events = strokes(&mut state, 0.0, 240.0, four_four);
            device::handle(&mut state, &events[0]);
            let (left, right) = render(&mut state, 48000);
            peak = left.iter().chain(right.iter()).fold(peak, |peak, value| peak.max(value.abs()));
            energy += rms(&left) * rms(&left);
        }
        assert!(20.0 * peak.log10() < -3.0, "body {body} peaks at {:.1} dB", 20.0 * peak.log10());
        levels.push(10.0 * (energy / 4.0).log10());
    }
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let (low, high) = levels.iter().fold((f32::MAX, f32::MIN), |(low, high), level| (low.min(*level), high.max(*level)));
    assert!(high - low < 3.0, "levels {levels:?}");
}

// The spectral centroid of a strum, past its first 50 ms.
fn centroid(signal: &[f32]) -> f32 {
    let (mut weighted, mut total) = (0.0f64, 0.0f64);
    for frequency in (40..6000).step_by(20) {
        let (mut real, mut imaginary) = (0.0f64, 0.0f64);
        for (index, value) in signal[2400..2400 + 8192].iter().enumerate() {
            let phase = 2.0 * std::f64::consts::PI * frequency as f64 * index as f64 / 48000.0;
            real += *value as f64 * phase.cos();
            imaginary += *value as f64 * phase.sin();
        }
        let power = real * real + imaginary * imaginary;
        weighted += power * frequency as f64;
        total += power;
    }
    (weighted / total) as f32
}

fn strum_centroid(kind: i32, setup: impl Fn(&mut State)) -> f32 {
    let mut state = state();
    pattern(&mut state, &[kind]);
    setup(&mut state);
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    centroid(&render(&mut state, 24000).0)
}

#[test]
fn the_bodies_change_the_tone() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let bodies: Vec<f32> = (0..8).map(|body| strum_centroid(strum::DOWN, |state| {
        device::apply_parameter(state, param::BODY, ParamValue::Int(body))
    })).collect();
    let wooden = &bodies[1..6];
    assert!(bodies[7] > bodies[6] * 1.2, "the bridge pickup is brighter than the neck pickup {bodies:?}");
    let spread = |values: &[f32]| values.iter().cloned().fold(f32::MIN, f32::max) / values.iter().cloned().fold(f32::MAX, f32::min);
    assert!(spread(&bodies) > 3.0, "bodies {bodies:?}");
    assert!(spread(wooden) > 2.0, "wooden bodies {wooden:?}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

// The sample where the first string of a single stroke starts to sound.
fn first_onset(state: &mut State) -> usize {
    let (left, _) = render(state, 4800);
    left.iter().position(|value| value.abs() > 1.0e-4).unwrap_or(usize::MAX)
}

#[test]
fn speed_variation_humanizes_the_timing_of_the_strokes() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let onsets = |variation: f32| -> Vec<usize> {
        (0..8).map(|step| {
            let mut state = state();
            pattern(&mut state, &[strum::DOWN]);
            device::apply_parameter(&mut state, param::SPEED_VARIATION, ParamValue::Float(variation));
            let from = step as f64 * 240.0;
            let events = strokes(&mut state, from, from + 240.0, four_four);
            device::handle(&mut state, &events[0]);
            first_onset(&mut state)
        }).collect()
    };
    let steady = onsets(0.0);
    let human = onsets(1.0);
    assert!(steady.iter().max().unwrap() - steady.iter().min().unwrap() <= 2, "steady {steady:?}");
    let spread = human.iter().max().unwrap() - human.iter().min().unwrap();
    assert!(spread > (0.004 * RATE) as usize && spread <= (0.012 * RATE) as usize + 1, "humanized {human:?}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn chucks_and_palm_mutes_are_heard() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let peak = |kind: i32| -> f32 {
        let mut state = state();
        pattern(&mut state, &[kind]);
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        let (left, _) = render(&mut state, 24000);
        20.0 * left.iter().fold(0.0f32, |peak, value| peak.max(value.abs())).log10()
    };
    let (down, chuck, mute) = (peak(strum::DOWN), peak(strum::CHUCK), peak(strum::MUTE));
    assert!(down - chuck < 8.0, "down {down:.1} chuck {chuck:.1}");
    assert!(down - mute < 6.0, "down {down:.1} mute {mute:.1}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn every_string_is_plucked_about_equally_hard() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let levels: Vec<f32> = (0..6).map(|string| {
        let energy: f32 = (0..8).map(|step| {
            let mut state = state();
            pattern(&mut state, &[strum::PICK]);
            state.set_lane(0, 1, &[1 << string; 64]);
            device::apply_parameter(&mut state, param::BODY, ParamValue::Int(0));
            let from = step as f64 * 240.0;
            let events = strokes(&mut state, from, from + 240.0, four_four);
            device::handle(&mut state, &events[0]);
            let (left, _) = render(&mut state, 9600);
            rms(&left) * rms(&left)
        }).sum::<f32>() / 8.0;
        10.0 * energy.log10()
    }).collect();
    let (low, high) = levels.iter().fold((f32::MAX, f32::MIN), |(low, high), level| (low.min(*level), high.max(*level)));
    assert!(high - low < 5.0, "string levels {levels:?}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn speed_spreads_the_strum() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let early = |speed: f32| -> f32 {
        let mut state = state();
        pattern(&mut state, &[strum::DOWN]);
        device::apply_parameter(&mut state, param::SPEED, ParamValue::Float(speed));
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        let (left, _) = render(&mut state, 28800);
        let energy = |range: &[f32]| range.iter().map(|value| value * value).sum::<f32>();
        energy(&left[..2400]) / energy(&left)
    };
    let (fast, slow) = (early(0.0), early(1.0));
    assert!(10.0 * (fast / slow).log10() > 4.0, "fast {fast} slow {slow}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}


// Strums the low E string of a G chord, then optionally runs `after`, and returns the level a while later.
fn low_e_ring(after: impl Fn(&mut State, &EventRecord)) -> f32 {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    let mut stroke = strokes(&mut state, 0.0, 240.0, four_four)[0];
    stroke.duration = 1.0;
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    device::handle(&mut state, &stroke);
    render(&mut state, 4800);
    after(&mut state, &stroke);
    let (left, right) = render(&mut state, 24000);
    rms(&left[14400..]) + rms(&right[14400..])
}

#[test]
fn a_chord_without_a_string_mutes_that_string() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let ringing = low_e_ring(|_, _| {});
    let muted = low_e_ring(|state, stroke| {
        abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
        device::handle(state, stroke);
    });
    assert!(ringing > 1.0e-3, "ringing {ringing}");
    assert!(muted < ringing * 0.01, "muted {muted} ringing {ringing}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn a_stroke_without_a_chord_mutes_the_strings() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let ringing = low_e_ring(|_, _| {});
    let muted = low_e_ring(|state, stroke| {
        abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: None});
        device::handle(state, stroke);
    });
    assert!(muted < ringing * 0.01, "muted {muted} ringing {ringing}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn stopping_the_transport_mutes_the_last_stroke() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let generate = |state: &mut State, transporting: bool| {
        let mut out = [BLANK; 64];
        device::generate(state, 3840.0, 3840.0, BlockFlags::create(transporting, false, transporting, false), four_four, &mut out);
    };
    let ringing = low_e_ring(|state, _| generate(state, true));
    let stopped = low_e_ring(|state, _| generate(state, false));
    assert!(stopped < ringing * 0.01, "stopped {stopped} ringing {ringing}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn a_chop_lets_the_chord_through_and_stops_it_soon() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let level = |kind: i32, from: usize, to: usize| -> f32 {
        let mut state = state();
        pattern(&mut state, &[kind]);
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        let (left, _) = render(&mut state, 24000);
        20.0 * rms(&left[from..to]).max(1.0e-9).log10()
    };
    let body = |kind: i32| level(kind, 2880, 4800);
    let tail = |kind: i32| level(kind, 4800, 9600);
    assert!(body(strum::CHOP) - body(strum::CHUCK) > 15.0, "chop {:.1} chuck {:.1}", body(strum::CHOP), body(strum::CHUCK));
    assert!(tail(strum::DOWN) - tail(strum::CHOP) > 20.0, "down {:.1} chop {:.1}", tail(strum::DOWN), tail(strum::CHOP));
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}



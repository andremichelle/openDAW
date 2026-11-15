use super::{ChordKeys, ChordKeysState, Key, Note, MAX_KEYS, MAX_NOTES};
use abi::{EventRecord, Harmony, MidiEffect, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use math::harmony::MAJOR_BITS;

// the native harmony is process-wide, tests that set it must not overlap
static HARMONY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn device(voice_leading: bool) -> ChordKeysState {
    ChordKeysState {
        root: 0, scale: 0, follow: false, voice_leading, root_id: 1, scale_id: 2, follow_id: 3, voice_leading_id: 4,
        broadcast: 0, keys: [Key::default(); MAX_KEYS], keys_len: 0, helpers: [Key::default(); MAX_KEYS], helpers_len: 0,
        sounding: [Note::default(); MAX_NOTES], sounding_len: 0, degree: 0, previous_center: 0.0, has_previous: false,
        next_id: 1
    }
}

fn on(id: u32, pitch: u32) -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity: 0.7, cent: 0.0, duration: 0.0}
}

fn off(id: u32, pitch: u32) -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_OFF, id, pitch, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn run(state: &mut ChordKeysState, input: &[EventRecord]) -> Vec<EventRecord> {
    let mut output = [off(0, 0); 64];
    let count = ChordKeys::transform(state, input, &mut output);
    output[..count].to_vec()
}

fn ons(output: &[EventRecord]) -> Vec<u32> {
    output.iter().filter(|event| event.kind == EVENT_NOTE_ON).map(|event| event.pitch).collect()
}

fn offs(output: &[EventRecord]) -> Vec<u32> {
    output.iter().filter(|event| event.kind == EVENT_NOTE_OFF).map(|event| event.pitch).collect()
}

fn sounding(state: &ChordKeysState) -> Vec<u32> {
    let mut pitches: Vec<u32> = state.sounding[..state.sounding_len].iter().map(|note| note.pitch).collect();
    pitches.sort();
    pitches
}

#[test]
fn white_keys_play_the_triads_of_c_major() {
    let expected = [[60, 64, 67], [62, 65, 69], [64, 67, 71], [65, 69, 72], [67, 71, 74], [69, 72, 76], [71, 74, 77]];
    for (index, pitch) in [60u32, 62, 64, 65, 67, 69, 71].iter().enumerate() {
        let mut state = device(false);
        let output = run(&mut state, &[on(1, *pitch)]);
        assert_eq!(ons(&output), expected[index].to_vec(), "degree {}", index + 1);
        assert!(output.iter().all(|event| event.velocity == 0.7), "the chord takes the key's velocity");
    }
}

#[test]
fn a_helper_sends_only_its_added_note_and_its_release_only_that_note_off() {
    let mut state = device(false);
    assert_eq!(ons(&run(&mut state, &[on(1, 60)])), vec![60, 64, 67]);
    let added = run(&mut state, &[on(2, 61)]);
    assert_eq!(ons(&added), vec![71], "C# adds the 7th B, the triad keeps sounding");
    assert!(offs(&added).is_empty());
    let released = run(&mut state, &[off(2, 61)]);
    assert_eq!(offs(&released), vec![71], "releasing C# ends only the 7th");
    assert!(ons(&released).is_empty());
    assert_eq!(sounding(&state), vec![60, 64, 67]);
}

#[test]
fn the_note_off_of_a_chord_note_carries_the_id_of_its_note_on() {
    let mut state = device(false);
    let started = run(&mut state, &[on(1, 60), on(2, 61)]);
    let ended = run(&mut state, &[off(2, 61), off(1, 60)]);
    for event in ended.iter() {
        let start = started.iter().find(|start| start.pitch == event.pitch).expect("every off follows an on");
        assert_eq!(start.id, event.id, "pitch {}", event.pitch);
    }
    assert_eq!(state.sounding_len, 0);
}

#[test]
fn the_ninth_adds_only_the_ninth_and_sus_and_inversion_replace_only_what_changes() {
    let mut state = device(false);
    run(&mut state, &[on(1, 64)]);
    assert_eq!(ons(&run(&mut state, &[on(2, 63)])), vec![77], "E with D# adds only the 9th F");
    run(&mut state, &[off(2, 63), off(1, 64)]);
    run(&mut state, &[on(3, 60)]);
    let sus2 = run(&mut state, &[on(4, 66)]);
    assert_eq!((offs(&sus2), ons(&sus2)), (vec![64], vec![62]), "sus2 swaps E for D, C and G stay");
    run(&mut state, &[off(4, 66)]);
    let inverted = run(&mut state, &[on(5, 70)]);
    assert_eq!((offs(&inverted), ons(&inverted)), (vec![60], vec![72]), "the first inversion moves C up an octave");
}

#[test]
fn the_ninth_alone_adds_no_seventh_and_both_helpers_add_both() {
    let mut state = device(false);
    run(&mut state, &[on(1, 60)]);
    assert_eq!(ons(&run(&mut state, &[on(2, 63)])), vec![74], "C with D# adds only the 9th D");
    assert_eq!(ons(&run(&mut state, &[on(3, 61)])), vec![71], "adding C# brings the 7th B");
    assert_eq!(offs(&run(&mut state, &[off(2, 63)])), vec![74], "releasing D# ends only the 9th");
    assert_eq!(sounding(&state), vec![60, 64, 67, 71]);
}

#[test]
fn a_helper_held_first_shapes_the_next_chord() {
    let mut state = device(false);
    assert!(run(&mut state, &[on(1, 61)]).is_empty(), "a black key alone plays nothing");
    assert_eq!(ons(&run(&mut state, &[on(2, 60)])), vec![60, 64, 67, 71]);
}

#[test]
fn the_latest_white_key_plays_and_releasing_it_returns_to_the_one_still_held() {
    let mut state = device(false);
    run(&mut state, &[on(1, 60)]);
    let second = run(&mut state, &[on(2, 67)]);
    assert_eq!(offs(&second), vec![60, 64], "G shares the G of C");
    assert_eq!(ons(&second), vec![71, 74]);
    let back = run(&mut state, &[off(2, 67)]);
    assert_eq!(ons(&back), vec![60, 64]);
    assert_eq!(sounding(&state), vec![60, 64, 67]);
    assert_eq!(offs(&run(&mut state, &[off(1, 60)])).len(), 3);
}

#[test]
fn voice_leading_moves_to_the_nearest_inversion_and_keeps_shared_notes() {
    let mut state = device(true);
    run(&mut state, &[on(1, 60)]);
    run(&mut state, &[off(1, 60)]);
    let output = run(&mut state, &[on(2, 65)]);
    assert_eq!(sounding(&state), vec![60, 65, 69], "F after C plays C F A");
    assert!(ons(&output).len() == 3 && offs(&output).is_empty());
    let next = run(&mut state, &[on(3, 67)]);
    assert_eq!(sounding(&state), vec![59, 62, 67], "G after F plays B D G, as close as D G B and found first");
    assert_eq!(offs(&next).len(), 3, "no shared pitches between C F A and B D G");
}

#[test]
fn follow_reads_the_project_key() {
    let _lock = HARMONY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = device(false);
    state.follow = true;
    abi::set_native_harmony(Harmony {root: 2, bits: MAJOR_BITS, chord: None});
    let output = run(&mut state, &[on(1, 60)]);
    abi::set_native_harmony(Harmony {root: 0, bits: MAJOR_BITS, chord: None});
    assert_eq!(ons(&output), vec![62, 66, 69], "in D major the C key plays D major");
}

#[test]
fn other_events_pass_and_unknown_note_offs_are_dropped() {
    let mut state = device(false);
    let mut other = on(9, 0);
    other.kind = 99;
    let output = run(&mut state, &[other, off(42, 60)]);
    assert_eq!(output.len(), 1);
    assert_eq!(output[0].kind, 99);
}

#[test]
fn release_all_ends_every_sounding_note_once() {
    let mut state = device(false);
    run(&mut state, &[on(1, 60), on(2, 61)]);
    let mut out = [off(0, 0); 8];
    let count = state.release_all_into(96.0, &mut out);
    let mut pitches: Vec<u32> = out[..count].iter().map(|event| event.pitch).collect();
    pitches.sort();
    assert_eq!(pitches, vec![60, 64, 67, 71]);
    assert!(run(&mut state, &[off(1, 60)]).is_empty(), "the late upstream off finds nothing");
}

#[test]
fn chord_notes_carry_the_remaining_length_of_their_white_key() {
    let mut state = device(false);
    let live = run(&mut state, &[on(1, 60)]);
    assert!(live.iter().all(|event| event.duration == f64::INFINITY), "a live key has no end");
    run(&mut state, &[off(1, 60)]);
    let mut sequenced = on(2, 60);
    sequenced.position = 100.0;
    sequenced.duration = 960.0;
    let mut helper = on(3, 61);
    helper.position = 400.0;
    let output = run(&mut state, &[sequenced, helper]);
    assert!(output[..3].iter().all(|event| event.duration == 960.0));
    assert_eq!(output[3].duration, 660.0, "the 7th added later ends with the chord");
}

#[test]
fn the_inversion_key_overrides_voice_leading() {
    let mut state = device(true);
    run(&mut state, &[on(1, 67)]);
    run(&mut state, &[off(1, 67)]);
    run(&mut state, &[on(2, 70), on(3, 60)]);
    assert_eq!(sounding(&state), vec![64, 67, 72], "C with A# plays E G C whatever the previous chord");
}

#[test]
fn reset_forgets_the_previous_chord_of_voice_leading() {
    let mut state = device(true);
    run(&mut state, &[on(1, 67)]);
    state.clear();
    run(&mut state, &[on(2, 60)]);
    assert_eq!(sounding(&state), vec![60, 64, 67], "after a reset C starts in root position again");
}

#[test]
fn a_note_off_that_does_not_fit_keeps_its_note_for_later() {
    let mut state = device(false);
    run(&mut state, &[on(1, 60)]);
    let mut output = [off(0, 0); 1];
    let count = ChordKeys::transform(&mut state, &[off(1, 60)], &mut output);
    assert_eq!(count, 1);
    assert_eq!(state.sounding_len, 2, "two note-offs did not fit, their notes stay tracked");
    let mut out = [off(0, 0); 8];
    assert_eq!(state.release_all_into(0.0, &mut out), 2, "release_all still ends them");
}

//! The dummy arpeggiator core (`ingest` + `step`, driven by the device ABI's events): a held chord keeps
//! arpeggiating across blocks that carry NO new input (the held-note stack persists in state), the output
//! is not one-to-one (a few held notes become a stream of stepped on/off events), releasing the chord
//! stops new notes, and a transport jump releases everything held.

use abi::{BlockFlags, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_arp::{ingest, step, ArpState};

const PLAYING: u32 = BlockFlags::TRANSPORTING;

fn zeroed() -> ArpState {
    // The engine hands the device a zeroed state block; mirror that (empty stacks).
    unsafe { core::mem::zeroed() }
}

fn note(kind: u32, id: u32, pitch: u32) -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind, id, pitch, velocity: 0.8, cent: 0.0}
}

fn blank() -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0}
}

fn pitches(out: &[EventRecord], kind: u32) -> Vec<u32> {
    out.iter().filter(|event| event.kind == kind).map(|event| event.pitch).collect()
}

#[test]
fn arpeggiates_a_held_chord_across_blocks_with_no_new_input() {
    let mut state = zeroed();
    ingest(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 64), note(EVENT_NOTE_ON, 3, 67)]);
    let mut out = [blank(); 64];
    // block [0, 240): one 1/16 step at pulse 0 -> the first held note.
    let first = step(&mut state, 0.0, 240.0, PLAYING, &mut out);
    assert_eq!(pitches(&out[..first], EVENT_NOTE_ON), vec![60]);
    // block [240, 480) with NO new input: the chord persists in state, so the arp keeps going to the next
    // held note, and the previous step's note-off (end 120) now comes due.
    let second = step(&mut state, 240.0, 480.0, PLAYING, &mut out);
    assert_eq!(pitches(&out[..second], EVENT_NOTE_ON), vec![64], "keeps arpeggiating with no new input");
    assert_eq!(pitches(&out[..second], EVENT_NOTE_OFF), vec![60], "the prior note-off is scheduled");
}

#[test]
fn stops_emitting_when_the_chord_is_released() {
    let mut state = zeroed();
    ingest(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 64)]);
    let mut out = [blank(); 64];
    step(&mut state, 0.0, 240.0, PLAYING, &mut out);
    // release the whole chord (note-offs from upstream)
    ingest(&mut state, &[note(EVENT_NOTE_OFF, 1, 60), note(EVENT_NOTE_OFF, 2, 64)]);
    let count = step(&mut state, 240.0, 480.0, PLAYING, &mut out);
    assert!(pitches(&out[..count], EVENT_NOTE_ON).is_empty(), "no held notes -> no new arp notes");
}

#[test]
fn a_transport_jump_releases_everything_held() {
    let mut state = zeroed();
    ingest(&mut state, &[note(EVENT_NOTE_ON, 1, 60), note(EVENT_NOTE_ON, 2, 64)]);
    let mut out = [blank(); 64];
    step(&mut state, 0.0, 480.0, PLAYING, &mut out); // two steps -> two notes ringing
    let count = step(&mut state, 0.0, 10.0, PLAYING | BlockFlags::DISCONTINUOUS, &mut out);
    assert_eq!(pitches(&out[..count], EVENT_NOTE_OFF).len(), 2, "a transport jump releases all ringing notes");
}

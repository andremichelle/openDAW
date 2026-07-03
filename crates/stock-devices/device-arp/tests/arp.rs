//! The arpeggiator core (`process`, driven by the device ABI's events): a held chord keeps arpeggiating
//! across blocks that carry NO new input (the active-note spans persist in state), the output is not
//! one-to-one (a few held notes become a stream of stepped on/off events), releasing the chord stops new
//! notes, and a transport jump releases everything held. Rate is 1/16 (240 pulses) with the default gate 1.0
//! (step length == rate), so each step's note-off comes due exactly one step later.

use abi::{BlockFlags, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_arp::{process, seed, ArpState};

const PLAYING: u32 = BlockFlags::TRANSPORTING;

fn seeded() -> ArpState {
    // The engine hands a zeroed block, then calls `init`; `seed` applies the same defaults (1/16, up, 1 octave,
    // gate 1) without the extern's `u32` pointer (which truncates on a 64-bit native test build).
    let mut state: ArpState = unsafe { core::mem::zeroed() };
    seed(&mut state);
    state
}

fn held(pitch: u32) -> EventRecord {
    // A note held far past the test window, so it stays active across every block (span [0, 100000)).
    EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id: pitch, pitch, velocity: 0.8, cent: 0.0, duration: 100_000.0}
}

fn release(pitch: u32, position: f64) -> EventRecord {
    EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: pitch, pitch, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn blank() -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn pitches(out: &[EventRecord], kind: u32) -> Vec<u32> {
    out.iter().filter(|event| event.kind == kind).map(|event| event.pitch).collect()
}

#[test]
fn arpeggiates_a_held_chord_across_blocks_with_no_new_input() {
    let mut state = seeded();
    let mut out = [blank(); 64];
    // block [0, 240): chord arrives; one 1/16 step at pulse 0 -> the lowest held note (up mode).
    let first = process(&mut state, 0.0, 240.0, PLAYING, &[held(60), held(64), held(67)], &mut out);
    assert_eq!(pitches(&out[..first], EVENT_NOTE_ON), vec![60]);
    // block [240, 480) with NO new input: the chord persists in state, so the arp keeps going to the next
    // held note, and the previous step's note-off (complete 240) now comes due.
    let second = process(&mut state, 240.0, 480.0, PLAYING, &[], &mut out);
    assert_eq!(pitches(&out[..second], EVENT_NOTE_ON), vec![64], "keeps arpeggiating with no new input");
    assert_eq!(pitches(&out[..second], EVENT_NOTE_OFF), vec![60], "the prior note-off is scheduled");
}

#[test]
fn stops_emitting_when_the_chord_is_released() {
    let mut state = seeded();
    let mut out = [blank(); 64];
    process(&mut state, 0.0, 240.0, PLAYING, &[held(60), held(64)], &mut out);
    // release the whole chord at 240 (note-offs from upstream shorten the spans)
    let count = process(&mut state, 240.0, 480.0, PLAYING, &[release(60, 240.0), release(64, 240.0)], &mut out);
    assert!(pitches(&out[..count], EVENT_NOTE_ON).is_empty(), "no active notes -> no new arp notes");
}

#[test]
fn a_transport_jump_releases_everything_held_and_clears_the_source() {
    let mut state = seeded();
    let mut out = [blank(); 64];
    // [0, 240): one step at pulse 0 fires and is still ringing (gate 1.0 -> completes at 240, not < 240).
    process(&mut state, 0.0, 240.0, PLAYING, &[held(60), held(64)], &mut out);
    // A transport jump releases every ringing note AT `from`, and drops the held source notes.
    let jumped = process(&mut state, 240.0, 250.0, PLAYING | BlockFlags::DISCONTINUOUS, &[], &mut out);
    assert_eq!(pitches(&out[..jumped], EVENT_NOTE_OFF).len(), 1, "the ringing note is released");
    assert!(out[..jumped].iter().all(|event| event.position == 240.0), "released at `from`");
    // Nothing is left ringing or held: a following normal block with no input is silent.
    let after = process(&mut state, 250.0, 490.0, PLAYING, &[], &mut out);
    assert_eq!(after, 0, "the retainer and the source were cleared by the jump");
}

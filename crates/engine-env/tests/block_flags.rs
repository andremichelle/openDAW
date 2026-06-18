//! BlockFlags, ported from core-processors `processing.ts`: `create` builds the bitmask, `has` is the
//! all-bits-set test (TS `Bits.every`), and `clear_event_flags` drops only the one-shot event flags
//! while keeping the persistent state flags.

use engine_env::block_flags::BlockFlags;

#[test]
fn create_sets_exactly_the_requested_flags() {
    let flags = BlockFlags::create(true, false, true, false); // transporting + playing
    assert!(flags.transporting());
    assert!(flags.playing());
    assert!(!flags.discontinuous());
    assert!(!flags.bpm_changed());
}

#[test]
fn has_requires_every_bit_of_the_mask() {
    let flags = BlockFlags::create(true, false, true, false);
    assert!(flags.has(BlockFlags::TRANSPORTING | BlockFlags::PLAYING), "both bits present");
    assert!(!flags.has(BlockFlags::TRANSPORTING | BlockFlags::DISCONTINUOUS), "discontinuous missing");
}

#[test]
fn clear_event_flags_keeps_state_flags_and_drops_one_shot_flags() {
    let mut flags = BlockFlags::create(true, true, true, true); // all four set
    flags.clear_event_flags();
    assert!(flags.transporting(), "state flag survives");
    assert!(flags.playing(), "state flag survives");
    assert!(!flags.discontinuous(), "one-shot flag cleared");
    assert!(!flags.bpm_changed(), "one-shot flag cleared");
}

#[test]
fn default_is_no_flags() {
    let flags = BlockFlags::default();
    assert_eq!(flags.0, 0);
    assert!(!flags.transporting() && !flags.playing() && !flags.discontinuous() && !flags.bpm_changed());
}

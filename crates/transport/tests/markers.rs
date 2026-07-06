//! Marker-track playback in the block loop (TS `BlockRenderer`'s `--- MARKER ---` action): a marker
//! with `plays == N` repeats its section N times (a sample-exact split + jump back, the post-jump
//! block discontinuous) before falling through to the next marker; `plays == 0` repeats forever.
//! Markers are evaluated before the loop area, so a marker boundary on the loop end wins the tie
//! (TS: the loop only takes over when `loopTo < actionPosition`, strictly). A seek re-resolves the
//! active marker (plays reset when the section CHANGED), even while the track is disabled.

use transport::transport::{Block, Marker, Transport, RENDER_QUANTUM};

const A: [u8; 16] = [1u8; 16];
const B: [u8; 16] = [2u8; 16];

fn marker(uuid: [u8; 16], position: f64, plays: i32) -> Marker {
    Marker {uuid, position, plays}
}

fn render(transport: &mut Transport, markers: &[Marker], enabled: bool) -> Vec<Block> {
    let mut blocks = Vec::new();
    transport.render_quantum(None, markers, enabled, |block| blocks.push(*block));
    blocks
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!((actual - expected).abs() < 1.0e-9, "{}: {} vs {}", what, actual, expected);
}

// 128 samples @ 120 bpm / 48k = 5.12 pulses per quantum, 25 samples per pulse.

#[test]
fn plays_two_loops_the_section_twice_then_falls_through() {
    let markers = [marker(A, 0.0, 2), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    // quantum 0: entering A's section registers the marker without splitting the block
    let q0 = render(&mut transport, &markers, true);
    assert_eq!(q0.len(), 1);
    assert_eq!(q0[0].p0, 0.0);
    assert_close(q0[0].p1, 5.12, "q0 end");
    assert_eq!(transport.current_marker(), Some((A, 0)));
    assert!(transport.take_marker_changed());
    // quantum 1 crosses B at pulse 10: the FIRST repeat — sample-exact split, jump back to A
    let q1 = render(&mut transport, &markers, true);
    assert_eq!(q1.len(), 2, "the quantum splits at the marker boundary");
    assert_close(q1[0].p0, 5.12, "q1 start");
    assert_eq!(q1[0].p1, 10.0, "the split lands exactly on the boundary");
    // 4.88 pulses = 121.99999... samples; the TS `| 0` truncation (mirrored by `as i64`) floors to 121
    assert_eq!((q1[0].s0, q1[0].s1), (0, 121), "sample-exact split");
    assert!(!q1[0].discontinuous);
    assert_eq!((q1[1].p0, q1[1].s0, q1[1].s1), (0.0, 121, RENDER_QUANTUM), "resumes at the section start");
    assert!(q1[1].discontinuous, "the post-jump block flags discontinuous");
    assert_eq!(transport.current_marker(), Some((A, 1)), "the play count advanced across the jump");
    assert!(transport.take_marker_changed());
    // quantum 2 stays inside the section
    let q2 = render(&mut transport, &markers, true);
    assert_eq!(q2.len(), 1);
    assert!(!transport.take_marker_changed());
    // quantum 3 crosses B again: plays (2) exhausted — falls through WITHOUT a split or jump
    let q3 = render(&mut transport, &markers, true);
    assert_eq!(q3.len(), 1, "falling through keeps the block whole");
    assert!(!q3[0].discontinuous);
    assert_close(q3[0].p0, 5.4, "q3 start (0.28 pulses carried over the jump)");
    assert_close(q3[0].p1, 10.52, "q3 end");
    assert_eq!(transport.current_marker(), Some((B, 0)), "B's section became active");
    assert!(transport.take_marker_changed());
    assert_close(transport.position(), 10.52, "playback continued past the boundary");
}

#[test]
fn plays_one_falls_through_immediately() {
    let markers = [marker(A, 0.0, 1), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    let mut discontinuities = 0;
    for _ in 0..8 {
        for block in render(&mut transport, &markers, true) {
            if block.discontinuous {
                discontinuities += 1;
            }
        }
    }
    assert_eq!(discontinuities, 0, "plays=1 never jumps back");
    assert_close(transport.position(), 8.0 * 5.12, "position after eight quanta");
    assert_eq!(transport.current_marker(), Some((B, 0)));
}

#[test]
fn plays_zero_repeats_the_section_forever() {
    let markers = [marker(A, 0.0, 0), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    for _ in 0..40 {
        render(&mut transport, &markers, true);
        assert!(transport.position() < 10.0, "stayed inside the section; position={}", transport.position());
    }
    let (uuid, count) = transport.current_marker().unwrap();
    assert_eq!(uuid, A);
    assert!(count >= 20, "the play count keeps advancing: {}", count);
}

#[test]
fn a_marker_boundary_on_the_loop_end_wins_the_tie() {
    // loop [5, 10) and B at 10: TS evaluates the marker first and the loop needs `loopTo < actionPosition`,
    // so the jump goes to the SECTION start (0), not the loop start (5).
    let markers = [marker(A, 0.0, 0), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(5.0);
    transport.set_loop_to(10.0);
    transport.play();
    render(&mut transport, &markers, true);
    let q1 = render(&mut transport, &markers, true);
    assert_eq!(q1.len(), 2);
    assert_eq!(q1[1].p0, 0.0, "the marker jump won over the loop wrap");
    assert_eq!(transport.current_marker(), Some((A, 1)));
}

#[test]
fn a_strictly_earlier_loop_end_wins_over_the_marker() {
    // loop end 9 < marker boundary 10: the loop wraps first; the re-resolve at the loop start keeps
    // the same section, so the play count survives the wrap.
    let markers = [marker(A, 0.0, 2), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(5.0);
    transport.set_loop_to(9.0);
    transport.play();
    render(&mut transport, &markers, true);
    transport.take_marker_changed();
    let q1 = render(&mut transport, &markers, true);
    assert_eq!(q1.len(), 2);
    assert_eq!((q1[0].p1, q1[1].p0), (9.0, 5.0), "wrapped at the loop, not the marker");
    assert!(q1[1].discontinuous);
    assert_eq!(transport.current_marker(), Some((A, 0)), "same section: the play count is untouched");
    assert!(!transport.take_marker_changed());
}

#[test]
fn a_seek_into_another_section_resets_the_plays_and_a_seek_within_keeps_them() {
    let markers = [marker(A, 0.0, 3), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    render(&mut transport, &markers, true);
    render(&mut transport, &markers, true); // first repeat: count 1
    assert_eq!(transport.current_marker(), Some((A, 1)));
    transport.take_marker_changed();
    transport.seek(2.0); // within A's section: TS only resets when the marker CHANGED
    render(&mut transport, &markers, true);
    assert_eq!(transport.current_marker(), Some((A, 1)), "seek within the section keeps the count");
    assert!(!transport.take_marker_changed());
    transport.seek(15.0); // into B's section
    render(&mut transport, &markers, true);
    assert_eq!(transport.current_marker(), Some((B, 0)), "seek into another section resets");
    assert!(transport.take_marker_changed());
    transport.seek(2.0); // back into A: count restarts at 0
    render(&mut transport, &markers, true);
    assert_eq!(transport.current_marker(), Some((A, 0)));
    assert!(transport.take_marker_changed());
}

#[test]
fn a_disabled_track_never_jumps_but_a_seek_still_resolves_the_marker() {
    // TS gates only the ACTION on `markerTrack.enabled`; the seek re-resolution runs regardless.
    let markers = [marker(A, 0.0, 0), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    for _ in 0..8 {
        for block in render(&mut transport, &markers, false) {
            assert!(!block.discontinuous);
        }
    }
    assert_close(transport.position(), 8.0 * 5.12, "no marker held the position back");
    assert_eq!(transport.current_marker(), None, "no action ever registered a marker");
    transport.seek(12.0);
    render(&mut transport, &markers, false);
    assert_eq!(transport.current_marker(), Some((B, 0)), "the seek re-resolution ignores the enabled flag");
    assert!(transport.take_marker_changed());
}

#[test]
fn disabling_the_track_mid_play_keeps_the_active_marker() {
    let markers = [marker(A, 0.0, 0), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    render(&mut transport, &markers, true);
    render(&mut transport, &markers, true); // jumped once: count 1
    assert_eq!(transport.current_marker(), Some((A, 1)));
    transport.take_marker_changed();
    for _ in 0..8 {
        render(&mut transport, &markers, false);
    }
    assert!(transport.position() > 10.0, "disabled: playback escapes the section");
    assert_eq!(transport.current_marker(), Some((A, 1)), "the marker state is retained (TS keeps #currentMarker)");
    assert!(!transport.take_marker_changed());
}

#[test]
fn reset_forgets_the_marker_silently_and_paused_renders_resolve_at_the_frozen_position() {
    let markers = [marker(A, 0.0, 2), marker(B, 10.0, 1)];
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.play();
    render(&mut transport, &markers, true);
    transport.take_marker_changed();
    transport.stop(true);
    transport.reset_marker_state(); // the engine's STOP path (TS #reset -> renderer.reset())
    assert_eq!(transport.current_marker(), None);
    assert!(!transport.take_marker_changed(), "reset notifies nothing (TS reset raises no markerChanged)");
    // paused (leap still raised by the stop-rewind): the not-transporting branch resolves at `position`
    transport.render_paused(&markers);
    assert_eq!(transport.current_marker(), Some((A, 0)), "the paused re-resolution found the marker at 0");
    assert!(transport.take_marker_changed());
    // a paused seek resolves too, and only towards a FOUND marker (TS never clears to null here)
    transport.seek(11.0);
    transport.render_paused(&markers);
    assert_eq!(transport.current_marker(), Some((B, 0)));
    assert!(transport.take_marker_changed());
}

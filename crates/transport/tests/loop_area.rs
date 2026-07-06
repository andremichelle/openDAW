//! Loop-area handling in the block loop: disabled = no wrap; enabled = the quantum splits at the
//! loop end into a partial block, then position jumps back to the loop start and keeps filling the
//! quantum; and on a wrap the bpm is re-evaluated at the loop start (the discontinuity).

use transport::transport::{Block, Transport, RENDER_QUANTUM};
use value::event::EventCollection;
use value::value::{Interpolation, ValueEvent};

fn render(transport: &mut Transport, tempo: Option<&EventCollection<ValueEvent>>) -> Vec<Block> {
    let mut blocks = Vec::new();
    transport.render_quantum(tempo, &[], false, |block| blocks.push(*block));
    blocks
}

#[test]
fn loop_disabled_advances_through_the_whole_quantum() {
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.set_loop_enabled(false);
    transport.set_loop_from(0.0);
    transport.set_loop_to(3.0);
    transport.play();
    let blocks = render(&mut transport, None);
    assert_eq!(blocks.len(), 1, "no loop -> one block for the whole quantum");
    assert_eq!((blocks[0].s0, blocks[0].s1), (0, RENDER_QUANTUM));
    // 128 samples @ 120 bpm / 48k = 5.12 pulses: the whole quantum renders as one block, straight
    // past the loop end at 3.0 (no wrap).
    assert_eq!(transport.position(), 5.12);
}

#[test]
fn loop_wraps_within_a_quantum() {
    // 120 bpm @ 48k: a quantum spans 5.12 pulses, so a loop end at 3.0 falls inside one quantum.
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(0.0);
    transport.set_loop_to(3.0);
    transport.play();
    let blocks = render(&mut transport, None);
    assert_eq!(blocks.len(), 2, "the quantum splits at the loop end, then resumes from the loop start");
    // first block: from the start up to the loop end
    assert_eq!(blocks[0].p0, 0.0);
    assert_eq!(blocks[0].p1, 3.0);
    assert_eq!(blocks[0].s0, 0);
    assert_eq!(blocks[0].s1, 75); // pulses_to_samples(3.0, 120, 48000)
    // second block: resumes at the loop start, contiguous sample offsets filling the rest
    assert_eq!(blocks[1].p0, 0.0);
    assert_eq!(blocks[1].s0, 75);
    assert_eq!(blocks[1].s1, RENDER_QUANTUM);
    assert!(transport.position() > 0.0 && transport.position() < 3.0, "ended wrapped inside the loop");
}

#[test]
fn the_block_resuming_after_a_loop_wrap_is_flagged_discontinuous() {
    // same wrap-within-a-quantum setup; capture the discontinuity flag per emitted block.
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(0.0);
    transport.set_loop_to(3.0);
    transport.play();
    let mut flags = Vec::new();
    transport.render_quantum(None, &[], false, |block| flags.push(block.discontinuous));
    assert_eq!(flags, vec![false, true], "pre-wrap block continuous, the block resuming at the loop start discontinuous");
}

#[test]
fn loop_reevaluates_tempo_at_the_loop_start() {
    // linear bpm map: 30 @ pulse 0 .. 300 @ pulse 100. Start at pulse 2.0 (bpm ~35.4), loop end 2.5,
    // loop start 0 (bpm 30) -> after the wrap the live bpm must drop to ~30, not stay at ~35.
    let mut tempo = EventCollection::new();
    tempo.add(ValueEvent::new(0.0, 0, 30.0, Interpolation::Linear));
    tempo.add(ValueEvent::new(100.0, 0, 300.0, Interpolation::Linear));
    let mut transport = Transport::new(48_000.0, 120.0);
    transport.seek(2.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(0.0);
    transport.set_loop_to(2.5);
    transport.play();
    let blocks = render(&mut transport, Some(&tempo));
    assert!(blocks.len() >= 2, "splits at the loop end");
    assert_eq!(blocks[0].p0, 2.0);
    assert_eq!(blocks[0].p1, 2.5);
    assert!(transport.bpm() < 31.0, "bpm re-evaluated at the loop start (~30), was ~35 before the wrap: {}", transport.bpm());
}

#[test]
fn loop_wraps_when_its_end_coincides_with_a_tempo_grid() {
    // Regression: loop_to (80) is an exact multiple of the 80-pulse tempo grid, and the bpm changes
    // there. The loop must win that tie — otherwise the tempo split advances the position exactly onto
    // loop_to and the wrap (p0 < loop_to) never fires, so playback escapes the loop.
    let mut tempo = EventCollection::new();
    tempo.add(ValueEvent::new(0.0, 0, 100.0, Interpolation::Linear));
    tempo.add(ValueEvent::new(160.0, 0, 200.0, Interpolation::Linear));
    let mut transport = Transport::new(8_000.0, 100.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(0.0);
    transport.set_loop_to(80.0); // 80 = exactly one tempo grid
    transport.play();
    for _ in 0..30 {
        transport.render_quantum(Some(&tempo), &[], false, |_| {});
        assert!(transport.position() < 80.0, "stayed inside the loop; position={}", transport.position());
    }
}

use engine_env::ppqn::{frame_at, samples_to_pulses};
use transport::transport::{Block, Transport, RENDER_QUANTUM};

// Every whole-frame pulse inside a block, as (pulse, its frame in the quantum).
fn whole_frames_inside(block: &Block, first_frame: usize, sample_rate: f32) -> Vec<(f64, i64)> {
    (block.p0.ceil() as i64..=block.p1 as i64).filter_map(|pulse| {
        let exact = pulse as f64 * sample_rate as f64 / 1920.0;
        let frame = exact as usize;
        let inside = frame > first_frame + block.s0 && frame < first_frame + block.s1;
        (exact.fract() == 0.0 && inside).then_some((pulse as f64, (frame - first_frame) as i64))
    }).collect()
}

#[test]
fn a_whole_frame_inside_a_block_converts_to_that_frame() {
    // #536: every whole-frame pulse inside a block over 4 s at 120 bpm lands on its frame, counted from the anchor.
    for (sample_rate, expected_positions) in [(48000.0f32, 7620), (44100.0, 238)] {
        let mut transport = Transport::new(sample_rate, 120.0);
        transport.play();
        let (mut positions, mut off) = (0, 0);
        for quantum in 0..(4.0 * sample_rate) as usize / RENDER_QUANTUM {
            let block = transport.process_quantum();
            for (pulse, frame) in whole_frames_inside(&block, quantum * RENDER_QUANTUM, sample_rate) {
                positions += 1;
                if frame_at(pulse, block.anchor, block.anchor_frame, block.bpm, sample_rate) != frame {off += 1}
            }
        }
        assert_eq!(positions, expected_positions, "{sample_rate}: whole-frame positions inside a block");
        assert_eq!(off, 0, "{sample_rate}: positions off their frame");
    }
}

#[test]
fn a_loop_wrap_keeps_whole_frames_exact() {
    // A 1001-pulse loop wraps mid-quantum, so blocks start partway into a quantum and re-anchor at the loop start.
    let sample_rate = 48000.0f32;
    let mut transport = Transport::new(sample_rate, 120.0);
    transport.set_loop_enabled(true);
    transport.set_loop_from(0.0);
    transport.set_loop_to(1001.0);
    transport.play();
    // at 48 kHz / 120 bpm a pulse is 25 frames, so pass n starts on frame 25025 * n and pulse k plays 25 * k later
    let (mut positions, mut off) = (0, 0);
    for quantum in 0..1000usize {
        let mut blocks = Vec::new();
        transport.render_quantum(None, &[], false, |block| blocks.push(*block));
        for block in blocks {
            let first_frame = quantum * RENDER_QUANTUM;
            let pass_start = (first_frame + block.s0) / 25025 * 25025;
            for pulse in block.p0.ceil() as i64..=block.p1 as i64 {
                let pulse = pulse as f64;
                let expected = (pass_start + pulse as usize * 25) as i64 - first_frame as i64;
                if pulse <= block.p0 || pulse >= block.p1 || expected <= block.s0 as i64 {continue}
                positions += 1;
                if frame_at(pulse, block.anchor, block.anchor_frame, block.bpm, sample_rate) != expected {off += 1}
            }
        }
    }
    assert!(positions > 5000, "positions checked over several passes");
    assert_eq!(off, 0, "pulses in every pass land on their frames");
}

#[test]
fn quantum_advances_position() {
    let (sample_rate, bpm) = (48000.0, 140.0);
    let mut transport = Transport::new(sample_rate, bpm);
    transport.play();
    let step = samples_to_pulses(RENDER_QUANTUM as f64, bpm, sample_rate);
    let first = transport.process_quantum();
    assert_eq!(first.p0, 0.0);
    assert!((first.p1 - step).abs() < 1e-12);
    assert_eq!((first.s0, first.s1), (0, 128));
    let second = transport.process_quantum();
    assert!((second.p0 - step).abs() < 1e-12);
    assert!((transport.position() - 2.0 * step).abs() < 1e-9);
}

#[test]
fn per_quantum_position_carries_no_accumulated_error() {
    // #533: the position after N quanta is the frame count converted once, not N summed quantum lengths.
    let (sample_rate, bpm) = (48000.0, 140.0);
    let mut transport = Transport::new(sample_rate, bpm);
    transport.play();
    for _ in 0..2000 {
        transport.process_quantum();
    }
    assert_eq!(transport.position(), 2000.0 * 128.0 * 140.0 * 960.0 / (60.0 * 48000.0));
    // 4 s at 137 bpm is exactly 8768 pulses
    let mut transport = Transport::new(48000.0, 137.0);
    transport.play();
    for _ in 0..1500 {
        transport.process_quantum();
    }
    assert_eq!(transport.position(), 8768.0);
}

#[test]
fn seek_play_stop() {
    let mut transport = Transport::new(48000.0, 120.0);
    transport.seek(5000.0);
    assert_eq!(transport.position(), 5000.0);
    transport.play();
    assert!(transport.is_playing());
    transport.stop(false);
    assert!(!transport.is_playing());
    assert_eq!(transport.position(), 5000.0); // stop without reset keeps position
    transport.stop(true);
    assert_eq!(transport.position(), 0.0);
}

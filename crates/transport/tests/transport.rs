use engine_env::ppqn::samples_to_pulses;
use transport::transport::{Transport, RENDER_QUANTUM};

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
fn per_quantum_accumulation_is_exact() {
    // Advancing N quanta one-by-one must match a step-by-step reference exactly (same summation
    // order as the TS engine), so positions stay bit-identical over a long render.
    let (sample_rate, bpm) = (48000.0, 140.0);
    let mut transport = Transport::new(sample_rate, bpm);
    transport.play();
    let mut reference = 0.0;
    for _ in 0..2000 {
        transport.process_quantum();
        reference += samples_to_pulses(RENDER_QUANTUM as f64, bpm, sample_rate);
    }
    assert_eq!(transport.position(), reference);
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

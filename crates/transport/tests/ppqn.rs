use transport::ppqn::*;

#[test]
fn constants_match_ts() {
    assert_eq!(QUARTER, 960.0);
    assert_eq!(BAR, 3840.0);
    assert_eq!(SEMI_QUAVER, 240.0);
}

#[test]
fn from_signature_values() {
    assert_eq!(from_signature(4, 4), 3840.0);
    assert_eq!(from_signature(3, 4), 2880.0);
    assert_eq!(from_signature(6, 8), 2880.0);
    assert_eq!(from_signature(7, 8), 3360.0);
}

#[test]
fn seconds_pulses_round_trip() {
    // 120 bpm: one second = two quarter notes = 1920 pulses.
    assert_eq!(seconds_to_pulses(1.0, 120.0), 1920.0);
    assert_eq!(pulses_to_seconds(1920.0, 120.0), 1.0);
    for (bpm, seconds) in [(140.0, 0.5), (90.0, 2.0), (200.0, 0.01)] {
        let pulses = seconds_to_pulses(seconds, bpm);
        assert!((pulses_to_seconds(pulses, bpm) - seconds).abs() < 1e-9);
    }
}

#[test]
fn samples_pulses_round_trip() {
    let (bpm, sample_rate) = (140.0, 48000.0);
    for samples in [128.0, 4410.0, 96000.0] {
        let pulses = samples_to_pulses(samples, bpm, sample_rate);
        assert!((pulses_to_samples(pulses, bpm, sample_rate) - samples).abs() < 1e-6);
    }
}

#[test]
fn one_quarter_at_140_bpm() {
    // 960 pulses (one quarter) at 140 bpm = 60/140 seconds.
    assert!((pulses_to_seconds(960.0, 140.0) - 60.0 / 140.0).abs() < 1e-12);
}

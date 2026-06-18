//! MIDI pitch → frequency: A4 (69) = 440 Hz, octaves double, middle C ≈ 261.6 Hz, cents shift.

use dsp::midi_to_hz;

#[test]
fn a4_is_440() {
    assert!((midi_to_hz(69.0) - 440.0).abs() < 1e-3);
}

#[test]
fn octave_up_doubles() {
    assert!((midi_to_hz(81.0) - 880.0).abs() < 1e-2);
    assert!((midi_to_hz(57.0) - 220.0).abs() < 1e-2);
}

#[test]
fn middle_c_is_about_261_6() {
    assert!((midi_to_hz(60.0) - 261.6256).abs() < 1e-2);
}

#[test]
fn cents_shift_a_fraction_of_a_semitone() {
    // +100 cents (one semitone) from A4 equals note 70.
    assert!((midi_to_hz(69.0 + 1.0) - midi_to_hz(70.0)).abs() < 1e-3);
}

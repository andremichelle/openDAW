//! DSP primitives for the feature crates. The shared math lives in the `math` crate (the lib-std
//! equivalent); this re-exports the pieces the feature crates already use (`fast_sin`, `fabs`, `PI`)
//! and holds genuinely DSP-specific code: the ADSR envelope and the MIDI-pitch → frequency mapping.

#![cfg_attr(not(test), no_std)]

pub mod adsr;
pub mod analyser;
pub mod autotune;
pub mod biquad;
pub mod crusher;
pub mod dattorro;
pub mod fast_math;
pub mod ctagdrc;
pub mod freeverb;
pub mod glide;
pub mod lfo;
pub mod meter;
pub mod osc;
pub mod panning;
pub mod ppqn;
pub mod psola;
pub mod ramp;
pub mod resampler;
pub mod simple_limiter;
pub mod smooth;
pub mod tidal;
pub mod vocoder;
pub mod waveshaper;

pub use math::{clamp, fabs, fast_sin, PI};

/// `ln(10) / 20`, the decibel → linear-gain exponent base, mirroring lib-dsp `utils.LogDb`.
const LOG_DB: f32 = 0.115_129_255; // (ln 10) / 20

/// A decibel value to a linear gain, `exp(db * ln(10)/20)`. Mirrors lib-dsp `dbToGain`.
pub fn db_to_gain(db: f32) -> f32 {
    libm::expf(db * LOG_DB)
}

/// A linear gain to a decibel value, `ln(gain) / (ln(10)/20)`. Mirrors lib-dsp `gainToDb`.
pub fn gain_to_db(gain: f32) -> f32 {
    libm::logf(gain) / LOG_DB
}

/// The host's fixed render quantum in samples (Web Audio's 128-frame block), mirroring lib-dsp `RenderQuantum`.
/// A device sizes its per-block scratch to this: an inter-event processing chunk never exceeds one quantum.
pub const RENDER_QUANTUM: usize = 128;

/// A MIDI pitch (note 69 = A4 = 440 Hz), with a fractional part for cents, to frequency in Hz.
/// Mirrors lib-dsp `midiToHz` at the 440 Hz reference: `440 * 2^((note + 3)/12 - 6)`. Callers whose TS
/// counterpart also fixes the base at 440 (e.g. the Soundfont pitch ratio) stay on this one.
pub fn midi_to_hz(note: f32) -> f32 {
    midi_to_hz_base(note, 440.0)
}

/// [`midi_to_hz`] at an explicit tuning reference, mirroring lib-dsp `midiToHz(note, baseFrequency)`:
/// `baseFrequency * 2^((note + 3)/12 - 6)`. A device whose TS counterpart reads
/// `EngineContext.baseFrequency` (the Vaporisateur) passes `abi::base_frequency()` here.
pub fn midi_to_hz_base(note: f32, base_frequency: f32) -> f32 {
    base_frequency * libm::exp2f((note + 3.0) / 12.0 - 6.0)
}

/// A note velocity (0..1) to a linear gain. Mirrors lib-dsp `velocityToGain`, which is `dbToGain(20 *
/// log10(velocity))` — that reduces exactly to the identity, so a velocity passes straight through as gain.
pub fn velocity_to_gain(velocity: f32) -> f32 {
    velocity
}

/// Filter keyboard tracking: how far a `note` (MIDI pitch) is above middle C (60), scaled by `amount` and
/// clamped to `0..1`. Mirrors lib-dsp `MidiKeys.keyboardTracking` — added to a unit cutoff so higher notes
/// open the filter.
pub fn keyboard_tracking(note: f32, amount: f32) -> f32 {
    clamp((note - 60.0) * amount, 0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_to_hz_matches_the_440_reference() {
        assert_eq!(midi_to_hz(69.0), 440.0);
        assert_eq!(midi_to_hz(69.0), midi_to_hz_base(69.0, 440.0));
        assert!((midi_to_hz(57.0) - 220.0).abs() < 1.0e-4);
    }

    #[test]
    fn midi_to_hz_base_scales_linearly_with_the_tuning_reference() {
        assert_eq!(midi_to_hz_base(69.0, 432.0), 432.0);
        assert_eq!(midi_to_hz_base(69.0, 466.16), 466.16);
        // the base multiplies the same exp2 term, so every pitch shifts by the base ratio
        for pitch in [21.0, 60.0, 69.5, 108.0] {
            let reference = midi_to_hz_base(pitch, 440.0);
            let detuned = midi_to_hz_base(pitch, 432.0);
            assert!((detuned / reference - 432.0 / 440.0).abs() < 1.0e-6, "pitch {pitch}: {detuned} vs {reference}");
        }
    }
}

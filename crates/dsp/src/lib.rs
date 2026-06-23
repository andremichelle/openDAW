//! DSP primitives for the feature crates. The shared math lives in the `math` crate (the lib-std
//! equivalent); this re-exports the pieces the feature crates already use (`fast_sin`, `fabs`, `PI`)
//! and holds genuinely DSP-specific code: the ADSR envelope and the MIDI-pitch → frequency mapping.

#![cfg_attr(not(test), no_std)]

pub mod adsr;
pub mod biquad;
pub mod ppqn;
pub mod smooth;
pub mod tidal;

pub use math::{fabs, fast_sin, PI};

/// A MIDI pitch (note 69 = A4 = 440 Hz), with a fractional part for cents, to frequency in Hz.
/// Mirrors lib-dsp `midiToHz` at the 440 Hz reference: `440 * 2^((note + 3)/12 - 6)`.
pub fn midi_to_hz(note: f32) -> f32 {
    440.0 * libm::exp2f((note + 3.0) / 12.0 - 6.0)
}

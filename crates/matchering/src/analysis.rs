// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

use crate::config::{FFT_SIZE, MAX_LENGTH, RMS_CORRECTION_STEPS};
use crate::frequencies::{average_spectrum, convolve_same, fir, matching_curve};
use crate::levels::{loudest, rms_coefficient, Pieces, Stereo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    TooShort,
    TooLong,
    LengthMismatch
}

/// Everything the matching reads from a reference, so a reference does not have to be audio.
#[derive(Debug, Clone, PartialEq)]
pub struct ReferenceProfile {
    pub match_rms: f64,
    pub final_amplitude: f64,
    pub mid_spectrum: Vec<f64>,
    pub side_spectrum: Vec<f64>
}

/// What the runtime applies: mid/side FIRs from the curves, then the gain, then the final amplitude.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchResult {
    pub gain: f64,
    pub final_amplitude: f64,
    pub mid_curve: Vec<f64>,
    pub side_curve: Vec<f64>
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Levels,
    Frequencies,
    Correction
}

fn validate<S: Copy + Into<f64>>(stereo: &Stereo<S>) -> Result<(), Error> {
    if stereo.left.len() != stereo.right.len() {return Err(Error::LengthMismatch);}
    if stereo.len() <= FFT_SIZE {return Err(Error::TooShort);}
    if stereo.len() > MAX_LENGTH {return Err(Error::TooLong);}
    Ok(())
}

/// 44.1 kHz stereo input, mono is passed as the same channel twice.
pub fn analyse_reference<S: Copy + Into<f64>>(left: &[S], right: &[S]) -> Result<ReferenceProfile, Error> {
    let mut stereo = Stereo::new(left, right);
    validate(&stereo)?;
    let final_amplitude = stereo.normalize_coefficient();
    stereo.scale = 1.0 / final_amplitude;
    let pieces = Pieces::of(stereo.len());
    let (indices, match_rms) = loudest(&pieces.rmses(|index| stereo.mid(index)));
    Ok(ReferenceProfile {
        match_rms,
        final_amplitude,
        mid_spectrum: average_spectrum(&pieces, &indices, |index| stereo.mid(index)),
        side_spectrum: average_spectrum(&pieces, &indices, |index| stereo.side(index))
    })
}

/// 44.1 kHz stereo input, mono is passed as the same channel twice.
/// `curve_limit_db` clamps both curves (bin 0 stays 0) before the level correction measures them, `None` keeps
/// Matchering's unlimited curves.
pub fn match_target<S: Copy + Into<f64>>(left: &[S], right: &[S], profile: &ReferenceProfile, curve_limit_db: Option<f64>,
                                        progress: &mut dyn FnMut(Stage)) -> Result<MatchResult, Error> {
    let stereo = Stereo::new(left, right);
    validate(&stereo)?;
    progress(Stage::Levels);
    let pieces = Pieces::of(stereo.len());
    let (indices, match_rms) = loudest(&pieces.rmses(|index| stereo.mid(index)));
    let mut gain = rms_coefficient(match_rms, profile.match_rms);
    progress(Stage::Frequencies);
    let mid_spectrum = average_spectrum(&pieces, &indices, |index| stereo.mid(index) * gain);
    let side_spectrum = average_spectrum(&pieces, &indices, |index| stereo.side(index) * gain);
    let mut mid_curve = matching_curve(&mid_spectrum, &profile.mid_spectrum);
    let mut side_curve = matching_curve(&side_spectrum, &profile.side_spectrum);
    if let Some(limit) = curve_limit_db {
        let (low, high) = (10f64.powf(-limit / 20.0), 10f64.powf(limit / 20.0));
        mid_curve[1..].iter_mut().chain(side_curve[1..].iter_mut()).for_each(|value| *value = value.clamp(low, high));
    }
    progress(Stage::Correction);
    let convolved_mid = convolve_same(stereo.len(), |index| stereo.mid(index), &fir(&mid_curve));
    for _ in 0..RMS_CORRECTION_STEPS {
        let (_, clipped_match_rms) = loudest(&pieces.rmses(|index| (convolved_mid[index] * gain).clamp(-1.0, 1.0)));
        gain *= rms_coefficient(clipped_match_rms, profile.match_rms);
    }
    Ok(MatchResult {gain, final_amplitude: profile.final_amplitude, mid_curve, side_curve})
}

/// The matched audio without limiter (Matchering's `result_no_limiter`).
pub fn apply<S: Copy + Into<f64>>(left: &[S], right: &[S], result: &MatchResult) -> (Vec<f64>, Vec<f64>) {
    let stereo = Stereo::new(left, right);
    let mid = convolve_same(stereo.len(), |index| stereo.mid(index), &fir(&result.mid_curve));
    let side = convolve_same(stereo.len(), |index| stereo.side(index), &fir(&result.side_curve));
    mid.iter().zip(&side)
        .map(|(mid, side)| ((mid + side) * result.gain, (mid - side) * result.gain))
        .unzip()
}

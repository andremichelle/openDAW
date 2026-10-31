// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

use crate::config::{FFT_SIZE, MAX_LENGTH, RMS_CORRECTION_STEPS};
use crate::frequencies::{average_spectrum, convolve_same, fir, matching_curve};
use crate::levels::{loudest, normalize_coefficient, rms_coefficient, to_mid_side, Pieces};

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

fn validate(left: &[f64], right: &[f64]) -> Result<(), Error> {
    if left.len() != right.len() {return Err(Error::LengthMismatch);}
    if left.len() <= FFT_SIZE {return Err(Error::TooShort);}
    if left.len() > MAX_LENGTH {return Err(Error::TooLong);}
    Ok(())
}

fn as_slices(values: &[Vec<f64>]) -> Vec<&[f64]> {values.iter().map(Vec::as_slice).collect()}

fn loudest_pieces<'a>(pieces: &Pieces, indices: &[usize], values: &'a [f64]) -> Vec<&'a [f64]> {
    indices.iter().map(|index| pieces.slice(values, *index)).collect()
}

/// 44.1 kHz stereo input, mono is passed as the same channel twice.
pub fn analyse_reference(left: &[f64], right: &[f64]) -> Result<ReferenceProfile, Error> {
    validate(left, right)?;
    let final_amplitude = normalize_coefficient(left, right);
    let left: Vec<f64> = left.iter().map(|value| value / final_amplitude).collect();
    let right: Vec<f64> = right.iter().map(|value| value / final_amplitude).collect();
    let (mid, side) = to_mid_side(&left, &right);
    let pieces = Pieces::of(mid.len());
    let (indices, match_rms) = loudest(&pieces.rmses(&mid));
    Ok(ReferenceProfile {
        match_rms,
        final_amplitude,
        mid_spectrum: average_spectrum(&loudest_pieces(&pieces, &indices, &mid)),
        side_spectrum: average_spectrum(&loudest_pieces(&pieces, &indices, &side))
    })
}

/// 44.1 kHz stereo input, mono is passed as the same channel twice.
pub fn match_target(left: &[f64], right: &[f64], profile: &ReferenceProfile) -> Result<MatchResult, Error> {
    validate(left, right)?;
    let (mid, side) = to_mid_side(left, right);
    let pieces = Pieces::of(mid.len());
    let (indices, match_rms) = loudest(&pieces.rmses(&mid));
    let mut gain = rms_coefficient(match_rms, profile.match_rms);
    let scale = |values: Vec<&[f64]>| -> Vec<Vec<f64>> {
        values.iter().map(|piece| piece.iter().map(|value| value * gain).collect()).collect()
    };
    let mid_loudest = scale(loudest_pieces(&pieces, &indices, &mid));
    let side_loudest = scale(loudest_pieces(&pieces, &indices, &side));
    let mid_curve = matching_curve(&average_spectrum(&as_slices(&mid_loudest)), &profile.mid_spectrum);
    let side_curve = matching_curve(&average_spectrum(&as_slices(&side_loudest)), &profile.side_spectrum);
    let mut result_mid: Vec<f64> = convolve_same(&mid, &fir(&mid_curve)).iter().map(|value| value * gain).collect();
    for _ in 0..RMS_CORRECTION_STEPS {
        let clipped: Vec<f64> = result_mid.iter().map(|value| value.clamp(-1.0, 1.0)).collect();
        let (_, clipped_match_rms) = loudest(&pieces.rmses(&clipped));
        let correction = rms_coefficient(clipped_match_rms, profile.match_rms);
        result_mid.iter_mut().for_each(|value| *value *= correction);
        gain *= correction;
    }
    Ok(MatchResult {gain, final_amplitude: profile.final_amplitude, mid_curve, side_curve})
}

/// The matched audio without limiter (Matchering's `result_no_limiter`).
pub fn apply(left: &[f64], right: &[f64], result: &MatchResult) -> (Vec<f64>, Vec<f64>) {
    let (mid, side) = to_mid_side(left, right);
    let mid = convolve_same(&mid, &fir(&result.mid_curve));
    let side = convolve_same(&side, &fir(&result.side_curve));
    mid.iter().zip(&side)
        .map(|(mid, side)| ((mid + side) * result.gain, (mid - side) * result.gain))
        .unzip()
}

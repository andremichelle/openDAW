// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

use crate::config::{MAX_PIECE_SIZE, MIN_VALUE, THRESHOLD};

pub fn to_mid_side(left: &[f64], right: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let mid = left.iter().zip(right).map(|(left, right)| (left + right) * 0.5).collect();
    let side = left.iter().zip(right).map(|(left, right)| (left + right) * 0.5 - right).collect();
    (mid, side)
}

pub fn rms(values: &[f64]) -> f64 {
    (values.iter().map(|value| value * value).sum::<f64>() / values.len() as f64).sqrt()
}

/// `normalize(..., normalize_clipped=False)`: the gain dividing the audio up to the threshold, 1 if already there.
pub fn normalize_coefficient(left: &[f64], right: &[f64]) -> f64 {
    let peak = left.iter().chain(right).fold(0.0f64, |peak, value| peak.max(value.abs()));
    if peak < THRESHOLD {MIN_VALUE.max(peak / THRESHOLD)} else {1.0}
}

pub struct Pieces {
    pub divisions: usize,
    pub size: usize
}

impl Pieces {
    pub fn of(length: usize) -> Self {
        let divisions = (length as f64 / MAX_PIECE_SIZE as f64) as usize + 1;
        Self {divisions, size: (length as f64 / divisions as f64) as usize}
    }

    pub fn slice<'a>(&self, values: &'a [f64], index: usize) -> &'a [f64] {
        &values[index * self.size..(index + 1) * self.size]
    }

    pub fn rmses(&self, values: &[f64]) -> Vec<f64> {
        (0..self.divisions).map(|index| rms(self.slice(values, index))).collect()
    }
}

/// Indices of the pieces at or above the average RMS and the RMS of their RMSes.
pub fn loudest(rmses: &[f64]) -> (Vec<usize>, f64) {
    let average = rms(rmses);
    let indices: Vec<usize> = (0..rmses.len()).filter(|index| rmses[*index] >= average).collect();
    let loudest: Vec<f64> = indices.iter().map(|index| rmses[*index]).collect();
    (indices, rms(&loudest))
}

pub fn rms_coefficient(match_rms: f64, reference_match_rms: f64) -> f64 {
    reference_match_rms / MIN_VALUE.max(match_rms)
}

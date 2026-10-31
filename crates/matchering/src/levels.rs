// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

use crate::config::{MAX_PIECE_SIZE, MIN_VALUE, THRESHOLD};

/// Stereo input of any float precision, read as mid and side on demand instead of stored.
pub struct Stereo<'a, S: Copy + Into<f64>> {
    pub left: &'a [S],
    pub right: &'a [S],
    pub scale: f64
}

impl<'a, S: Copy + Into<f64>> Stereo<'a, S> {
    pub fn new(left: &'a [S], right: &'a [S]) -> Self {Self {left, right, scale: 1.0}}

    pub fn len(&self) -> usize {self.left.len()}

    pub fn mid(&self, index: usize) -> f64 {
        (self.left[index].into() * self.scale + self.right[index].into() * self.scale) * 0.5
    }

    pub fn side(&self, index: usize) -> f64 {self.mid(index) - self.right[index].into() * self.scale}

    /// `normalize(..., normalize_clipped=False)`: the divisor raising the audio to the threshold, 1 if already there.
    pub fn normalize_coefficient(&self) -> f64 {
        let peak = self.left.iter().chain(self.right)
            .fold(0.0f64, |peak, value| peak.max((*value).into().abs()));
        if peak < THRESHOLD {MIN_VALUE.max(peak / THRESHOLD)} else {1.0}
    }
}

pub fn rms(values: &[f64]) -> f64 {
    (values.iter().map(|value| value * value).sum::<f64>() / values.len() as f64).sqrt()
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

    pub fn rmses(&self, sample: impl Fn(usize) -> f64) -> Vec<f64> {
        (0..self.divisions).map(|piece| {
            let start = piece * self.size;
            let sum: f64 = (start..start + self.size).map(|index| sample(index) * sample(index)).sum();
            (sum / self.size as f64).sqrt()
        }).collect()
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

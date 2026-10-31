// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

pub const SAMPLE_RATE: usize = 44100;
pub const MAX_LENGTH: usize = 15 * 60 * SAMPLE_RATE;
pub const MAX_PIECE_SIZE: usize = 15 * SAMPLE_RATE;
pub const THRESHOLD: f64 = (32768.0 - 61.0) / 32768.0;
pub const MIN_VALUE: f64 = 1e-6;
pub const FFT_SIZE: usize = 4096;
pub const BINS: usize = FFT_SIZE / 2 + 1;
pub const LIN_LOG_OVERSAMPLING: usize = 4;
pub const RMS_CORRECTION_STEPS: usize = 4;
// not in Matchering: the matching curves are clamped, a narrow mix otherwise gets its side boosted by 40 dB and more
pub const CURVE_LIMIT_DB: f64 = 12.0;
pub const LOWESS_FRAC: f64 = 0.0375;
pub const LOWESS_ITERATIONS: usize = 0;
pub const LOWESS_DELTA: f64 = 0.001;

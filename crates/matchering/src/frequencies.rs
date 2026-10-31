// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

use std::f64::consts::PI;
use crate::config::{BINS, FFT_SIZE, LIN_LOG_OVERSAMPLING, LOWESS_DELTA, LOWESS_FRAC, LOWESS_ITERATIONS, MIN_VALUE,
                    SAMPLE_RATE};
use crate::fft::Fft;
use crate::lowess::lowess;
use crate::spline::CubicSpline;

/// Mean magnitude spectrum over non-overlapping boxcar frames of all pieces (scipy `stft`, scaling "spectrum").
pub fn average_spectrum(pieces: &[&[f64]]) -> Vec<f64> {
    let fft = Fft::new(FFT_SIZE);
    let mut sum = vec![0.0; BINS];
    let mut frames = 0;
    let (mut re, mut im) = (vec![0.0; FFT_SIZE], vec![0.0; FFT_SIZE]);
    for piece in pieces {
        for frame in piece.chunks_exact(FFT_SIZE) {
            re.copy_from_slice(frame);
            im.fill(0.0);
            fft.forward(&mut re, &mut im);
            for bin in 0..BINS {sum[bin] += re[bin].hypot(im[bin]) / FFT_SIZE as f64;}
            frames += 1;
        }
    }
    sum.iter().map(|value| value / frames as f64).collect()
}

/// The smoothed reference-to-target magnitude ratio per bin, the matching EQ curve.
pub fn matching_curve(target_spectrum: &[f64], reference_spectrum: &[f64]) -> Vec<f64> {
    let ratio: Vec<f64> = target_spectrum.iter().zip(reference_spectrum)
        .map(|(target, reference)| reference / MIN_VALUE.max(*target)).collect();
    smooth_exponentially(&ratio)
}

fn linspace(start: f64, stop: f64, count: usize) -> Vec<f64> {
    let step = (stop - start) / (count - 1) as f64;
    let mut values: Vec<f64> = (0..count).map(|index| start + step * index as f64).collect();
    values[count - 1] = stop;
    values
}

fn smooth_exponentially(ratio: &[f64]) -> Vec<f64> {
    let nyquist = SAMPLE_RATE as f64 * 0.5;
    let grid_linear: Vec<f64> = linspace(0.0, 1.0, BINS).iter().map(|value| nyquist * value).collect();
    let grid_logarithmic: Vec<f64> = linspace((4.0 / FFT_SIZE as f64).log10(), 0.0,
                                              (FFT_SIZE / 2) * LIN_LOG_OVERSAMPLING + 1)
        .iter().map(|exponent| nyquist * 10f64.powf(*exponent)).collect();
    let spline = CubicSpline::new(&grid_linear, ratio);
    let ratio_log: Vec<f64> = grid_logarithmic.iter().map(|value| spline.evaluate(*value)).collect();
    let smoothed = lowess(&linspace(0.0, 1.0, ratio_log.len()), &ratio_log, LOWESS_FRAC, LOWESS_ITERATIONS,
                          LOWESS_DELTA);
    let spline = CubicSpline::new(&grid_logarithmic, &smoothed);
    let mut curve: Vec<f64> = grid_linear.iter().map(|value| spline.evaluate(*value)).collect();
    curve[0] = 0.0;
    curve[1] = ratio[1];
    curve
}

/// The linear-phase FIR of a curve: inverse real FFT, centered, Hann windowed.
pub fn fir(curve: &[f64]) -> Vec<f64> {
    assert_eq!(curve.len(), BINS);
    let fft = Fft::new(FFT_SIZE);
    let mut re = vec![0.0; FFT_SIZE];
    let mut im = vec![0.0; FFT_SIZE];
    re[..BINS].copy_from_slice(curve);
    for bin in 1..FFT_SIZE / 2 {re[FFT_SIZE - bin] = curve[bin];}
    fft.inverse(&mut re, &mut im);
    (0..FFT_SIZE).map(|index| {
        let window = 0.5 - 0.5 * (2.0 * PI * index as f64 / (FFT_SIZE - 1) as f64).cos();
        re[(index + FFT_SIZE / 2) % FFT_SIZE] / FFT_SIZE as f64 * window
    }).collect()
}

/// scipy `fftconvolve(signal, kernel, "same")` by overlap-add.
pub fn convolve_same(signal: &[f64], kernel: &[f64]) -> Vec<f64> {
    let block = kernel.len().next_power_of_two();
    let fft = Fft::new(block * 2);
    let size = fft.size();
    let (mut kernel_re, mut kernel_im) = (vec![0.0; size], vec![0.0; size]);
    kernel_re[..kernel.len()].copy_from_slice(kernel);
    fft.forward(&mut kernel_re, &mut kernel_im);
    let offset = (kernel.len() - 1) / 2;
    let mut full = vec![0.0; signal.len() + kernel.len() - 1];
    let (mut re, mut im) = (vec![0.0; size], vec![0.0; size]);
    for (index, chunk) in signal.chunks(block).enumerate() {
        re.fill(0.0);
        im.fill(0.0);
        re[..chunk.len()].copy_from_slice(chunk);
        fft.forward(&mut re, &mut im);
        for bin in 0..size {
            let product_re = re[bin] * kernel_re[bin] - im[bin] * kernel_im[bin];
            im[bin] = re[bin] * kernel_im[bin] + im[bin] * kernel_re[bin];
            re[bin] = product_re;
        }
        fft.inverse(&mut re, &mut im);
        let start = index * block;
        let end = (start + chunk.len() + kernel.len() - 1).min(full.len());
        for position in start..end {full[position] += re[position - start] / size as f64;}
    }
    full[offset..offset + signal.len()].to_vec()
}

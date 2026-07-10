//! Anti-gaming guards: band-energy balance vs the source (muffling fails here), overall level vs
//! the source (ducking fails here), trailing silence (running dry fails here).

use stretch::fft::Fft;

const FFT_SIZE: usize = 4096;
const NUM_BANDS: usize = 8;
const BAND_LOW_HZ: f64 = 100.0;
const BAND_HIGH_HZ: f64 = 16000.0;

/// Fraction of total band energy per log-spaced band, averaged over Hann frames.
pub fn band_fractions(mono: &[f32], sample_rate: f64) -> [f64; NUM_BANDS] {
    let fft = Fft::new(FFT_SIZE);
    let mut spectrum = vec![0.0f64; FFT_SIZE / 2];
    let mut re = vec![0.0f32; FFT_SIZE];
    let mut im = vec![0.0f32; FFT_SIZE];
    let hop = FFT_SIZE / 2;
    let mut offset = 0;
    let mut frames = 0usize;
    while offset + FFT_SIZE <= mono.len() {
        for index in 0..FFT_SIZE {
            let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / FFT_SIZE as f64).cos();
            re[index] = mono[offset + index] * window as f32;
            im[index] = 0.0;
        }
        fft.forward(&mut re, &mut im);
        for bin in 0..FFT_SIZE / 2 {
            spectrum[bin] += (re[bin] as f64).powi(2) + (im[bin] as f64).powi(2);
        }
        frames += 1;
        offset += hop;
    }
    let mut bands = [0.0f64; NUM_BANDS];
    if frames == 0 {
        return bands;
    }
    let ratio_per_band = (BAND_HIGH_HZ / BAND_LOW_HZ).powf(1.0 / NUM_BANDS as f64);
    for bin in 1..FFT_SIZE / 2 {
        let frequency = bin as f64 * sample_rate / FFT_SIZE as f64;
        if frequency < BAND_LOW_HZ || frequency >= BAND_HIGH_HZ {
            continue;
        }
        let band = ((frequency / BAND_LOW_HZ).ln() / ratio_per_band.ln()) as usize;
        bands[band.min(NUM_BANDS - 1)] += spectrum[bin];
    }
    let total: f64 = bands.iter().sum();
    if total > 0.0 {
        for band in bands.iter_mut() {
            *band /= total;
        }
    }
    bands
}

/// Mean absolute per-band dB difference of energy fractions. 0 = same tonal balance.
pub fn spectral_delta_db(source_bands: &[f64; NUM_BANDS], output_bands: &[f64; NUM_BANDS]) -> f64 {
    let mut sum = 0.0;
    let mut counted = 0usize;
    for band in 0..NUM_BANDS {
        if source_bands[band] < 1e-9 && output_bands[band] < 1e-9 {
            continue;
        }
        sum += (10.0 * ((output_bands[band] + 1e-9) / (source_bands[band] + 1e-9)).log10()).abs();
        counted += 1;
    }
    if counted == 0 { 0.0 } else { sum / counted as f64 }
}

pub fn level_delta_db(source_rms: f64, output_rms: f64) -> f64 {
    (20.0 * ((output_rms + 1e-12) / (source_rms + 1e-12)).log10()).abs()
}

/// Fraction of the output duration that is trailing near-silence (< -60 dB of the output peak).
pub fn trailing_silence_ratio(fast_env: &[f32]) -> f64 {
    let peak = fast_env.iter().fold(0.0f32, |max, value| max.max(*value));
    if peak <= 0.0 || fast_env.is_empty() {
        return 1.0;
    }
    let threshold = peak * 0.001;
    let mut silent = 0usize;
    for value in fast_env.iter().rev() {
        if *value >= threshold {
            break;
        }
        silent += 1;
    }
    silent as f64 / fast_env.len() as f64
}

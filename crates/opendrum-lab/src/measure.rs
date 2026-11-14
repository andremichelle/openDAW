//! The report card measures of one drum hit. Every measure stands alone with its own threshold later, there is
//! no summed score. Times are in ms from the first sample, levels in dB relative to the hit's peak.

use crate::fft::power_spectrum;
use std::f64::consts::PI;

pub const PITCH_TIMES_MS: [f64; 5] = [10.0, 20.0, 40.0, 80.0, 160.0];
pub const CENTROID_TIMES_MS: [f64; 6] = [1.0, 5.0, 10.0, 20.0, 50.0, 100.0];
pub const OCTAVE_CENTRES: [f64; 10] = [31.25, 62.5, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
pub const PARTIAL_COUNT: usize = 3;

#[derive(Clone, Debug, Default)]
pub struct Measures {
    pub onset_ms: f64,
    pub peak_ms: f64,
    pub decay3_ms: f64,
    pub decay20_ms: f64,
    pub decay40_ms: f64,
    pub length_ms: f64,
    pub first_period: (f64, f64),
    pub pitch_hz: Vec<f64>,
    pub partials: Vec<(f64, f64)>,
    pub tones_early: Vec<(f64, f64)>,
    pub tones_late: Vec<(f64, f64)>,
    pub centroid_hz: Vec<f64>,
    pub attack_centroid_hz: f64,
    pub bands_early_db: Vec<f64>,
    pub bands_late_db: Vec<f64>,
    pub noise_early_db: f64,
    pub noise_late_db: f64,
    pub noise_low_early_db: f64,
    pub noise_low_late_db: f64,
    pub bursts_ms: Vec<f64>,
    pub grid: Vec<Vec<f64>>
}

fn ms_to_index(ms: f64, sample_rate: f64) -> usize {(ms * 0.001 * sample_rate).round() as usize}

fn index_to_ms(index: usize, sample_rate: f64) -> f64 {index as f64 * 1000.0 / sample_rate}

fn to_db(power: f64) -> f64 {10.0 * power.max(1e-20).log10()}

/// RMS envelope with `window` samples per frame, hop of one frame.
pub fn rms_frames(samples: &[f64], window: usize) -> Vec<f64> {
    samples.chunks(window).map(|chunk| (chunk.iter().map(|value| value * value).sum::<f64>() / chunk.len() as f64).sqrt()).collect()
}

/// RMS over a sliding `window_ms` window, one value per ms. A window of one low period (20 ms at 50 Hz) keeps the
/// waveform ripple of a kick out of the level, so peaks and decay times are not picked from a ripple.
pub fn sliding_rms(samples: &[f64], sample_rate: f64, window_ms: f64) -> Vec<f64> {
    let mut sums = Vec::with_capacity(samples.len() + 1);
    sums.push(0.0);
    samples.iter().fold(0.0, |sum, value| {
        let next = sum + value * value;
        sums.push(next);
        next
    });
    let half = (ms_to_index(window_ms, sample_rate) / 2).max(1);
    let hop = ms_to_index(1.0, sample_rate).max(1);
    (0..samples.len()).step_by(hop).map(|centre| {
        let (from, to) = (centre.saturating_sub(half), (centre + half).min(samples.len()));
        ((sums[to] - sums[from]) / (2 * half) as f64).max(0.0).sqrt()
    }).collect()
}

/// Time from the onset until the envelope stays below `drop_db` under its peak. Measured from the onset, not from
/// the peak, because the peak of a held (flat) level is an arbitrary point on the plateau.
fn decay_ms(envelope: &[f64], peak: usize, drop_db: f64) -> f64 {
    let threshold = envelope[peak] * 10f64.powf(-drop_db / 20.0);
    envelope.iter().rposition(|value| *value >= threshold).unwrap_or(peak) as f64 + 1.0
}

/// Two pole low or high pass (RBJ, Q 0.707).
fn biquad(samples: &[f64], cutoff: f64, sample_rate: f64, low: bool) -> Vec<f64> {
    let omega = 2.0 * PI * (cutoff / sample_rate).min(0.45);
    let alpha = omega.sin() / (2.0 * 0.707);
    let cos = omega.cos();
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = if low {
        ((1.0 - cos) / 2.0 / a0, (1.0 - cos) / a0, (1.0 - cos) / 2.0 / a0)
    } else {
        ((1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0)
    };
    let (a1, a2) = (-2.0 * cos / a0, (1.0 - alpha) / a0);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    samples.iter().map(|&x0| {
        let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        y0
    }).collect()
}

/// Instantaneous frequency from zero crossings in both directions: one full period between every second
/// crossing, placed at the crossing in between, so a value exists every half period.
fn crossing_track(samples: &[f64], sample_rate: f64) -> Vec<(f64, f64)> {
    let mut crossings = Vec::new();
    for index in 1..samples.len() {
        let (previous, current) = (samples[index - 1], samples[index]);
        if (previous < 0.0) != (current < 0.0) && previous != current {
            crossings.push(index as f64 - 1.0 + previous / (previous - current));
        }
    }
    crossings.windows(3).map(|triple| (triple[1] * 1000.0 / sample_rate, sample_rate / (triple[2] - triple[0]))).collect()
}

/// The earliest pitch a crossing pair can tell: the first half period, placed at its middle.
fn first_half_period(samples: &[f64], sample_rate: f64) -> (f64, f64) {
    let mut crossings = Vec::new();
    for index in 1..samples.len() {
        let (previous, current) = (samples[index - 1], samples[index]);
        if (previous < 0.0) != (current < 0.0) && previous != current {
            crossings.push(index as f64 - 1.0 + previous / (previous - current));
            if crossings.len() == 2 {break;}
        }
    }
    if crossings.len() < 2 {return (f64::NAN, f64::NAN);}
    (0.5 * (crossings[0] + crossings[1]) * 1000.0 / sample_rate, 0.5 * sample_rate / (crossings[1] - crossings[0]))
}

fn interpolate_track(track: &[(f64, f64)], ms: f64) -> f64 {
    if track.is_empty() || ms < track[0].0 || ms > track[track.len() - 1].0 {return f64::NAN;}
    let next = track.iter().position(|(time, _)| *time >= ms).unwrap_or(track.len() - 1);
    if next == 0 {return track[0].1;}
    let ((t0, f0), (t1, f1)) = (track[next - 1], track[next]);
    f0 + (f1 - f0) * (ms - t0) / (t1 - t0).max(1e-9)
}

/// The strongest spectral peaks (Hz, dB relative to the strongest) with parabolic interpolation.
/// The two strongest tones between 80 and 1200 Hz in a window, sorted low to high, levels in dB relative to the
/// stronger one. Two bodies sounding at once are followed separately, where zero crossings would read their mix.
/// The lower limit keeps mains hum (60 Hz, left in some reference recordings) out once a body has faded.
fn tones(hit: &[f64], sample_rate: f64, from_ms: f64, to_ms: f64) -> Vec<(f64, f64)> {
    let size = 16384;
    let length = ms_to_index(to_ms - from_ms, sample_rate).min(size);
    let mut power = power_spectrum(hit, ms_to_index(from_ms, sample_rate), length, size);
    let bin_hz = sample_rate / size as f64;
    power.iter_mut().enumerate().filter(|(bin, _)| *bin as f64 * bin_hz > 1200.0 || (*bin as f64 * bin_hz) < 80.0)
        .for_each(|(_, value)| *value = 0.0);
    let mut found = spectral_peaks(&power, sample_rate, size, 2);
    found.sort_by(|a, b| a.0.total_cmp(&b.0));
    found
}

fn spectral_peaks(power: &[f64], sample_rate: f64, size: usize, count: usize) -> Vec<(f64, f64)> {
    let bin_hz = sample_rate / size as f64;
    let first = (20.0 / bin_hz).ceil() as usize;
    let mut peaks: Vec<(f64, f64)> = (first.max(1)..power.len() - 1)
        .filter(|&bin| power[bin] > power[bin - 1] && power[bin] >= power[bin + 1])
        .map(|bin| {
            let (left, centre, right) = (to_db(power[bin - 1]), to_db(power[bin]), to_db(power[bin + 1]));
            let denominator = left - 2.0 * centre + right;
            let shift = if denominator.abs() > 1e-12 {0.5 * (left - right) / denominator} else {0.0};
            ((bin as f64 + shift) * bin_hz, centre - 0.25 * (left - right) * shift)
        })
        .collect();
    peaks.sort_by(|first, second| second.1.total_cmp(&first.1));
    let mut chosen: Vec<(f64, f64)> = Vec::new();
    for peak in peaks {
        if chosen.iter().all(|(hz, _)| (peak.0 / hz).log2().abs() > 0.1) {chosen.push(peak);}
        if chosen.len() == count {break;}
    }
    let loudest = chosen.first().map(|(_, db)| *db).unwrap_or(0.0);
    chosen.into_iter().map(|(hz, db)| (hz, db - loudest)).collect()
}

fn centroid(power: &[f64], sample_rate: f64, size: usize) -> f64 {
    let bin_hz = sample_rate / size as f64;
    let total: f64 = power.iter().sum();
    if total <= 0.0 {return f64::NAN;}
    power.iter().enumerate().map(|(bin, value)| bin as f64 * bin_hz * value).sum::<f64>() / total
}

fn octave_bands_db(power: &[f64], sample_rate: f64, size: usize) -> Vec<f64> {
    let bin_hz = sample_rate / size as f64;
    let total: f64 = power.iter().sum::<f64>().max(1e-20);
    OCTAVE_CENTRES.iter().map(|centre| {
        let (low, high) = (centre / 2f64.sqrt(), centre * 2f64.sqrt());
        let sum: f64 = power.iter().enumerate()
            .filter(|(bin, _)| *bin as f64 * bin_hz >= low && (*bin as f64 * bin_hz) < high)
            .map(|(_, value)| value).sum();
        to_db(sum / total)
    }).collect()
}

/// Noise share in dB: the median bin power between `low` and `high` Hz, spread over all those bins, relative to
/// the whole window. Tonal peaks cover few bins, so the median sits on the noise floor: white noise over the full
/// band reads about -1.6 dB, a pure tone far below -60 dB.
fn noise_db(power: &[f64], sample_rate: f64, size: usize, low: f64, high: f64) -> f64 {
    let bin_hz = sample_rate / size as f64;
    let mut band: Vec<f64> = power.iter().enumerate()
        .filter(|(bin, _)| *bin as f64 * bin_hz >= low && (*bin as f64 * bin_hz) <= high)
        .map(|(_, value)| *value).collect();
    let total: f64 = power.iter().sum();
    if band.is_empty() || total <= 0.0 {return f64::NAN;}
    band.sort_by(f64::total_cmp);
    to_db(band[band.len() / 2] * band.len() as f64 / total)
}

/// Bursts in the first 80 ms: maxima of the 1 ms envelope above 1 kHz (tonal bodies drop out) that rise at least
/// 6 dB over the dip before them. A hit without content above 1 kHz (30 dB under its peak) has no bursts.
fn bursts(samples: &[f64], sample_rate: f64, onset: usize) -> Vec<f64> {
    let window = ms_to_index(1.0, sample_rate).max(1);
    let end = (onset + ms_to_index(80.0, sample_rate)).min(samples.len());
    let envelope = rms_frames(&biquad(&samples[onset..end], 1000.0, sample_rate, false), window);
    let peak = envelope.iter().cloned().fold(0.0, f64::max);
    let full = rms_frames(&samples[onset..end], window).into_iter().fold(0.0, f64::max);
    let mut result = Vec::new();
    if peak < full * 0.03 {return result;}
    let mut dip = f64::MAX;
    for index in 0..envelope.len().saturating_sub(1) {
        let value = envelope[index];
        let previous = if index == 0 {0.0} else {envelope[index - 1]};
        if value >= previous && value > envelope[index + 1] && value > peak * 0.1
            && (result.is_empty() || value >= dip * 2.0) {
            result.push(index as f64 * window as f64 * 1000.0 / sample_rate);
            dip = value;
        }
        dip = dip.min(value);
    }
    result
}

pub fn measure(samples: &[f64], sample_rate: f64) -> Measures {
    let peak_sample = samples.iter().map(|value| value.abs()).fold(0.0, f64::max);
    if peak_sample <= 0.0 {return Measures::default();}
    let onset = samples.iter().position(|value| value.abs() >= peak_sample * 0.05).unwrap_or(0);
    let hit = &samples[onset..];
    let envelope = sliding_rms(hit, sample_rate, 20.0);
    let peak = envelope.iter().enumerate().fold(0, |best, (index, value)| if *value > envelope[best] {index} else {best});
    let size = 8192;
    let body = power_spectrum(hit, 0, ms_to_index(100.0, sample_rate).min(size).min(hit.len()), size);
    let partials = spectral_peaks(&body, sample_rate, size, PARTIAL_COUNT);
    let guide = partials.first().map(|(hz, _)| *hz).unwrap_or(100.0);
    let noisy = noise_db(&power_spectrum(hit, 0, ms_to_index(20.0, sample_rate), 2048), sample_rate, 2048, 100.0, 16000.0) > -30.0;
    let body_signal = if noisy {
        biquad(&biquad(hit, guide * 1.5, sample_rate, true), guide * 1.5, sample_rate, true)
    } else {
        biquad(hit, (guide * 4.0).max(250.0), sample_rate, true)
    };
    let track = crossing_track(&body_signal, sample_rate);
    let short = 512;
    let window_at = |ms: f64, length: usize, fft: usize| power_spectrum(hit, ms_to_index(ms, sample_rate), length, fft);
    let early = window_at(0.0, ms_to_index(20.0, sample_rate), 2048);
    let late = window_at(20.0, ms_to_index(100.0, sample_rate).min(size), size);
    Measures {
        onset_ms: index_to_ms(onset, sample_rate),
        peak_ms: peak as f64,
        decay3_ms: decay_ms(&envelope, peak, 3.0),
        decay20_ms: decay_ms(&envelope, peak, 20.0),
        decay40_ms: decay_ms(&envelope, peak, 40.0),
        length_ms: decay_ms(&envelope, peak, 60.0),
        first_period: first_half_period(&body_signal, sample_rate),
        pitch_hz: PITCH_TIMES_MS.iter().map(|ms| interpolate_track(&track, *ms)).collect(),
        partials,
        tones_early: tones(hit, sample_rate, 0.0, 40.0),
        tones_late: tones(hit, sample_rate, 40.0, 160.0),
        centroid_hz: CENTROID_TIMES_MS.iter()
            .map(|ms| centroid(&window_at(*ms, ms_to_index(4.0, sample_rate), short), sample_rate, short)).collect(),
        attack_centroid_hz: centroid(&window_at(0.0, ms_to_index(5.0, sample_rate), short), sample_rate, short),
        bands_early_db: octave_bands_db(&early, sample_rate, 2048),
        bands_late_db: octave_bands_db(&late, sample_rate, size),
        noise_early_db: noise_db(&early, sample_rate, 2048, 100.0, 16000.0),
        noise_late_db: noise_db(&late, sample_rate, size, 100.0, 16000.0),
        noise_low_early_db: noise_db(&early, sample_rate, 2048, 100.0, 2000.0),
        noise_low_late_db: noise_db(&late, sample_rate, size, 100.0, 2000.0),
        grid: band_grid(samples, sample_rate),
        bursts_ms: if noise_db(&early, sample_rate, 2048, 100.0, 16000.0) > -40.0 {bursts(samples, sample_rate, onset)} else {Vec::new()}
    }
}

pub const GRID_EDGES: [f64; 9] = [80.0, 160.0, 320.0, 640.0, 1280.0, 2560.0, 5120.0, 10240.0, 20000.0];
pub const GRID_FRAMES_MS: [f64; 10] = [0.0, 10.0, 20.0, 30.0, 50.0, 80.0, 120.0, 160.0, 200.0, 250.0];

/// Level per band (GRID_EDGES) and 20 ms window starting at each of GRID_FRAMES_MS after the onset, in dB under the
/// hit's loudest cell. Close to what a spectrogram shows, for comparing two hits by ear relevant regions.
pub fn band_grid(samples: &[f64], sample_rate: f64) -> Vec<Vec<f64>> {
    let peak = samples.iter().fold(0.0f64, |peak, value| peak.max(value.abs()));
    let onset = samples.iter().position(|value| value.abs() > 0.05 * peak).unwrap_or(0);
    let length = ms_to_index(20.0, sample_rate);
    let bin_hz = sample_rate / 4096.0;
    let grid: Vec<Vec<f64>> = GRID_FRAMES_MS.iter().map(|ms| {
        let power = power_spectrum(samples, onset + ms_to_index(*ms, sample_rate), length, 4096);
        GRID_EDGES.windows(2).map(|edge| {
            let sum: f64 = power.iter().enumerate()
                .filter(|(bin, _)| *bin as f64 * bin_hz >= edge[0] && (*bin as f64 * bin_hz) < edge[1])
                .map(|(_, value)| value).sum();
            to_db(sum)
        }).collect()
    }).collect();
    let top = grid.iter().flatten().cloned().fold(f64::MIN, f64::max);
    grid.into_iter().map(|row| row.into_iter().map(|db| db - top).collect()).collect()
}

/// The ten strongest tones between 70 Hz and 2 kHz in a window after the onset (Hz, dB under the strongest), sorted
/// by frequency, to compare overtones (octaves against odd harmonics) by eye.
pub fn strongest_tones(samples: &[f64], sample_rate: f64, from_ms: f64, to_ms: f64) -> Vec<(f64, f64)> {
    let peak = samples.iter().fold(0.0f64, |peak, value| peak.max(value.abs()));
    let onset = samples.iter().position(|value| value.abs() > 0.05 * peak).unwrap_or(0);
    let size = 16384;
    let power = power_spectrum(samples, onset + ms_to_index(from_ms, sample_rate), ms_to_index(to_ms - from_ms, sample_rate).min(size), size);
    let bin_hz = sample_rate / size as f64;
    let mut found: Vec<(f64, f64)> = (2..power.len() - 1)
        .filter(|bin| power[*bin] > power[bin - 1] && power[*bin] >= power[bin + 1])
        .filter(|bin| *bin as f64 * bin_hz > 70.0 && (*bin as f64 * bin_hz) < 2000.0)
        .map(|bin| (bin as f64 * bin_hz, to_db(power[bin]))).collect();
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    let top = found.first().map(|(_, db)| *db).unwrap_or(0.0);
    let mut chosen: Vec<(f64, f64)> = Vec::new();
    for (hz, db) in found {
        if chosen.iter().all(|(other, _)| (hz / other).log2().abs() > 0.05) {chosen.push((hz, db - top));}
        if chosen.len() == 10 {break;}
    }
    chosen.sort_by(|a, b| a.0.total_cmp(&b.0));
    chosen
}

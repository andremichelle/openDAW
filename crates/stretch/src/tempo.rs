//! Tempo estimation over the spectral-flux onset function: autocorrelation with harmonic summation
//! (so the beat wins over its own subdivisions), a log-normal tempo prior (so the octave choice is
//! not left to whichever peak happens to be taller), and a final snap that makes a trimmed loop an
//! exact number of bars.
//!
//! `None` is a first-class answer and the reason this is not a "best guess" API: material with no
//! measurable pulse (a pad, a one-shot, a field recording) must come back unknown so the host stores
//! 0 and leaves it in seconds, rather than warping it to a fabricated tempo.
//!
//! An octave error is the benign failure mode here: reporting 140 for a 70 bpm loop keeps every beat
//! on a grid line and only changes how many bars the material claims to be. A 3/2 error does not,
//! which is why the prior is a smooth preference rather than a hard range clamp.

use alloc::vec;
use alloc::vec::Vec;
use crate::onset::spectral_flux;
use crate::stft::Stft;

#[derive(Clone, Copy, Debug)]
pub struct TempoConfig {
    pub fft_size: usize,
    pub hop: usize,
    /// Log compression of the flux, as in `OnsetConfig`.
    pub log_gamma: f32,
    pub min_bpm: f64,
    pub max_bpm: f64,
    /// Shorter than this the autocorrelation has too few periods to trust. One bar at 125 bpm is 1.92s and
    /// must pass; one bar at 174 is 1.38s and must not, because there the estimate starts landing off-grid.
    pub min_duration_seconds: f64,
    /// Tempo is a global property, so a long file pays only for the part that establishes it.
    pub max_analysis_seconds: f64,
    /// Peak of the (log-compressed, pre-standardisation) onset function below which the material is
    /// taken to have no onsets at all — a tone, a pad, hiss — whatever the correlation then says.
    pub min_onset_peak: f32,
    /// Correlation at the winning lag below which the material is reported as having no tempo.
    pub min_correlation: f32,
    /// Centre and width (in octaves) of the log-normal preference that resolves the octave.
    pub prior_center_bpm: f64,
    pub prior_octaves: f64,
    /// Width (in onset-function frames) of the Gaussian applied before correlating.
    pub smoothing_sigma_frames: f32,
    /// Highest multiple of the candidate period the comb reaches for.
    pub max_comb_multiple: usize,
    /// How close to a bar line the material must end for the snap to fire, in bars. This is the criterion
    /// that separates a loop cut to the grid from a file that merely happens to divide evenly: a small
    /// ABSOLUTE error in bars, so a long file with accumulated drift is refused however small its relative
    /// error looks. The ratio is a second, looser guard so the snap can never move the estimate wildly.
    pub max_snap_bars: f64,
    pub max_snap_ratio: f64
}

impl Default for TempoConfig {
    fn default() -> Self {
        Self {
            fft_size: 1024,
            hop: 256,
            log_gamma: 100.0,
            min_bpm: 70.0,
            max_bpm: 200.0,
            min_duration_seconds: 1.5,
            max_analysis_seconds: 60.0,
            min_onset_peak: 40.0,
            min_correlation: 0.20,
            prior_center_bpm: 120.0,
            prior_octaves: 0.9,
            smoothing_sigma_frames: 1.5,
            max_comb_multiple: 8,
            max_snap_bars: 0.05,
            max_snap_ratio: 0.05
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TempoEstimate {
    pub bpm: f64,
    /// Correlation of the onset function with itself at the beat lag. At or above
    /// `TempoConfig::min_correlation` by construction.
    pub correlation: f32,
    /// True when the estimate was adjusted so the material spans a whole number of bars.
    pub snapped_to_grid: bool
}

/// Detrended, half-wave-rectified, then standardised onset function. Subtracting the moving mean is
/// what makes the autocorrelation measure periodicity rather than the loudness envelope of the whole
/// file; standardising afterwards is what turns the autocorrelation into a correlation coefficient,
/// so a single absolute threshold can decide "this has a pulse" for quiet and loud material alike.
fn smooth(values: &[f32], sigma: f32) -> Vec<f32> {
    if sigma <= 0.0 {
        return values.to_vec();
    }
    let radius = (3.0 * sigma) as usize;
    let kernel: Vec<f32> = (0..=2 * radius).map(|index| {
        let distance = (index as f32 - radius as f32) / sigma;
        libm::expf(-0.5 * distance * distance)
    }).collect();
    let total: f32 = kernel.iter().sum();
    values.iter().enumerate().map(|(center, _)| {
        let mut sum = 0.0f32;
        for (index, weight) in kernel.iter().enumerate() {
            let position = center as isize + index as isize - radius as isize;
            if position >= 0 && (position as usize) < values.len() {
                sum += weight * values[position as usize];
            }
        }
        sum / total
    }).collect()
}

/// Returns the standardised function AND the peak it had before standardising. The peak is the only
/// absolute measure left afterwards, and it is what tells onsets from ripple: standardising scales any
/// input to unit variance, so a steady tone's numerical flutter comes out looking exactly like a drum
/// loop and the correlation gate then decides on noise. The flux is log-compressed, which is what makes
/// an absolute threshold survive a 40 dB drop in level.
fn onset_function(flux: &[f32], mean_window: usize, smoothing_sigma: f32) -> (Vec<f32>, f32) {
    let mut detrended = vec![0.0f32; flux.len()];
    for index in 0..flux.len() {
        let from = index.saturating_sub(mean_window);
        let to = (index + mean_window + 1).min(flux.len());
        let mut sum = 0.0f32;
        for value in &flux[from..to] {
            sum += *value;
        }
        let rise = flux[index] - sum / (to - from) as f32;
        detrended[index] = if rise > 0.0 { rise } else { 0.0 };
    }
    // Widen the peaks before anything correlates them. An attack is one or two frames wide, so a
    // candidate period landing half a frame off the grid decorrelates almost completely: the winner
    // would be whichever period happens to be near-integer in frames, not the strongest pulse. With
    // peaks a few frames wide the correlation varies smoothly with lag, which is also what makes the
    // parabolic refinement meaningful rather than decorative.
    let mut detrended = smooth(&detrended, smoothing_sigma);
    let peak = detrended.iter().fold(0.0f32, |max, value| if *value > max { *value } else { max });
    let count = detrended.len().max(1) as f64;
    let mean = detrended.iter().fold(0.0f64, |sum, value| sum + *value as f64) / count;
    let variance = detrended.iter().fold(0.0f64, |sum, value| {
        let centered = *value as f64 - mean;
        sum + centered * centered
    }) / count;
    let deviation = libm::sqrt(variance);
    if deviation > 0.0 {
        for value in detrended.iter_mut() {
            *value = ((*value as f64 - mean) / deviation) as f32;
        }
    }
    (detrended, peak)
}

/// Autocorrelation of the standardised function, normalised by the overlap count so a long lag is not
/// penalised for comparing fewer samples. Values read as correlation coefficients: 1.0 at lag 0.
fn autocorrelation(odf: &[f32], max_lag: usize) -> Vec<f32> {
    let mut acf = vec![0.0f32; max_lag + 1];
    for lag in 0..=max_lag {
        let overlap = odf.len().saturating_sub(lag);
        if overlap == 0 {
            continue;
        }
        let mut sum = 0.0f64;
        for index in lag..odf.len() {
            sum += (odf[index] * odf[index - lag]) as f64;
        }
        acf[lag] = (sum / overlap as f64) as f32;
    }
    acf
}

fn tempo_prior(bpm: f64, center_bpm: f64, octaves: f64) -> f32 {
    let distance = libm::log2(bpm / center_bpm) / octaves;
    libm::exp(-0.5 * distance * distance) as f32
}

/// Sub-frame refinement of the score peak. The lag grid is coarse (a frame is several bpm wide at
/// fast tempi), so the vertex of the parabola through the peak and its neighbours is the estimate.
fn parabolic_peak(score: &[f32], index: usize) -> f64 {
    if index == 0 || index + 1 >= score.len() {
        return index as f64;
    }
    let (left, center, right) = (score[index - 1] as f64, score[index] as f64, score[index + 1] as f64);
    let denominator = left - 2.0 * center + right;
    if denominator >= 0.0 {
        return index as f64;
    }
    index as f64 + 0.5 * (left - right) / denominator
}

/// Make the material an exact number of four-beat bars, which is what turns a 127.94 measurement into
/// the 128 the loop was actually cut at. Bars only, and only as a refinement: if the nearest whole bar
/// count implies a tempo further than `max_ratio` from the measurement, the material was not cut to a
/// bar and the measurement stands.
fn snap_to_bars(bpm: f64, duration_seconds: f64, max_bars: f64, max_ratio: f64) -> Option<f64> {
    let bars = duration_seconds * bpm / 240.0;
    let rounded = libm::round(bars);
    if rounded < 1.0 || libm::fabs(bars - rounded) > max_bars {
        return None;
    }
    let snapped = rounded * 240.0 / duration_seconds;
    if libm::fabs(snapped / bpm - 1.0) <= max_ratio { Some(snapped) } else { None }
}

pub fn detect(mono: &[f32], sample_rate: f32, config: &TempoConfig) -> Option<TempoEstimate> {
    let duration_seconds = mono.len() as f64 / sample_rate as f64;
    if duration_seconds < config.min_duration_seconds || sample_rate <= 0.0 {
        return None;
    }
    let analysed_frames = (config.max_analysis_seconds * sample_rate as f64) as usize;
    let window = &mono[..analysed_frames.min(mono.len())];
    let stft = Stft::new(config.fft_size, config.hop);
    let frames = stft.magnitudes(window);
    if frames.len() < 32 {
        return None;
    }
    let flux = spectral_flux(&frames, config.log_gamma);
    let odf_rate = sample_rate as f64 / config.hop as f64;
    let (odf, onset_peak) = onset_function(&flux, (0.5 * odf_rate) as usize, config.smoothing_sigma_frames);
    if onset_peak < config.min_onset_peak {
        return None;
    }
    let lag_of_bpm = |bpm: f64| 60.0 / bpm * odf_rate;
    let lag_min = lag_of_bpm(config.max_bpm) as usize;
    let lag_max = lag_of_bpm(config.min_bpm) as usize;
    // Beyond three quarters of the function the overlap is too small for the correlation to be stable.
    let max_lag = (config.max_comb_multiple * lag_max).min(odf.len() * 3 / 4);
    if lag_min < 1 || lag_max <= lag_min || max_lag <= lag_min {
        return None;
    }
    let acf = autocorrelation(&odf, max_lag);
    let search_max = lag_max.min(max_lag);
    let mut score = vec![0.0f32; search_max + 1];
    // A comb over every multiple of the candidate, not just the first few. Three terms cannot tell a
    // beat from a dotted beat in a kick-on-1-and-3 pattern: both align at their own multiples early
    // on, and they only diverge further out, where the dotted candidate keeps landing between hits.
    // Weighted 1/k (later multiples are measured over less overlap) and normalised by the weight sum,
    // so a short lag does not win merely by fitting more terms into the function.
    for lag in lag_min..=search_max {
        let mut sum = 0.0f32;
        let mut weight_sum = 0.0f32;
        let mut multiple = 1usize;
        while lag * multiple <= max_lag && multiple <= config.max_comb_multiple {
            let weight = 1.0 / (multiple * multiple) as f32;
            sum += weight * acf[lag * multiple];
            weight_sum += weight;
            multiple += 1;
        }
        if multiple <= 3 {
            continue;
        }
        score[lag] = sum / weight_sum
            * tempo_prior(60.0 * odf_rate / lag as f64, config.prior_center_bpm, config.prior_octaves);
    }
    let mut best_lag = lag_min;
    for lag in lag_min..=search_max {
        if score[lag] > score[best_lag] {
            best_lag = lag;
        }
    }
    let correlation = acf[best_lag];
    if correlation < config.min_correlation {
        return None;
    }
    let refined_lag = parabolic_peak(&score, best_lag);
    let bpm = 60.0 * odf_rate / refined_lag;
    // The snap uses the FULL duration: the analysis window may have been truncated, the material was not.
    match snap_to_bars(bpm, duration_seconds, config.max_snap_bars, config.max_snap_ratio) {
        Some(snapped) => Some(TempoEstimate {bpm: snapped, correlation, snapped_to_grid: true}),
        None => Some(TempoEstimate {bpm, correlation, snapped_to_grid: false})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: f32 = 48000.0;

    struct Noise(u32);

    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
            (self.0 >> 8) as f32 / 8388608.0 - 1.0
        }
    }

    /// A drum loop: kick on 1 and 3, snare on 2 and 4, hats on every eighth. A uniform click on every
    /// eighth would be deliberately unfair — with no accent structure, the beat and its subdivisions
    /// are genuinely indistinguishable, and no estimator resolves that. This has the accents real
    /// material has.
    fn drum_loop(bpm: f64, bars: f64) -> Vec<f32> {
        drum_loop_at(SAMPLE_RATE, bpm, bars)
    }

    fn drum_loop_at(sample_rate: f32, bpm: f64, bars: f64) -> Vec<f32> {
        let beat_seconds = 60.0 / bpm;
        let total_seconds = beat_seconds * 4.0 * bars;
        let length = (total_seconds * sample_rate as f64) as usize;
        let mut out = vec![0.0f32; length];
        let mut noise = Noise(0x1234_5678);
        let hit = |out: &mut Vec<f32>, at_seconds: f64, gain: f32, decay_seconds: f32, tone_hz: f32,
                   noise_mix: f32, noise: &mut Noise| {
            let start = (at_seconds * sample_rate as f64) as usize;
            let decay = decay_seconds * sample_rate;
            for index in 0..(decay * 5.0) as usize {
                if start + index >= out.len() {
                    break;
                }
                let envelope = libm::expf(-(index as f32) / decay);
                let phase = 2.0 * core::f32::consts::PI * tone_hz * index as f32 / sample_rate;
                let sample = libm::sinf(phase) * (1.0 - noise_mix) + noise.next() * noise_mix;
                out[start + index] += sample * envelope * gain;
            }
        };
        let eighths = (total_seconds / (beat_seconds * 0.5)) as usize;
        for eighth in 0..eighths {
            let at = eighth as f64 * beat_seconds * 0.5;
            hit(&mut out, at, 0.15, 0.004, 8000.0, 0.9, &mut noise);
            if eighth % 8 == 0 || eighth % 8 == 4 {
                hit(&mut out, at, 1.0, 0.060, 55.0, 0.05, &mut noise);
            }
            if eighth % 8 == 2 || eighth % 8 == 6 {
                hit(&mut out, at, 0.8, 0.030, 200.0, 0.8, &mut noise);
            }
        }
        out
    }

    fn detect_bpm(mono: &[f32]) -> Option<f64> {
        detect(mono, SAMPLE_RATE, &TempoConfig::default()).map(|estimate| estimate.bpm)
    }

    /// The contract for a grid-cut loop: the report must be an EXACT power-of-two multiple of the
    /// truth. Exact, so the material spans whole bars and every beat lands on a grid line; a power of
    /// two, because which octave a pattern is heard in is genuinely ambiguous (a backbeat at 174 is
    /// also a half-time backbeat at 87) and either answer warps the audio identically.
    fn assert_on_the_grid(detected: f64, truth: f64) {
        let octaves = libm::log2(detected / truth);
        let rounded = libm::round(octaves);
        assert!(libm::fabs(octaves - rounded) < 1e-4,
                "expected {truth} or a power-of-two multiple of it, got {detected}");
    }

    #[test]
    fn detects_common_tempi_on_grid_cut_loops() {
        for bpm in [90.0, 120.0, 128.0] {
            let detected = detect_bpm(&drum_loop(bpm, 4.0))
                .unwrap_or_else(|| panic!("no estimate at {bpm} bpm"));
            assert!((detected - bpm).abs() < 0.001,
                    "expected {bpm}, got {detected} (a grid-cut loop must snap exactly)");
        }
    }

    #[test]
    fn a_half_time_pattern_may_be_read_an_octave_down_but_stays_exact() {
        // Kick on 1 and 3 with a backbeat at 174 is indistinguishable from the same pattern at 87.
        let estimate = detect(&drum_loop(174.0, 4.0), SAMPLE_RATE, &TempoConfig::default()).unwrap();
        assert!(estimate.snapped_to_grid);
        assert_on_the_grid(estimate.bpm, 174.0);
    }

    #[test]
    fn snaps_a_loop_whose_estimate_lands_just_off() {
        let estimate = detect(&drum_loop(127.0, 4.0), SAMPLE_RATE, &TempoConfig::default()).unwrap();
        assert!(estimate.snapped_to_grid);
        assert!((estimate.bpm - 127.0).abs() < 0.001, "got {}", estimate.bpm);
    }

    #[test]
    fn leaves_material_that_does_not_end_on_the_grid_unsnapped() {
        // 4.37 bars: the end lands nowhere near a bar or beat line, so the raw estimate must survive.
        let estimate = detect(&drum_loop(120.0, 4.37), SAMPLE_RATE, &TempoConfig::default()).unwrap();
        assert!(!estimate.snapped_to_grid);
        assert!((estimate.bpm - 120.0).abs() / 120.0 < 0.02, "got {}", estimate.bpm);
    }

    #[test]
    fn detects_a_loop_forty_db_down() {
        // The onset gate is absolute, so it has to survive level: a quiet loop is still a loop.
        let quiet: Vec<f32> = drum_loop(120.0, 4.0).iter().map(|sample| sample * 0.01).collect();
        assert_eq!(detect_bpm(&quiet), Some(120.0));
    }

    #[test]
    fn refuses_material_without_a_pulse() {
        let steady: Vec<f32> = (0..(SAMPLE_RATE as usize * 8))
            .map(|index| libm::sinf(2.0 * core::f32::consts::PI * 220.0 * index as f32 / SAMPLE_RATE) * 0.3)
            .collect();
        assert!(detect_bpm(&steady).is_none(), "a steady tone has no tempo to report");
        let mut noise = Noise(0xBEEF);
        let hiss: Vec<f32> = (0..(SAMPLE_RATE as usize * 8)).map(|_| noise.next() * 0.2).collect();
        assert!(detect_bpm(&hiss).is_none(), "noise has no tempo to report");
        let mut drift = Noise(7);
        let pad: Vec<f32> = (0..(SAMPLE_RATE as usize * 8)).map(|index| {
            let seconds = index as f32 / SAMPLE_RATE;
            (libm::sinf(2.0 * core::f32::consts::PI * 110.0 * seconds)
                + libm::sinf(2.0 * core::f32::consts::PI * 165.0 * seconds)) * 0.2 + drift.next() * 0.02
        }).collect();
        assert!(detect_bpm(&pad).is_none(), "a sustained pad has no tempo to report");
    }

    #[test]
    fn refuses_silence_and_material_that_is_too_short() {
        assert!(detect_bpm(&vec![0.0f32; SAMPLE_RATE as usize * 8]).is_none());
        assert!(detect_bpm(&drum_loop(120.0, 0.25)).is_none(), "half a second cannot establish a tempo");
    }

    #[test]
    fn detects_a_single_bar_loop() {
        // One bar is ordinary loop material: at 125 bpm it is 1.92s, under the two-second floor this used
        // to have, which refused it outright and reported the sample as having no tempo at all.
        // Both common sample rates: 44.1k is where a one-bar loop's rougher estimate first overshot the
        // snap window, so it must stay in the suite.
        for (sample_rate, bpm) in [(48000.0f32, 125.0f64), (44100.0, 125.0), (44100.0, 140.0)] {
            let detected = detect(&drum_loop_at(sample_rate, bpm, 1.0), sample_rate, &TempoConfig::default())
                .map(|estimate| estimate.bpm)
                .unwrap_or_else(|| panic!("one bar at {bpm} bpm / {sample_rate} Hz was refused"));
            // Not exactly equal: a whole number of samples rarely lands on a whole number of beats, so the
            // snap targets the tempo the FILE actually has, which is a hair off the nominal one.
            assert!((detected - bpm).abs() < 0.01, "expected about {bpm}, got {detected}");
        }
    }

    #[test]
    fn a_slow_loop_may_be_read_an_octave_up_but_stays_exact() {
        let estimate = detect(&drum_loop(75.0, 4.0), SAMPLE_RATE, &TempoConfig::default()).unwrap();
        assert!(estimate.snapped_to_grid);
        assert_on_the_grid(estimate.bpm, 75.0);
    }
}

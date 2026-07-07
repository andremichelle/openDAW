//! The CTAG DRC compressor DSP subsystem, a faithful port of lib-dsp `ctagdrc/*` (itself ported from
//! https://github.com/p-hlp/CTAGDRC). A feed-forward compressor: a `GainComputer` maps the level to a
//! soft-knee attenuation curve, a `LevelDetector` (branched peak follower with optional crest-factor
//! auto-attack/release) smooths it, and an optional `LookAhead` + `DelayLine` align the reduction with a
//! delayed signal. `f32`, fixed buffers (no allocation): the look-ahead window is at most 5 ms.

use crate::RENDER_QUANTUM;
use crate::fast_math::{fast_exp2, fast_log2};

// WASM CONTRACT: log10(2) and log2(10), identical literals in TS `ctagdrc/conversation.ts`, so the fast
// dB conversions below run bit-for-bit mirrored across the engines (`log10 = log2 * LOG10_2`, `10^x =
// 2^(x * LOG2_10)`). Called PER SAMPLE in the compressor's gain path, hence the fast approximations.
const LOG10_2: f64 = 0.301029995663981195;
const LOG2_10: f64 = 3.321928094887362348;

/// gain -> dB (`gainToDecibels`): 0 or below maps to a -100 dB floor.
pub fn gain_to_decibels(gain: f32) -> f32 {
    if gain > 0.0 {(20.0 * fast_log2(gain as f64) * LOG10_2) as f32} else {-100.0}
}

/// dB -> gain (`decibelsToGain`).
pub fn decibels_to_gain(db: f32) -> f32 {
    fast_exp2(db as f64 * 0.05 * LOG2_10) as f32
}

/// The soft-knee static compression curve (`GainComputer`): returns the (negative) dB attenuation for an input
/// level in dB.
pub struct GainComputer {
    threshold: f32,
    ratio: f32,
    knee: f32,
    knee_half: f32,
    slope: f32
}

impl Default for GainComputer {
    fn default() -> Self {
        Self {threshold: -20.0, ratio: 2.0, knee: 6.0, knee_half: 3.0, slope: -0.5}
    }
}

impl GainComputer {
    pub fn set_threshold(&mut self, threshold: f32) {
        self.threshold = threshold;
    }

    pub fn set_ratio(&mut self, ratio: f32) {
        if self.ratio != ratio {
            self.ratio = if ratio > 23.9 {f32::NEG_INFINITY} else {ratio};
            self.slope = 1.0 / ratio - 1.0;
        }
    }

    pub fn set_knee(&mut self, knee: f32) {
        if knee != self.knee {
            self.knee = knee;
            self.knee_half = knee / 2.0;
        }
    }

    pub fn apply_compression(&self, input: f32) -> f32 {
        let overshoot = input - self.threshold;
        if overshoot <= -self.knee_half {
            0.0
        } else if overshoot <= self.knee_half {
            0.5 * self.slope * ((overshoot + self.knee_half) * (overshoot + self.knee_half)) / self.knee
        } else {
            self.slope * overshoot
        }
    }

    pub fn apply_compression_to_buffer(&self, src: &mut [f32], from: usize, to: usize) {
        for sample in &mut src[from..to] {
            let level = libm::fabsf(*sample).max(1e-6);
            *sample = self.apply_compression(gain_to_decibels(level));
        }
    }
}

/// A 1-pole IIR smoother (`SmoothingFilter`); `alpha` is the pole weight on the new sample.
pub struct SmoothingFilter {
    sample_rate: f32,
    a1: f32,
    b1: f32,
    state: f32,
    first: bool
}

impl SmoothingFilter {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate, a1: 1.0, b1: 0.0, state: 0.0, first: true}
    }

    pub fn process(&mut self, sample: f32) {
        if self.first {
            self.state = sample;
            self.first = false;
        }
        self.state = self.a1 * sample + self.b1 * self.state;
    }

    pub fn set_alpha(&mut self, a: f32) {
        self.a1 = a;
        self.b1 = 1.0 - a;
    }

    pub fn set_alpha_with_time(&mut self, time_in_seconds: f32) {
        self.a1 = libm::expf(-1.0 / (self.sample_rate * time_in_seconds));
        self.b1 = 1.0 - self.a1;
    }

    pub fn get_state(&self) -> f32 {
        self.state
    }
}

/// The crest-factor auto-ballistics calculator (`CrestFactor`): per block it derives an average attack /
/// release time from the peak-to-RMS ratio.
pub struct CrestFactor {
    a1: f32,
    b1: f32,
    attack_time: f32,
    release_time: f32,
    avg_attack_time: f32,
    avg_release_time: f32,
    peak_state: f32,
    rms_state: f32,
    c_factor: f32
}

impl CrestFactor {
    const MAX_ATTACK_TIME: f32 = 0.08;
    const MAX_RELEASE_TIME: f32 = 1.0;

    pub fn new(sample_rate: f32) -> Self {
        let a1 = libm::expf(-1.0 / (sample_rate * 0.2));
        Self {
            a1, b1: 1.0 - a1, attack_time: 0.0, release_time: 0.14, avg_attack_time: 0.0,
            avg_release_time: 0.14, peak_state: 0.0, rms_state: 0.0, c_factor: 0.0
        }
    }

    pub fn process(&mut self, src: &[f32], from: usize, to: usize) {
        if self.peak_state == 0.0 {self.peak_state = src[0];}
        if self.rms_state == 0.0 {self.rms_state = src[0];}
        self.avg_attack_time = 0.0;
        self.avg_release_time = 0.0;
        for &sample in &src[from..to] {
            let s = sample * sample;
            self.peak_state = s.max(self.a1 * self.peak_state + self.b1 * s);
            self.rms_state = self.a1 * self.rms_state + self.b1 * s;
            let c = self.peak_state / self.rms_state;
            self.c_factor = if c > 0.0 {c} else {0.0};
            if self.c_factor > 0.0 {
                self.attack_time = 2.0 * (Self::MAX_ATTACK_TIME / self.c_factor);
                self.release_time = 2.0 * (Self::MAX_RELEASE_TIME / self.c_factor) - self.attack_time;
                self.avg_attack_time += self.attack_time;
                self.avg_release_time += self.release_time;
            }
        }
        let n = (to - from) as f32;
        self.avg_attack_time /= n;
        self.avg_release_time /= n;
    }

    pub fn avg_attack(&self) -> f32 {
        self.avg_attack_time
    }

    pub fn avg_release(&self) -> f32 {
        self.avg_release_time
    }
}

/// The branched peak-follower level detector (`LevelDetector`) with optional crest-factor auto-ballistics.
pub struct LevelDetector {
    sample_rate: f32,
    crest_factor: CrestFactor,
    attack_smoothing: SmoothingFilter,
    release_smoothing: SmoothingFilter,
    attack_time: f32,
    alpha_attack: f32,
    release_time: f32,
    alpha_release: f32,
    state01: f32,
    auto_attack: bool,
    auto_release: bool
}

impl LevelDetector {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            crest_factor: CrestFactor::new(sample_rate),
            attack_smoothing: SmoothingFilter::new(sample_rate),
            release_smoothing: SmoothingFilter::new(sample_rate),
            attack_time: 0.01,
            alpha_attack: libm::expf(-1.0 / (sample_rate * 0.01)),
            release_time: 0.14,
            alpha_release: libm::expf(-1.0 / (sample_rate * 0.14)),
            state01: 0.0,
            auto_attack: false,
            auto_release: false
        }
    }

    pub fn set_attack(&mut self, attack: f32) {
        if attack != self.attack_time {
            self.attack_time = attack;
            self.alpha_attack = libm::expf(-1.0 / (self.sample_rate * attack));
        }
    }

    pub fn set_release(&mut self, release: f32) {
        if release != self.release_time {
            self.release_time = release;
            self.alpha_release = libm::expf(-1.0 / (self.sample_rate * release));
        }
    }

    pub fn set_auto_attack(&mut self, enabled: bool) {
        self.auto_attack = enabled;
    }

    pub fn set_auto_release(&mut self, enabled: bool) {
        self.auto_release = enabled;
    }

    fn process_peak_branched(&mut self, input: f32) -> f32 {
        if input < self.state01 {
            self.state01 = self.alpha_attack * self.state01 + (1.0 - self.alpha_attack) * input;
        } else {
            self.state01 = self.alpha_release * self.state01 + (1.0 - self.alpha_release) * input;
        }
        self.state01
    }

    pub fn apply_ballistics(&mut self, src: &mut [f32], from: usize, to: usize) {
        for sample in &mut src[from..to] {
            *sample = self.process_peak_branched(*sample);
        }
    }

    pub fn process_crest_factor(&mut self, src: &[f32], from: usize, to: usize) {
        if self.auto_attack || self.auto_release {
            self.crest_factor.process(src, from, to);
            self.attack_smoothing.process(self.crest_factor.avg_attack());
            self.release_smoothing.process(self.crest_factor.avg_release());
            if self.auto_attack {
                let attack = self.attack_smoothing.get_state();
                self.set_attack(attack);
            }
            if self.auto_release {
                let release = self.release_smoothing.get_state();
                self.set_release(release);
            }
        }
    }
}

/// The largest look-ahead delay we support (5 ms at 192 kHz) plus one render quantum: the fixed ring size.
const MAX_DELAY_SAMPLES: usize = 960;
const DELAY_BUFFER_SIZE: usize = RENDER_QUANTUM + MAX_DELAY_SAMPLES;

/// A stereo look-ahead delay line (`DelayLine`, 2 channels): delays the signal so the (faded-in) gain reduction
/// lands before a transient.
pub struct DelayLine {
    buffer: [[f32; DELAY_BUFFER_SIZE]; 2],
    delay_in_samples: usize,
    write_position: usize
}

impl DelayLine {
    pub fn new(sample_rate: f32, delay_in_seconds: f32) -> Self {
        let delay_in_samples = (libm::floorf(sample_rate * delay_in_seconds) as usize).min(MAX_DELAY_SAMPLES);
        Self {buffer: [[0.0; DELAY_BUFFER_SIZE]; 2], delay_in_samples, write_position: 0}
    }

    pub fn process(&mut self, channels: [&mut [f32]; 2], from: usize, to: usize) {
        if self.delay_in_samples == 0 {
            return;
        }
        let size = DELAY_BUFFER_SIZE;
        let read_position = (self.write_position + size - self.delay_in_samples) % size;
        let [left, right] = channels;
        for (channel, data) in [left, right].into_iter().enumerate() {
            let mut write_pos = self.write_position;
            let mut read_pos = read_position;
            for i in from..to {
                let delayed = self.buffer[channel][read_pos];
                self.buffer[channel][write_pos] = data[i];
                data[i] = delayed;
                write_pos = (write_pos + 1) % size;
                read_pos = (read_pos + 1) % size;
            }
        }
        self.write_position = (self.write_position + (to - from)) % size;
    }
}

/// The gain-reduction look-ahead smoother (`LookAhead`): fades each attenuation dip in over the delay window so
/// the delayed signal is already ducked when the transient arrives.
pub struct LookAhead {
    buffer: [f32; DELAY_BUFFER_SIZE],
    delay_in_samples: usize,
    buffer_size: usize,
    write_position: usize,
    num_last_pushed: usize
}

impl LookAhead {
    pub fn new(sample_rate: f32, delay: f32) -> Self {
        let delay_in_samples = (libm::floorf(sample_rate * delay) as usize).min(MAX_DELAY_SAMPLES);
        Self {
            buffer: [0.0; DELAY_BUFFER_SIZE],
            delay_in_samples,
            buffer_size: RENDER_QUANTUM + delay_in_samples,
            write_position: 0,
            num_last_pushed: 0
        }
    }

    pub fn process(&mut self, src: &mut [f32], from: usize, to: usize) {
        self.push_samples(src, from, to);
        self.process_samples();
        self.read_samples(src, from, to);
    }

    fn push_samples(&mut self, src: &[f32], from: usize, to: usize) {
        for &sample in &src[from..to] {
            self.buffer[self.write_position] = sample;
            self.write_position = (self.write_position + 1) % self.buffer_size;
        }
        self.num_last_pushed = to - from;
    }

    fn read_samples(&self, dst: &mut [f32], from: usize, to: usize) {
        let mut read_position = self.write_position as isize - self.num_last_pushed as isize - self.delay_in_samples as isize;
        if read_position < 0 {
            read_position += self.buffer_size as isize;
        }
        let mut read_position = read_position as usize;
        for sample in &mut dst[from..to] {
            *sample = self.buffer[read_position];
            read_position = (read_position + 1) % self.buffer_size;
        }
    }

    fn process_samples(&mut self) {
        let mut index = if self.write_position == 0 {self.buffer_size - 1} else {self.write_position - 1};
        let mut next_value = 0.0f32;
        let mut slope = 0.0f32;
        for _ in 0..self.num_last_pushed {
            let sample = self.buffer[index];
            if sample > next_value {
                self.buffer[index] = next_value;
                next_value += slope;
            } else {
                slope = -sample / self.delay_in_samples as f32;
                next_value = sample + slope;
            }
            index = if index == 0 {self.buffer_size - 1} else {index - 1};
        }
        for _ in 0..self.delay_in_samples {
            let sample = self.buffer[index];
            if sample > next_value {
                self.buffer[index] = next_value;
                next_value += slope;
            } else {
                break;
            }
            index = if index == 0 {self.buffer_size - 1} else {index - 1};
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decibels_to_gain, gain_to_decibels, GainComputer, LevelDetector, SmoothingFilter};

    #[test]
    fn db_gain_round_trips() {
        assert!((decibels_to_gain(0.0) - 1.0).abs() < 1e-6);
        assert!((gain_to_decibels(1.0)).abs() < 1e-4);
        assert!((decibels_to_gain(-6.0) - 0.5011872).abs() < 1e-4);
        assert_eq!(gain_to_decibels(0.0), -100.0, "the silence floor");
    }

    // The fast dB conversions must be INAUDIBLY close to the exact `20*log10` / `10^(db/20)` they replaced,
    // independent of the (now also-fast) TS side. Bounds the compression error directly in dB / linear gain.
    #[test]
    fn fast_db_conversions_match_the_exact_math() {
        let mut max_db_error = 0.0f32;
        for step in 1..200_000i32 {
            let level = step as f32 / 12_500.0; // 8e-5 .. 16.0, spanning the compressor's input levels
            let exact_db = 20.0 * libm::log10f(level);
            max_db_error = max_db_error.max((gain_to_decibels(level) - exact_db).abs());
        }
        assert!(max_db_error < 1.0e-3, "max compression dB error {max_db_error}");
        let mut max_gain_rel = 0.0f32;
        for step in -1200..400i32 {
            let db = step as f32 / 10.0; // -120 dB .. +40 dB makeup/reduction range
            let exact_gain = libm::powf(10.0, db * 0.05);
            max_gain_rel = max_gain_rel.max(((decibels_to_gain(db) - exact_gain) / exact_gain).abs());
        }
        assert!(max_gain_rel < 1.0e-5, "max makeup-gain relative error {max_gain_rel}");
    }

    #[test]
    fn gain_computer_attenuates_above_threshold_only() {
        let mut gc = GainComputer::default();
        gc.set_threshold(-10.0);
        gc.set_ratio(4.0);
        gc.set_knee(0.0);
        assert_eq!(gc.apply_compression(-20.0), 0.0, "below threshold: no attenuation");
        // 10 dB over at ratio 4 -> slope -0.75 -> -7.5 dB reduction.
        assert!((gc.apply_compression(0.0) - (-7.5)).abs() < 1e-4, "above threshold: ratio applies");
    }

    #[test]
    fn soft_knee_is_gradual_around_the_threshold() {
        let mut hard = GainComputer::default();
        hard.set_threshold(-10.0);
        hard.set_ratio(4.0);
        hard.set_knee(0.0);
        let mut soft = GainComputer::default();
        soft.set_threshold(-10.0);
        soft.set_ratio(4.0);
        soft.set_knee(12.0);
        // Just below the threshold, the hard knee gives 0 while the soft knee has already begun reducing.
        assert_eq!(hard.apply_compression(-12.0), 0.0);
        assert!(soft.apply_compression(-12.0) < 0.0, "the soft knee engages before the threshold");
    }

    #[test]
    fn smoothing_filter_converges() {
        let mut filter = SmoothingFilter::new(48_000.0);
        filter.set_alpha(0.03);
        for _ in 0..1000 {filter.process(1.0);}
        assert!((filter.get_state() - 1.0).abs() < 1e-3, "converges to the target");
    }

    #[test]
    fn level_detector_smooths_a_step() {
        let mut detector = LevelDetector::new(48_000.0);
        detector.set_attack(0.005);
        detector.set_release(0.1);
        let mut buffer = [0.5f32; 256];
        detector.apply_ballistics(&mut buffer, 0, 256);
        assert!(buffer[0] < 0.5 && buffer[255] > buffer[0], "the step is smoothed upward over the block");
    }
}

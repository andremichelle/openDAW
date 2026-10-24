use crate::yin::Yin;

const SIZE: usize = 2048;
const WINDOW: usize = 512;
const MAX_LAG: usize = 512;
const WORK_PER_SAMPLE: usize = 192;

pub struct Detector {
    ring: [[f32; SIZE]; 2],
    scratch: [f32; WINDOW + MAX_LAG + 1],
    yin: Yin<{ MAX_LAG + 1 }>,
    analyzing: bool,
    min_lag: usize,
    max_lag: usize,
    write: usize,
    count: usize,
    factor: usize,
    pending: [f32; 2],
    pending_count: usize,
    hop: usize,
    rate: f64,
    pub frequency: f32,
    pub confidence: f32,
    pub level: f32,
}

impl Detector {
    /// Initializes fixed storage for a decimated 30–2000 Hz detector.
    pub fn prepare(&mut self, sample_rate: f32) {
        self.factor = libm::ceil(sample_rate as f64 / 12000.0).max(1.0) as usize;
        self.rate = sample_rate as f64 / self.factor as f64;
        self.min_lag = libm::floor(self.rate / 2000.0).max(2.0) as usize;
        self.max_lag = (libm::ceil(self.rate / 30.0) as usize).min(MAX_LAG - 1);
        self.reset();
    }

    /// Clears captured audio, in-flight analysis and published measurements.
    pub fn reset(&mut self) {
        self.ring = [[0.0; SIZE]; 2];
        self.write = 0;
        self.count = 0;
        self.pending = [0.0; 2];
        self.pending_count = 0;
        self.hop = 0;
        self.frequency = 0.0;
        self.confidence = 0.0;
        self.level = -120.0;
        self.analyzing = false;
        self.yin.reset();
    }

    /// Captures one stereo sample and performs at most 192 YIN sample-pair comparisons.
    pub fn feed(&mut self, left: f32, right: f32, channel: i32, threshold: f32) {
        self.advance_analysis();
        self.pending[0] += if left.is_finite() { left } else { 0.0 };
        self.pending[1] += if right.is_finite() { right } else { 0.0 };
        self.pending_count += 1;
        if self.pending_count < self.factor {
            return;
        }
        for channel in 0..2 {
            self.ring[channel][self.write] = self.pending[channel] / self.factor as f32;
        }
        self.pending = [0.0; 2];
        self.pending_count = 0;
        self.write = (self.write + 1) % SIZE;
        self.count = (self.count + 1).min(SIZE);
        self.hop += 1;
        if self.hop < (self.rate / 30.0) as usize {
            return;
        }
        self.hop = 0;
        if self.count < WINDOW + MAX_LAG + 1 || self.analyzing {
            return;
        }
        self.begin_analysis(channel, threshold);
    }

    fn begin_analysis(&mut self, channel: i32, threshold: f32) {
        let start = (self.write + SIZE - self.scratch.len()) % SIZE;
        let mut energy = [0.0f64; 2];
        for index in 0..self.scratch.len() {
            for ch in 0..2 {
                let value = self.ring[ch][(start + index) % SIZE] as f64;
                energy[ch] += value * value;
            }
        }
        let selected = match channel {
            1 => 0,
            2 => 1,
            _ => {
                if energy[1] > energy[0] {
                    1
                } else {
                    0
                }
            }
        };
        let rms = libm::sqrt(energy[selected] / self.scratch.len() as f64);
        self.level = (20.0 * libm::log10(rms.max(1.0e-6))) as f32;
        if self.level < threshold {
            self.frequency = 0.0;
            self.confidence = 0.0;
            return;
        }
        let mut mean = 0.0;
        for index in 0..self.scratch.len() {
            self.scratch[index] = self.ring[selected][(start + index) % SIZE];
            mean += self.scratch[index];
        }
        mean /= self.scratch.len() as f32;
        for value in self.scratch.iter_mut() {
            *value -= mean;
        }
        self.yin.reset();
        self.analyzing = true;
    }

    fn advance_analysis(&mut self) {
        if !self.analyzing {
            return;
        }
        self.yin
            .advance(&self.scratch, WINDOW, self.max_lag + 1, WORK_PER_SAMPLE);
        if !self.yin.complete(self.max_lag + 1) {
            return;
        }
        self.analyzing = false;
        self.frequency = 0.0;
        self.confidence = 0.0;
        let (period, clarity) = self.yin.estimate(self.min_lag, self.max_lag, 0.15);
        if clarity < 0.15 {
            let mut first = None;
            let mut samples = 0.0;
            let mut cycles = 0.0;
            for index in 1..self.scratch.len() {
                let a = self.scratch[index - 1] as f64;
                let b = self.scratch[index] as f64;
                if a <= 0.0 && b > 0.0 {
                    let crossing = index as f64 - b / (b - a);
                    if let Some(anchor) = first {
                        let distance: f64 = crossing - anchor;
                        let count = libm::round(distance / period);
                        if count >= 1.0 && (distance / count - period).abs() < period * 0.1 {
                            samples += distance;
                            cycles += count;
                            first = Some(crossing);
                        }
                    } else {
                        first = Some(crossing);
                    }
                }
            }
            let refined = if cycles >= 2.0 {
                samples / cycles
            } else {
                period
            };
            let hz = self.rate / refined;
            if (30.0..=2000.0).contains(&hz) {
                self.frequency = hz as f32;
                self.confidence = (1.0 - clarity).clamp(0.0, 1.0) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Detector;
    #[test]
    fn analysis_finishes_across_multiple_render_quanta() {
        let mut detector: Box<Detector> = unsafe { Box::new(core::mem::zeroed()) };
        detector.prepare(48000.0);
        let tone =
            |index: usize| (2.0 * core::f32::consts::PI * 440.0 * index as f32 / 48000.0).sin();
        let mut index = 0;
        while !detector.analyzing {
            detector.feed(tone(index), tone(index), 0, -55.0);
            index += 1;
        }
        assert_eq!(detector.frequency, 0.0);
        let start = index;
        while detector.analyzing {
            detector.feed(tone(index), tone(index), 0, -55.0);
            index += 1;
        }
        assert!(index - start > 128 * 8);
        assert!(index - start < 48000 / 30);
        assert!((detector.frequency - 440.0).abs() < 1.0);
    }
    fn detect(rate: f32, hz: f32, amplitude: f32, channel: i32, right_only: bool) -> Box<Detector> {
        let mut detector: Box<Detector> = unsafe { Box::new(core::mem::zeroed()) };
        detector.prepare(rate);
        for index in 0..(rate as usize / 2) {
            let phase = 2.0 * core::f32::consts::PI * hz * index as f32 / rate;
            let tone = amplitude * (phase.sin() + 0.25 * (phase * 2.0).sin());
            detector.feed(if right_only { 0.0 } else { tone }, -tone, channel, -55.0);
        }
        detector
    }
    #[test]
    fn detects_bass_and_treble_at_common_sample_rates() {
        for rate in [44100.0, 48000.0, 96000.0] {
            for hz in [32.7, 41.2, 55.0, 110.0, 440.0, 1000.0, 1800.0] {
                let result = detect(rate, hz, 0.4, 0, false);
                let cents = 1200.0 * (result.frequency / hz).log2();
                assert!(
                    cents.abs() < 3.0,
                    "{rate} Hz, {hz} Hz: {} Hz, {cents} cents",
                    result.frequency
                );
                assert!(result.confidence > 0.85);
            }
        }
    }
    #[test]
    fn auto_handles_antiphase_and_right_only_audio() {
        assert!((detect(48000.0, 220.0, 0.5, 0, false).frequency - 220.0).abs() < 1.0);
        assert!((detect(48000.0, 220.0, 0.5, 0, true).frequency - 220.0).abs() < 1.0);
        assert_eq!(detect(48000.0, 220.0, 0.5, 1, true).frequency, 0.0);
    }
    #[test]
    fn silence_and_quiet_input_clear_the_reading() {
        assert_eq!(detect(48000.0, 440.0, 0.0, 0, false).frequency, 0.0);
        assert_eq!(detect(48000.0, 440.0, 0.0001, 0, false).frequency, 0.0);
        let mut detector = detect(48000.0, 440.0, 0.4, 0, false);
        for _ in 0..24000 {
            detector.feed(0.0, 0.0, 0, -55.0);
        }
        assert_eq!(detector.frequency, 0.0);
        detector.reset();
        assert_eq!(detector.confidence, 0.0);
    }
    #[test]
    fn rejects_nonfinite_input_and_noise() {
        let mut detector = detect(48000.0, 440.0, 0.0, 0, false);
        let mut seed = 1u32;
        for index in 0..24000 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (seed as f64 / u32::MAX as f64 - 0.5) as f32;
            detector.feed(
                noise,
                if index % 2 == 0 {
                    f32::NAN
                } else {
                    f32::INFINITY
                },
                0,
                -55.0,
            );
        }
        assert_eq!(detector.frequency, 0.0);
        assert!(detector.level.is_finite());
    }
}

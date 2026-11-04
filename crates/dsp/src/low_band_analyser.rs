//! The port of lib-dsp `LowBandAnalyser`: fine bins for the low end of a spectrum display, from a low-passed
//! and decimated signal. ALLOCATION-FREE and built IN PLACE via `init`, like [`AudioAnalyser`].

use crate::analyser::{AudioAnalyser, FFT_SIZE};
use crate::biquad::{BiquadCoeff, BiquadProcessor, BiquadStack};

pub const LOW_NUM_BINS: usize = 64; // TS LowBandAnalyser.NUM_BINS
const HOP: usize = 1024;
const TARGET_RATE: f64 = 6000.0;
const FILTER_SECTIONS: usize = 4;

pub struct LowBandAnalyser {
    analyser: AudioAnalyser,
    ring: [f32; FFT_SIZE],
    coeff: BiquadCoeff,
    filter: BiquadStack,
    decimation: usize,
    hop: usize,
    phase: usize,
    write_index: usize,
    since_update: usize
}

impl LowBandAnalyser {
    pub fn init(&mut self, sample_rate: f32, decay_factor: f32) {
        self.analyser.init(decay_factor);
        self.ring.fill(0.0);
        self.decimation = 1usize << libm::round(libm::log2(sample_rate as f64 / TARGET_RATE)) as u32;
        self.hop = HOP / self.decimation;
        self.coeff.set_lowpass_params(0.25 / self.decimation as f64, core::f64::consts::FRAC_1_SQRT_2);
        self.filter = BiquadStack::new(FILTER_SECTIONS);
        self.phase = 0;
        self.write_index = 0;
        self.since_update = 0;
    }

    pub fn bins(&self) -> &[f32] {
        &self.analyser.bins()[..LOW_NUM_BINS]
    }

    pub fn arm_decay(&mut self) {
        self.analyser.decay = true;
    }

    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        for index in 0..left.len().min(right.len()) {
            let filtered = self.filter.process_frame(&self.coeff, (left[index] + right[index]) as f64);
            self.phase += 1;
            if self.phase < self.decimation {
                continue;
            }
            self.phase = 0;
            self.ring[self.write_index] = filtered as f32;
            self.write_index = (self.write_index + 1) & (FFT_SIZE - 1);
            self.since_update += 1;
            if self.since_update == self.hop {
                self.since_update = 0;
                self.analyser.analyse_ring(&self.ring, self.write_index);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LowBandAnalyser, LOW_NUM_BINS};
    use crate::analyser::{AudioAnalyser, NUM_BINS};

    const RATE: f64 = 48000.0;
    const WIDTH: f64 = 6000.0 / 1024.0;

    fn low_band(sample_rate: f32) -> Box<LowBandAnalyser> {
        let mut boxed: Box<LowBandAnalyser> = Box::new(unsafe { core::mem::zeroed() });
        boxed.init(sample_rate, 0.0);
        boxed
    }

    fn sine(frequency: f64, gain: f64, frame: usize, rate: f64) -> f32 {
        (libm::sin(2.0 * core::f64::consts::PI * frequency * frame as f64 / rate) * gain) as f32
    }

    fn feed(analyser: &mut LowBandAnalyser, frames: usize, start: usize, rate: f64, frequency: f64, gain: f64) {
        let mut block = [0.0f32; 128];
        for round in 0..frames / 128 {
            for (offset, value) in block.iter_mut().enumerate() {
                *value = sine(frequency, gain, start + round * 128 + offset, rate);
            }
            analyser.process(&block, &block);
        }
    }

    fn peak(bins: &[f32]) -> usize {
        (0..bins.len()).max_by(|&a, &b| bins[a].total_cmp(&bins[b])).unwrap()
    }

    #[test]
    fn a_60_hz_sine_peaks_in_its_own_bin() {
        for (rate, width) in [(44100.0, 44100.0 / 8192.0), (48000.0, WIDTH), (96000.0, 96000.0 / 16384.0)] {
            let mut analyser = low_band(rate as f32);
            feed(&mut analyser, 1 << 16, 0, rate, 60.0, 0.25);
            assert_eq!(peak(analyser.bins()), libm::round(60.0 / width) as usize, "at {rate} Hz");
        }
    }

    #[test]
    fn a_steady_tone_reads_the_same_level_as_the_main_analyser() {
        let mut low = low_band(48000.0);
        let mut main: Box<AudioAnalyser> = Box::new(unsafe { core::mem::zeroed() });
        main.init(0.0);
        let mut block = [0.0f32; 128];
        for round in 0..256usize {
            for (offset, value) in block.iter_mut().enumerate() {
                *value = sine(187.5, 0.25, round * 128 + offset, RATE);
            }
            low.process(&block, &block);
            main.process(&block, &block);
        }
        assert_eq!(main.bins().len(), NUM_BINS);
        let difference = 20.0 * libm::log10((low.bins()[32] / main.bins()[4]) as f64);
        assert!(difference.abs() < 0.5, "difference {difference} dB");
    }

    #[test]
    fn tones_above_the_band_do_not_fold_into_the_displayed_range() {
        for frequency in [5750.0, 5950.0, 6050.0, 6250.0, 11900.0, 12100.0, 18100.0] {
            let mut analyser = low_band(48000.0);
            for hop in 0..256 {
                feed(&mut analyser, 1024, hop * 1024, RATE, frequency, 1.0);
                analyser.arm_decay();
            }
            let displayed = libm::ceil(300.0 / WIDTH) as usize;
            let loudest = analyser.bins()[..displayed].iter().fold(0.0f32, |max, value| max.max(*value));
            assert!(20.0 * libm::log10(loudest as f64) < -80.0, "{frequency} Hz reads {loudest}");
        }
    }

    #[test]
    fn updates_every_1024_input_samples() {
        let mut analyser = low_band(48000.0);
        feed(&mut analyser, 896, 0, RATE, 60.0, 0.25);
        assert!(analyser.bins().iter().all(|&value| value == 0.0));
        feed(&mut analyser, 128, 896, RATE, 60.0, 0.25);
        assert!(analyser.bins().iter().any(|&value| value > 0.0));
        assert_eq!(analyser.bins().len(), LOW_NUM_BINS);
    }

    #[test]
    fn holds_until_the_decay_is_armed() {
        let mut analyser = low_band(48000.0);
        feed(&mut analyser, 1 << 15, 0, RATE, 60.0, 0.25);
        let bin = peak(analyser.bins());
        let held = analyser.bins()[bin];
        feed(&mut analyser, 1 << 14, 0, RATE, 60.0, 0.0);
        assert_eq!(analyser.bins()[bin], held);
        analyser.arm_decay();
        feed(&mut analyser, 1 << 11, 0, RATE, 60.0, 0.0);
        assert!(analyser.bins()[bin] < held);
    }
}

use alloc::vec::Vec;
use crate::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use crate::linkwitz_riley::{LinkwitzRileyCoefficients, LinkwitzRileyStage};
use crate::RENDER_QUANTUM;

pub const MAX_BANDS: usize = 4;
const MAX_CROSSOVERS: usize = MAX_BANDS - 1;

type Pair = (LinkwitzRileyStage, LinkwitzRileyStage);

pub struct FrequencySplitter {
    sample_rate: f64,
    band_count: usize,
    crossovers: [f64; MAX_CROSSOVERS],
    splitters: [Pair; MAX_CROSSOVERS],
    allpasses: [[Pair; MAX_CROSSOVERS]; MAX_CROSSOVERS],
    bands: Vec<SharedAudioBuffer>,
    remainder: [SharedAudioBuffer; 2],
    scratch: SharedAudioBuffer,
    silent: SharedAudioBuffer
}

impl FrequencySplitter {
    pub fn new(sample_rate: f64, band_count: usize, crossovers: &[f64]) -> Self {
        let empty = (LinkwitzRileyStage::new(), LinkwitzRileyStage::new());
        let mut frequencies = [200.0, 1_000.0, 5_000.0];
        for index in 0..MAX_CROSSOVERS.min(crossovers.len()) {
            frequencies[index] = crossovers[index];
        }
        let mut splitter = Self {
            sample_rate,
            band_count: band_count.clamp(2, MAX_BANDS),
            crossovers: frequencies,
            splitters: [empty; MAX_CROSSOVERS],
            allpasses: [[empty; MAX_CROSSOVERS]; MAX_CROSSOVERS],
            bands: (0..MAX_BANDS).map(|_| shared_audio_buffer()).collect(),
            remainder: [shared_audio_buffer(), shared_audio_buffer()],
            scratch: shared_audio_buffer(),
            silent: shared_audio_buffer()
        };
        splitter.configure();
        splitter
    }

    pub fn band_count(&self) -> usize {self.band_count}

    pub fn set_band_count(&mut self, band_count: usize) {
        let clamped = band_count.clamp(2, MAX_BANDS);
        if clamped != self.band_count {
            self.band_count = clamped;
            self.reset();
            self.configure();
        }
    }

    pub fn set_crossover(&mut self, index: usize, frequency: f64) {
        if index < MAX_CROSSOVERS && self.crossovers[index] != frequency {
            self.crossovers[index] = frequency;
            self.configure();
        }
    }

    pub fn band(&self, index: usize) -> SharedAudioBuffer {
        if index < self.band_count {self.bands[index].clone()} else {self.silent.clone()}
    }

    pub fn reset(&mut self) {
        for pair in self.splitters.iter_mut() {
            pair.0.clear();
            pair.1.clear();
        }
        for row in self.allpasses.iter_mut() {
            for pair in row.iter_mut() {
                pair.0.clear();
                pair.1.clear();
            }
        }
        for band in self.bands.iter() {
            band.borrow_mut().clear();
        }
    }

    fn configure(&mut self) {
        let crossover_count = self.band_count - 1;
        for i in 0..crossover_count {
            let coefficients = LinkwitzRileyCoefficients::crossover(self.crossovers[i], self.sample_rate);
            self.splitters[i].0.set_lowpass(&coefficients);
            self.splitters[i].1.set_highpass(&coefficients);
            for j in 0..i {
                self.allpasses[i][j].0.set_lowpass(&coefficients);
                self.allpasses[i][j].1.set_highpass(&coefficients);
            }
        }
    }

    pub fn process(&mut self, input: &SharedAudioBuffer) {
        let crossover_count = self.band_count - 1;
        let scratch = self.scratch.clone();
        let mut stage = input.clone();
        for i in 0..crossover_count {
            let band_i = self.bands[i].clone();
            {
                let source = stage.borrow();
                let mut guard = band_i.borrow_mut();
                let dest = &mut *guard;
                self.splitters[i].0.process(&source.left, &source.right, &mut dest.left, &mut dest.right);
            }
            let remainder = self.remainder[i % 2].clone();
            {
                let source = stage.borrow();
                let mut guard = remainder.borrow_mut();
                let dest = &mut *guard;
                self.splitters[i].1.process(&source.left, &source.right, &mut dest.left, &mut dest.right);
            }
            for j in 0..i {
                let band_j = self.bands[j].clone();
                {
                    let source = band_j.borrow();
                    let mut guard = scratch.borrow_mut();
                    let dest = &mut *guard;
                    self.allpasses[i][j].0.process(&source.left, &source.right, &mut dest.left, &mut dest.right);
                    self.allpasses[i][j].1.process_add(&source.left, &source.right, &mut dest.left, &mut dest.right);
                }
                copy(&scratch, &band_j);
            }
            stage = remainder;
        }
        let last = self.bands[crossover_count].clone();
        copy(&stage, &last);
    }
}

fn copy(from: &SharedAudioBuffer, to: &SharedAudioBuffer) {
    let source = from.borrow();
    let mut dest = to.borrow_mut();
    dest.left[..RENDER_QUANTUM].copy_from_slice(&source.left[..RENDER_QUANTUM]);
    dest.right[..RENDER_QUANTUM].copy_from_slice(&source.right[..RENDER_QUANTUM]);
}

use alloc::vec::Vec;
use crate::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use crate::linkwitz_riley::LinkwitzRiley;
use crate::RENDER_QUANTUM;

pub const MAX_BANDS: usize = 4;
const MAX_CROSSOVERS: usize = MAX_BANDS - 1;

// Subtractive (complementary) crossover: band `i` is the lowpass of the running remainder, then subtracted out of
// it. Summing every band telescopes back to the exact input, so an unprocessed split is a true pass-through (no
// allpass phase, no crest / peak change), and it is inherently stable under a crossover drag because the sum is
// algebraic. The lowpass is a TPT filter so its cutoff can be modulated without ringing.
pub struct FrequencySplitter {
    sample_rate: f64,
    band_count: usize,
    crossovers: [f64; MAX_CROSSOVERS],
    lowpass: [LinkwitzRiley; MAX_CROSSOVERS],
    bands: Vec<SharedAudioBuffer>,
    remainder: SharedAudioBuffer,
    silent: SharedAudioBuffer
}

impl FrequencySplitter {
    pub fn new(sample_rate: f64, band_count: usize, crossovers: &[f64]) -> Self {
        let mut frequencies = [200.0, 1_000.0, 5_000.0];
        for index in 0..MAX_CROSSOVERS.min(crossovers.len()) {
            frequencies[index] = crossovers[index];
        }
        let mut splitter = Self {
            sample_rate,
            band_count: band_count.clamp(2, MAX_BANDS),
            crossovers: frequencies,
            lowpass: [LinkwitzRiley::lowpass(); MAX_CROSSOVERS],
            bands: (0..MAX_BANDS).map(|_| shared_audio_buffer()).collect(),
            remainder: shared_audio_buffer(),
            silent: shared_audio_buffer()
        };
        splitter.configure();
        splitter
    }

    pub fn band_count(&self) -> usize {self.band_count}

    pub fn applied_crossover(&self, index: usize) -> f64 {self.crossovers[index]}

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
        for filter in self.lowpass.iter_mut() {
            filter.clear();
        }
        for band in self.bands.iter() {
            band.borrow_mut().clear();
        }
    }

    fn configure(&mut self) {
        let crossover_count = self.band_count - 1;
        for i in 0..crossover_count {
            self.lowpass[i].set(self.crossovers[i], self.sample_rate);
        }
    }

    pub fn process(&mut self, input: &SharedAudioBuffer) {
        let crossover_count = self.band_count - 1;
        let remainder = self.remainder.clone();
        copy(input, &remainder);
        for i in 0..crossover_count {
            let band_i = self.bands[i].clone();
            {
                let source = remainder.borrow();
                let mut guard = band_i.borrow_mut();
                let dest = &mut *guard;
                self.lowpass[i].process(&source.left, &source.right, &mut dest.left, &mut dest.right);
            }
            let band = band_i.borrow();
            let mut guard = remainder.borrow_mut();
            let rem = &mut *guard;
            for index in 0..RENDER_QUANTUM {
                rem.left[index] -= band.left[index];
                rem.right[index] -= band.right[index];
            }
        }
        let last = self.bands[crossover_count].clone();
        copy(&remainder, &last);
    }
}

fn copy(from: &SharedAudioBuffer, to: &SharedAudioBuffer) {
    let source = from.borrow();
    let mut dest = to.borrow_mut();
    dest.left[..RENDER_QUANTUM].copy_from_slice(&source.left[..RENDER_QUANTUM]);
    dest.right[..RENDER_QUANTUM].copy_from_slice(&source.right[..RENDER_QUANTUM]);
}

//! Hann-window STFT magnitudes over a mono signal — the front end shared by onset detection and the
//! harmonicity descriptor. Bind-time / lab use: allocates freely, never on a render path.

use alloc::vec;
use alloc::vec::Vec;
use crate::fft::Fft;

pub struct Stft {
    fft: Fft,
    window: Vec<f32>,
    size: usize,
    hop: usize
}

impl Stft {
    pub fn new(size: usize, hop: usize) -> Self {
        let fft = Fft::new(size);
        let window = (0..size)
            .map(|index| (0.5 - 0.5 * libm::cos(2.0 * core::f64::consts::PI * index as f64 / size as f64)) as f32)
            .collect();
        Self {fft, window, size, hop}
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn hop(&self) -> usize {
        self.hop
    }

    /// Magnitude frames (size/2 bins each). Frame `t` covers samples `[t*hop, t*hop + size)`.
    pub fn magnitudes(&self, mono: &[f32]) -> Vec<Vec<f32>> {
        let mut frames = Vec::new();
        let mut re = vec![0.0f32; self.size];
        let mut im = vec![0.0f32; self.size];
        let mut offset = 0usize;
        while offset + self.size <= mono.len() {
            for index in 0..self.size {
                re[index] = mono[offset + index] * self.window[index];
                im[index] = 0.0;
            }
            self.fft.forward(&mut re, &mut im);
            let mut magnitudes = Vec::with_capacity(self.size / 2);
            for bin in 0..self.size / 2 {
                magnitudes.push(libm::sqrtf(re[bin] * re[bin] + im[bin] * im[bin]));
            }
            frames.push(magnitudes);
            offset += self.hop;
        }
        frames
    }
}

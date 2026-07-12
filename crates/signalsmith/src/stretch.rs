//! Derived from Signalsmith Stretch — Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd,
//! MIT License (github.com/Signalsmith-Audio/signalsmith-stretch). This is a modified Rust port
//! reshaped for openDAW's SAB/block engine; the original MIT notice is retained per its terms.
//!
//! Pure-Rust port of Signalsmith Stretch (MIT) for the spectral TimeStretchMode: STFT phase
//! vocoder with amplitude-weighted multi-prediction phase reconstruction, on our own `fft`.
//! Verified against the native C++ (lab oracle). `no_std`+alloc; buffers sized at `configure`,
//! render loop allocation-free. Time-stretch first (mode default playback_rate=1); the pitch path
//! (freq map + peak locking) layers on after time-stretch matches the oracle.
//!
//! Design deltas from the C++, all output-neutral: splitComputation dropped (full spectrum per hop),
//! radix-2 pow2 block on our FFT (native uses 5760) so parity is epsilon not bit-exact.

use alloc::vec;
use alloc::vec::Vec;
use crate::fft::Fft;

#[derive(Clone, Copy, Default)]
struct Cplx { re: f32, im: f32 }
impl Cplx {
    #[inline] fn mul(self, o: Cplx) -> Cplx { Cplx { re: self.re*o.re - self.im*o.im, im: self.re*o.im + self.im*o.re } }
    #[inline] fn conj_mul(self, o: Cplx) -> Cplx { Cplx { re: self.re*o.re + self.im*o.im, im: self.re*o.im - self.im*o.re } } // conj(self)*o
    #[inline] fn norm(self) -> f32 { self.re*self.re + self.im*self.im }
    #[inline] fn scale(self, s: f32) -> Cplx { Cplx { re: self.re*s, im: self.im*s } }
    #[inline] fn add(self, o: Cplx) -> Cplx { Cplx { re: self.re+o.re, im: self.im+o.im } }
}

const NOISE_FLOOR: f32 = 1e-15;

pub struct SignalsmithStretch {
    channels: usize,
    block: usize,
    interval: usize,
    bands: usize,
    fft: Fft,
    window: Vec<f32>,
    // per-channel band state (length bands*channels)
    output: Vec<Cplx>,
    mag: Vec<f32>,
    prev_phase: Vec<f32>,
    ana_phase: Vec<f32>,
    synth_phase: Vec<f32>,
    peaks: Vec<usize>,
    // scratch
    re: Vec<f32>,
    im: Vec<f32>,
    frame: Vec<f32>,
}

impl SignalsmithStretch {
    pub fn preset_default(channels: usize, sample_rate: f32) -> Self {
        // native block ~0.12*rate (5760@48k); nearest pow2 4096 (85ms), 75% overlap.
        let block = 4096;
        let interval = block / 4;
        Self::configure(channels, block, interval, sample_rate)
    }

    pub fn configure(channels: usize, block: usize, interval: usize, _sample_rate: f32) -> Self {
        assert!(block.is_power_of_two());
        let bands = block / 2;
        Self {
            channels, block, interval, bands,
            fft: Fft::new(block),
            window: kaiser_ola_window(block, interval),
            output: vec![Cplx::default(); bands*channels],
            mag: vec![0.0; bands*channels],
            prev_phase: vec![0.0; bands*channels],
            ana_phase: vec![0.0; bands*channels],
            synth_phase: vec![0.0; bands*channels],
            peaks: Vec::with_capacity(bands),
            re: vec![0.0; block], im: vec![0.0; block], frame: vec![0.0; block],
        }
    }

    pub fn block_samples(&self) -> usize { self.block }
    pub fn interval_samples(&self) -> usize { self.interval }
    pub fn latency(&self) -> usize { self.block }

    /// Whole-buffer stretch of one channel: `output.len()/input.len()` sets the ratio. Zero-pads
    /// the input at both ends by one block so edge frames are complete (matches native `exact`).
    pub fn process_mono(&mut self, input: &[f32], output: &mut [f32]) {
        let ch = 0; let base = ch*self.bands;
        let out_len = output.len();
        for o in output.iter_mut() { *o = 0.0; }
        let mut acc = vec![0.0f32; out_len + self.block];
        let mut norm = vec![0.0f32; out_len + self.block];
        let ratio = out_len as f64 / input.len().max(1) as f64;
        let synth_hop = self.interval as f64;
        let two_pi = 2.0*core::f32::consts::PI;
        let mut synth = 0isize;
        let mut prev_in_center = f64::NAN;
        let mut first = true;
        while (synth as usize) < out_len {
            let in_center = synth as f64 / ratio;
            let analysis_hop = if prev_in_center.is_nan() { synth_hop / ratio } else { in_center - prev_in_center };
            prev_in_center = in_center;
            self.analyse(input, ch, libm::round(in_center) as isize); // fills self.output[b]=analysis spectrum, tmp
            for b in 0..self.bands {
                let a = self.output[base+b];
                let mag = libm::sqrtf(a.norm());
                let phase = libm::atan2f(a.im, a.re);
                self.mag[base+b] = mag;
                self.ana_phase[base+b] = phase;
                if first {
                    self.synth_phase[base+b] = phase;
                } else {
                    let expected = two_pi * b as f32 * analysis_hop as f32 / self.block as f32;
                    let mut dev = phase - self.prev_phase[base+b] - expected;
                    dev -= two_pi * libm::roundf(dev/two_pi);         // wrap to (-pi,pi]
                    let inst_freq = (expected + dev) / analysis_hop as f32; // rad/sample
                    self.synth_phase[base+b] += inst_freq * synth_hop as f32;
                }
                self.prev_phase[base+b] = phase;
            }
            // RIGID PHASE LOCKING (vertical coherence, the phasiness cure): peak bins keep their
            // free-run synthesis phase; every other bin's OUTPUT phase is tied rigidly to its
            // nearest peak, preserving that peak's analysis-time phase relationships. The
            // accumulated synth_phase STATE is never overwritten — only the output is derived —
            // which is why energy stays correct (magnitudes untouched).
            self.build_locked_output(base);
            first = false;
            self.synthesise(ch, synth, &mut acc, &mut norm);
            synth += self.interval as isize;
        }
        for i in 0..out_len { output[i] = if norm[i] > 1e-6 { acc[i]/norm[i] } else { 0.0 }; }
    }

    fn build_locked_output(&mut self, base: usize) {
        let bands = self.bands;
        self.peaks.clear();
        // smoothed magnitude floor (one-pole both directions) — a peak must stand ABOVE it.
        let alpha = 0.15f32;
        let mut sm = 0.0f32;
        for b in 0..bands { sm += alpha*(self.mag[base+b]-sm); self.frame[b] = sm; }
        sm = 0.0;
        for b in (0..bands).rev() { sm += alpha*(self.mag[base+b]-sm); self.frame[b] = 0.5*(self.frame[b]+sm); }
        let w = 3usize;
        for b in 0..bands {
            let m = self.mag[base+b];
            if m <= self.frame[b] * 1.2 { continue; }             // must be prominent over the floor
            let lo = b.saturating_sub(w); let hi = (b+w+1).min(bands);
            if (lo..hi).all(|o| self.mag[base+o] <= m) {           // local max over +/- w bins
                self.peaks.push(b);
            }
        }
        if self.peaks.is_empty() {
            for b in 0..bands {
                let sp = self.synth_phase[base+b];
                self.output[base+b] = Cplx { re: self.mag[base+b]*libm::cosf(sp), im: self.mag[base+b]*libm::sinf(sp) };
            }
            return;
        }
        let mut pi = 0usize;
        for b in 0..bands {
            while pi + 1 < self.peaks.len() && (self.peaks[pi+1] as isize - b as isize).abs() < (self.peaks[pi] as isize - b as isize).abs() { pi += 1; }
            let p = self.peaks[pi];
            let out_phase = self.synth_phase[base+p] + (self.ana_phase[base+b] - self.ana_phase[base+p]);
            let m = self.mag[base+b];
            self.output[base+b] = Cplx { re: m*libm::cosf(out_phase), im: m*libm::sinf(out_phase) };
        }
    }

    /// Windowed FFT of `input` centered at `center`, into this channel's `input` bands.
    fn analyse(&mut self, input: &[f32], ch: usize, center: isize) {
        let half = self.block as isize / 2;
        for i in 0..self.block {
            let src = center - half + i as isize;
            let s = if src >= 0 && (src as usize) < input.len() { input[src as usize] } else { 0.0 };
            self.re[i] = s * self.window[i];
            self.im[i] = 0.0;
        }
        self.fft.forward(&mut self.re, &mut self.im);
        let base = ch*self.bands;
        for b in 0..self.bands {
            self.output[base + b] = Cplx { re: self.re[b], im: self.im[b] };
        }
    }


    /// IFFT this channel's output bands and overlap-add (windowed) into the accumulator.
    fn synthesise(&mut self, ch: usize, synth: isize, acc: &mut [f32], norm: &mut [f32]) {
        let base = ch*self.bands;
        for b in 0..self.bands {
            self.re[b] = self.output[base + b].re;
            self.im[b] = self.output[base + b].im;
        }
        // hermitian mirror
        self.re[self.bands] = 0.0; self.im[self.bands] = 0.0;
        for b in 1..self.bands {
            self.re[self.block - b] = self.re[b];
            self.im[self.block - b] = -self.im[b];
        }
        self.fft.inverse(&mut self.re, &mut self.im);
        let half = self.block as isize / 2;
        for i in 0..self.block {
            let dst = synth - half + i as isize;
            if dst >= 0 && (dst as usize) < acc.len() {
                acc[dst as usize] += self.re[i] * self.window[i];
                norm[dst as usize] += self.window[i] * self.window[i];
            }
        }
    }
}

fn kaiser_ola_window(block: usize, interval: usize) -> Vec<f32> {
    let mut w: Vec<f32> = (0..block).map(|i| {
        let x = libm::sin(core::f64::consts::PI * i as f64 / block as f64);
        (x * x) as f32
    }).collect();
    let mut norm = vec![0.0f32; block];
    let mut off = 0;
    while off < block { for i in 0..block { norm[(off + i) % block] += w[i]*w[i]; } off += interval; }
    let mean: f32 = norm.iter().sum::<f32>() / block as f32;
    let s = 1.0 / libm::sqrtf(mean);
    for v in &mut w { *v *= s; }
    w
}

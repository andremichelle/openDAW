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
    freq_multiplier: f32,
    // streaming (zero-alloc) state: fixed OLA output ring + reserved locking scratch
    out_ring: Vec<f32>,
    norm_ring: Vec<f32>,
    stream_synth: f64,   // next synthesis frame position (output samples)
    stream_emit: usize,  // next output sample to emit
    stream_src: f64,     // source read position (samples) for the next frame
    stream_started: bool,
    // STEREO-COUPLED state (shared phase across L/R preserves the stereo image). Separate from the
    // mono fields so the oracle/mono path is untouched.
    in_l: Vec<Cplx>, in_r: Vec<Cplx>,
    mag_l: Vec<f32>, mag_r: Vec<f32>,
    ana_l: Vec<f32>, ana_r: Vec<f32>,
    prev_l: Vec<f32>, prev_r: Vec<f32>,   // per-channel prev analysis phase (for instantaneous freq)
    sphase: Vec<f32>,        // SHARED accumulated synthesis phase per band
    peaks_s: Vec<usize>,
    ring_l: Vec<f32>, ring_r: Vec<f32>, ring_n: Vec<f32>,
    s2_synth: f64, s2_emit: usize, s2_src: f64, s2_started: bool,
    cycle_id: f64,           // engine bookkeeping: the loop cycle's raw_start; NaN = uninitialised
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
            freq_multiplier: 1.0,
            out_ring: vec![0.0; block], norm_ring: vec![0.0; block],
            stream_synth: 0.0, stream_emit: 0, stream_src: 0.0, stream_started: false,
            in_l: vec![Cplx::default(); bands], in_r: vec![Cplx::default(); bands],
            mag_l: vec![0.0; bands], mag_r: vec![0.0; bands],
            ana_l: vec![0.0; bands], ana_r: vec![0.0; bands],
            prev_l: vec![0.0; bands], prev_r: vec![0.0; bands], sphase: vec![0.0; bands], peaks_s: Vec::with_capacity(bands),
            ring_l: vec![0.0; block], ring_r: vec![0.0; block], ring_n: vec![0.0; block],
            s2_synth: 0.0, s2_emit: 0, s2_src: 0.0, s2_started: false, cycle_id: f64::NAN,
        }
    }

    /// Independent pitch shift in semitones (spectral remap, no resampling). 0 = time-stretch only.
    pub fn set_transpose_semitones(&mut self, semitones: f32) {
        self.freq_multiplier = libm::powf(2.0, semitones / 12.0);
    }

    pub fn block_samples(&self) -> usize { self.block }
    pub fn interval_samples(&self) -> usize { self.interval }

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
            let r = self.freq_multiplier;
            for b in 0..self.bands {
                let src = b as f32 / r;
                let a = if r == 1.0 { self.output[base+b] } else { self.interp_spectrum(base, src) };
                let mag = libm::sqrtf(a.norm());
                let phase = libm::atan2f(a.im, a.re);
                self.mag[base+b] = mag;
                self.ana_phase[base+b] = phase;
                if first {
                    self.synth_phase[base+b] = phase;
                } else {
                    let expected = two_pi * src * analysis_hop as f32 / self.block as f32;
                    let mut dev = phase - self.prev_phase[base+b] - expected;
                    dev -= two_pi * libm::roundf(dev/two_pi);
                    let inst_freq_in = (expected + dev) / analysis_hop as f32;
                    self.synth_phase[base+b] += inst_freq_in * r * synth_hop as f32;
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

    fn interp_spectrum(&self, base: usize, idx: f32) -> Cplx {
        if idx < 0.0 || idx >= (self.bands - 1) as f32 { return Cplx::default(); }
        let lo = idx as usize; let f = idx - lo as f32;
        let a = self.output[base+lo]; let b = self.output[base+lo+1];
        Cplx { re: a.re + (b.re-a.re)*f, im: a.im + (b.im-a.im)*f }
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

    /// Reset streaming state; call at a discontinuity (loop wrap, region start, transport jump).
    /// `source_pos` is where in the source the first output frame should read from.
    pub fn reset_stream(&mut self, source_pos: f64) {
        for v in self.out_ring.iter_mut() { *v = 0.0; }
        for v in self.norm_ring.iter_mut() { *v = 0.0; }
        for b in 0..self.bands { self.prev_phase[b]=0.0; self.ana_phase[b]=0.0; self.synth_phase[b]=0.0; }
        self.stream_synth = 0.0; self.stream_emit = 0; self.stream_src = source_pos; self.stream_started = false;
        for v in self.ring_l.iter_mut() { *v = 0.0; } for v in self.ring_r.iter_mut() { *v = 0.0; } for v in self.ring_n.iter_mut() { *v = 0.0; }
        for b in 0..self.bands { self.prev_l[b]=0.0; self.prev_r[b]=0.0; self.sphase[b]=0.0; }
        self.s2_synth = 0.0; self.s2_emit = 0; self.s2_src = source_pos; self.s2_started = false;
    }

    /// The processor's inherent output latency in samples (feed the source this far ahead).
    pub fn latency(&self) -> usize { self.block / 2 }

    /// Engine bookkeeping for loop-wrap detection: the raw_start of the loop cycle this stream is currently
    /// following. `NaN` until the first cycle is set. The caller re-primes (`reset_stream`) when it changes.
    pub fn cycle_id(&self) -> f64 { self.cycle_id }
    pub fn set_cycle_id(&mut self, id: f64) { self.cycle_id = id }

    /// STREAMING, ZERO-ALLOC: fill `output` with the next stretched samples, reading the resident
    /// `source` directly. `time_factor` = output/input rate (the local warp slope); may change per
    /// call (variable tempo). `pitch` = frequency multiplier. No heap allocation on this path.
    pub fn process_stream(&mut self, source: &[f32], output: &mut [f32], time_factor: f64, pitch: f32) {
        let base = 0usize;
        let block = self.block; let interval = self.interval as f64;
        let half = (block / 2) as f64;
        let two_pi = 2.0*core::f32::consts::PI;
        self.freq_multiplier = pitch;
        let r = pitch;
        for out_i in 0..output.len() {
            let emit = self.stream_emit;
            // run synthesis frames until every frame covering `emit` is done (centered windows -> +half)
            while self.stream_synth <= emit as f64 + half {
                let in_center = self.stream_src;
                let analysis_hop = interval / time_factor.max(1e-6);
                self.analyse(source, 0, libm::round(in_center) as isize);
                for b in 0..self.bands {
                    let src = b as f32 / r;
                    let a = if r == 1.0 { self.output[base+b] } else { self.interp_spectrum(base, src) };
                    let mag = libm::sqrtf(a.norm());
                    let phase = libm::atan2f(a.im, a.re);
                    self.mag[base+b] = mag; self.ana_phase[base+b] = phase;
                    if !self.stream_started {
                        self.synth_phase[base+b] = phase;
                    } else {
                        let expected = two_pi * src * analysis_hop as f32 / block as f32;
                        let mut dev = phase - self.prev_phase[base+b] - expected;
                        dev -= two_pi * libm::roundf(dev/two_pi);
                        let inst = (expected + dev) / analysis_hop as f32;
                        self.synth_phase[base+b] += inst * r * interval as f32;
                    }
                    self.prev_phase[base+b] = phase;
                }
                self.stream_started = true;
                self.build_locked_output(base);
                // IFFT + OLA the centered window into the ring at [synth-half, synth+half)
                for b in 0..self.bands { self.re[b]=self.output[base+b].re; self.im[b]=self.output[base+b].im; }
                self.re[self.bands]=0.0; self.im[self.bands]=0.0;
                for b in 1..self.bands { self.re[block-b]=self.re[b]; self.im[block-b]=-self.im[b]; }
                self.fft.inverse(&mut self.re, &mut self.im);
                let start = self.stream_synth - half;
                for i in 0..block {
                    let pos = start + i as f64;
                    if pos >= 0.0 {
                        let idx = (pos as usize) % block;
                        self.out_ring[idx] += self.re[i]*self.window[i];
                        self.norm_ring[idx] += self.window[i]*self.window[i];
                    }
                }
                self.stream_synth += interval;
                self.stream_src += analysis_hop;
            }
            let idx = emit % block;
            output[out_i] = if self.norm_ring[idx] > 1e-6 { self.out_ring[idx]/self.norm_ring[idx] } else { 0.0 };
            self.out_ring[idx] = 0.0; self.norm_ring[idx] = 0.0;
            self.stream_emit += 1;
        }
    }

    /// STREAMING, ZERO-ALLOC, STEREO-COUPLED. Both channels are stretched by ONE processor that
    /// shares a single synthesis-phase accumulator and a single peak map, so the inter-channel
    /// phase relationship (the stereo image) is preserved instead of two mono vocoders drifting
    /// apart. Per band the higher-energy channel drives the horizontal phase advance and the peak
    /// lock; the other channel is rigidly offset by its *analysis-time* phase difference, so the
    /// output L/R phase difference equals the input's at every band.
    pub fn process_stream_stereo(&mut self, left: &[f32], right: &[f32],
                                 out_l: &mut [f32], out_r: &mut [f32],
                                 time_factor: f64, pitch: f32) {
        let block = self.block; let interval = self.interval as f64;
        let half = (block / 2) as f64;
        let two_pi = 2.0*core::f32::consts::PI;
        self.freq_multiplier = pitch;
        let r = pitch;
        for out_i in 0..out_l.len() {
            let emit = self.s2_emit;
            while self.s2_synth <= emit as f64 + half {
                let analysis_hop = interval / time_factor.max(1e-6);
                let center = libm::round(self.s2_src) as isize;
                self.analyse(left, 0, center);
                for b in 0..self.bands { self.in_l[b] = if r == 1.0 { self.output[b] } else { self.interp_spectrum(0, b as f32 / r) }; }
                self.analyse(right, 0, center);
                for b in 0..self.bands { self.in_r[b] = if r == 1.0 { self.output[b] } else { self.interp_spectrum(0, b as f32 / r) }; }
                for b in 0..self.bands {
                    let al = self.in_l[b]; let ar = self.in_r[b];
                    let ml = libm::sqrtf(al.norm()); let mr = libm::sqrtf(ar.norm());
                    let pl = libm::atan2f(al.im, al.re); let pr = libm::atan2f(ar.im, ar.re);
                    self.mag_l[b]=ml; self.mag_r[b]=mr; self.ana_l[b]=pl; self.ana_r[b]=pr;
                    let src = b as f32 / r;
                    if !self.s2_started {
                        self.sphase[b] = if ml >= mr { pl } else { pr };
                    } else {
                        let (ref_phase, ref_prev) = if ml >= mr { (pl, self.prev_l[b]) } else { (pr, self.prev_r[b]) };
                        let expected = two_pi * src * analysis_hop as f32 / block as f32;
                        let mut dev = ref_phase - ref_prev - expected;
                        dev -= two_pi * libm::roundf(dev/two_pi);
                        let inst = (expected + dev) / analysis_hop as f32;
                        self.sphase[b] += inst * r * interval as f32;
                    }
                    self.prev_l[b]=pl; self.prev_r[b]=pr;
                }
                self.s2_started = true;
                self.build_locked_output_stereo();
                let start = self.s2_synth - half;
                for b in 0..self.bands { self.re[b]=self.in_l[b].re; self.im[b]=self.in_l[b].im; }
                self.re[self.bands]=0.0; self.im[self.bands]=0.0;
                for b in 1..self.bands { self.re[block-b]=self.re[b]; self.im[block-b]=-self.im[b]; }
                self.fft.inverse(&mut self.re, &mut self.im);
                for i in 0..block {
                    let pos = start + i as f64;
                    if pos >= 0.0 { let idx=(pos as usize)%block; self.ring_l[idx]+=self.re[i]*self.window[i]; self.ring_n[idx]+=self.window[i]*self.window[i]; }
                }
                for b in 0..self.bands { self.re[b]=self.in_r[b].re; self.im[b]=self.in_r[b].im; }
                self.re[self.bands]=0.0; self.im[self.bands]=0.0;
                for b in 1..self.bands { self.re[block-b]=self.re[b]; self.im[block-b]=-self.im[b]; }
                self.fft.inverse(&mut self.re, &mut self.im);
                for i in 0..block {
                    let pos = start + i as f64;
                    if pos >= 0.0 { let idx=(pos as usize)%block; self.ring_r[idx]+=self.re[i]*self.window[i]; }
                }
                self.s2_synth += interval;
                self.s2_src += analysis_hop;
            }
            let idx = emit % block;
            let nrm = self.ring_n[idx];
            out_l[out_i] = if nrm > 1e-6 { self.ring_l[idx]/nrm } else { 0.0 };
            out_r[out_i] = if nrm > 1e-6 { self.ring_r[idx]/nrm } else { 0.0 };
            self.ring_l[idx]=0.0; self.ring_r[idx]=0.0; self.ring_n[idx]=0.0;
            self.s2_emit += 1;
        }
    }

    /// Vertical rigid locking on the COMBINED (L+R) magnitude with the higher-energy channel as the
    /// phase reference. Writes each channel's final output bins back into `in_l`/`in_r`. The output
    /// L/R phase difference equals the analysis-time difference, preserving the stereo image.
    fn build_locked_output_stereo(&mut self) {
        let bands = self.bands;
        for b in 0..bands { self.ana_phase[b] = if self.mag_l[b] >= self.mag_r[b] { self.ana_l[b] } else { self.ana_r[b] }; }
        self.peaks_s.clear();
        let alpha = 0.15f32; let mut sm = 0.0f32;
        for b in 0..bands { let cm=self.mag_l[b]+self.mag_r[b]; sm += alpha*(cm-sm); self.frame[b]=sm; }
        sm = 0.0;
        for b in (0..bands).rev() { let cm=self.mag_l[b]+self.mag_r[b]; sm += alpha*(cm-sm); self.frame[b]=0.5*(self.frame[b]+sm); }
        let w=3usize;
        for b in 0..bands {
            let cm=self.mag_l[b]+self.mag_r[b];
            if cm <= self.frame[b]*1.2 { continue; }
            let lo=b.saturating_sub(w); let hi=(b+w+1).min(bands);
            if (lo..hi).all(|other| self.mag_l[other]+self.mag_r[other] <= cm) { self.peaks_s.push(b); }
        }
        if self.peaks_s.is_empty() {
            for b in 0..bands {
                let rp = self.ana_phase[b];
                let lp = self.sphase[b] + (self.ana_l[b]-rp); let rpp = self.sphase[b] + (self.ana_r[b]-rp);
                self.in_l[b] = Cplx{re:self.mag_l[b]*libm::cosf(lp), im:self.mag_l[b]*libm::sinf(lp)};
                self.in_r[b] = Cplx{re:self.mag_r[b]*libm::cosf(rpp), im:self.mag_r[b]*libm::sinf(rpp)};
            }
            return;
        }
        let mut pi=0usize;
        for b in 0..bands {
            while pi+1 < self.peaks_s.len() && (self.peaks_s[pi+1] as isize - b as isize).abs() < (self.peaks_s[pi] as isize - b as isize).abs() { pi+=1; }
            let p=self.peaks_s[pi];
            let base_phase = self.sphase[p] - self.ana_phase[p];
            let lp = base_phase + self.ana_l[b]; let rp = base_phase + self.ana_r[b];
            self.in_l[b] = Cplx{re:self.mag_l[b]*libm::cosf(lp), im:self.mag_l[b]*libm::sinf(lp)};
            self.in_r[b] = Cplx{re:self.mag_r[b]*libm::cosf(rp), im:self.mag_r[b]*libm::sinf(rp)};
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

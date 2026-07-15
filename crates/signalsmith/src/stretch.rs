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
use crate::approx;

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

/// Snapshot of the persistent streaming state right after a loop-start prime, at `s2_emit == 0`. A loop wrap
/// re-primes to the SAME `source_pos` from the SAME zeroed state, so (for constant tempo/pitch) the primed
/// state is identical every iteration: capture it once, then restore it with a memcpy at each wrap instead of
/// recomputing the multi-frame priming burst. `params`/`source_pos` gate the cache — anything the priming
/// depends on differing (e.g. tempo/pitch automation) invalidates it and falls back to a real reset+prime.
struct PrimedCache {
    valid: bool,
    ring_l: Vec<f32>, ring_r: Vec<f32>, ring_n: Vec<f32>,
    prev_l: Vec<f32>, prev_r: Vec<f32>, sphase: Vec<f32>, sphase_r: Vec<f32>,
    s2_synth: f64, s2_src: f64, s2_emit: usize, s2_started: bool,
    time_factor: f64, pitch: f32, resample: f64, source_pos: f64,
}

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
    sphase: Vec<f32>, sphase_r: Vec<f32>, // PER-CHANNEL accumulated synthesis phase (L, R) — each evolves on its
                                          // own instantaneous freq; cross-channel locking happens only at output
    peaks_s: Vec<usize>,
    ring_l: Vec<f32>, ring_r: Vec<f32>, ring_n: Vec<f32>,
    s2_synth: f64, s2_emit: usize, s2_src: f64, s2_started: bool,
    cycle_id: f64,           // engine bookkeeping: the loop cycle's raw_start; NaN = uninitialised
    // Per-voice synthesis-frame phase, in output samples [0, interval). Each voice runs one heavy FFT frame
    // every `interval` samples; phase-locked voices burst in the SAME render quantum (peak = N frames).
    // Seeding the synth accumulator with a distinct offset per voice spreads the bursts across quanta at the
    // cost of a fixed `phase_offset`-sample output latency on that voice (a few ms; inaudible for independent
    // material). Applied at `reset_stream`, so it is stable across loop-wraps.
    phase_offset: usize,
    // Loop-wrap fast path: a snapshot of the primed state (see `PrimedCache`) plus a flag armed at reset that
    // tells `process_stream_stereo` to capture the snapshot once, right after the emit==0 priming.
    cache: PrimedCache,
    capture_pending: bool,
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
            prev_l: vec![0.0; bands], prev_r: vec![0.0; bands], sphase: vec![0.0; bands], sphase_r: vec![0.0; bands], peaks_s: Vec::with_capacity(bands),
            ring_l: vec![0.0; block], ring_r: vec![0.0; block], ring_n: vec![0.0; block],
            s2_synth: 0.0, s2_emit: 0, s2_src: 0.0, s2_started: false, cycle_id: f64::NAN,
            phase_offset: 0,
            cache: PrimedCache {
                valid: false,
                ring_l: vec![0.0; block], ring_r: vec![0.0; block], ring_n: vec![0.0; block],
                prev_l: vec![0.0; bands], prev_r: vec![0.0; bands], sphase: vec![0.0; bands], sphase_r: vec![0.0; bands],
                s2_synth: 0.0, s2_src: 0.0, s2_emit: 0, s2_started: false,
                time_factor: 0.0, pitch: 0.0, resample: 0.0, source_pos: f64::NAN,
            },
            capture_pending: false,
        }
    }

    /// Stagger this voice's synthesis-frame phase by `samples` output samples ([0, interval)). Voices with
    /// distinct offsets run their FFT bursts in different render quanta instead of colliding. Costs a fixed
    /// `samples`-sample output latency on this voice; takes effect at the next `reset_stream`.
    pub fn set_phase_offset(&mut self, samples: usize) {
        self.phase_offset = samples % self.interval.max(1);
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
        self.stream_synth = self.phase_offset as f64; self.stream_emit = 0; self.stream_src = source_pos; self.stream_started = false;
        for v in self.ring_l.iter_mut() { *v = 0.0; } for v in self.ring_r.iter_mut() { *v = 0.0; } for v in self.ring_n.iter_mut() { *v = 0.0; }
        for b in 0..self.bands { self.prev_l[b]=0.0; self.prev_r[b]=0.0; self.sphase[b]=0.0; self.sphase_r[b]=0.0; }
        self.s2_synth = self.phase_offset as f64; self.s2_emit = 0; self.s2_src = source_pos; self.s2_started = false;
        self.capture_pending = false;
    }

    /// Arm a one-shot capture of the primed state after the next `emit == 0` prime, tagging it with the params
    /// and position it is valid for. Call right after `reset_stream` when priming at a loop-startable position;
    /// `process_stream_stereo` then snapshots the state once the priming frames have run.
    pub fn arm_capture(&mut self, time_factor: f64, pitch: f32, resample: f64, source_pos: f64) {
        self.capture_pending = true;
        self.cache.valid = false;
        self.cache.time_factor = time_factor; self.cache.pitch = pitch;
        self.cache.resample = resample; self.cache.source_pos = source_pos;
    }

    /// Loop-wrap fast path: restore the primed snapshot instead of re-priming, IF one was captured for these
    /// exact params/position. Returns true on a hit (no priming burst); false means the caller must reset+prime.
    pub fn try_restore(&mut self, time_factor: f64, pitch: f32, resample: f64, source_pos: f64) -> bool {
        let cache = &self.cache;
        if !cache.valid || cache.time_factor != time_factor || cache.pitch != pitch
            || cache.resample != resample || cache.source_pos != source_pos {
            return false;
        }
        self.ring_l.copy_from_slice(&self.cache.ring_l);
        self.ring_r.copy_from_slice(&self.cache.ring_r);
        self.ring_n.copy_from_slice(&self.cache.ring_n);
        self.prev_l.copy_from_slice(&self.cache.prev_l);
        self.prev_r.copy_from_slice(&self.cache.prev_r);
        self.sphase.copy_from_slice(&self.cache.sphase);
        self.sphase_r.copy_from_slice(&self.cache.sphase_r);
        self.s2_synth = self.cache.s2_synth; self.s2_src = self.cache.s2_src;
        self.s2_emit = self.cache.s2_emit; self.s2_started = self.cache.s2_started;
        self.capture_pending = false;
        true
    }

    fn capture_primed(&mut self) {
        self.cache.ring_l.copy_from_slice(&self.ring_l);
        self.cache.ring_r.copy_from_slice(&self.ring_r);
        self.cache.ring_n.copy_from_slice(&self.ring_n);
        self.cache.prev_l.copy_from_slice(&self.prev_l);
        self.cache.prev_r.copy_from_slice(&self.prev_r);
        self.cache.sphase.copy_from_slice(&self.sphase);
        self.cache.sphase_r.copy_from_slice(&self.sphase_r);
        self.cache.s2_synth = self.s2_synth; self.cache.s2_src = self.s2_src;
        self.cache.s2_emit = self.s2_emit; self.cache.s2_started = self.s2_started;
        self.cache.valid = true;
        self.capture_pending = false;
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
                                 time_factor: f64, pitch: f32, resample: f64) {
        let block = self.block; let interval = self.interval as f64;
        let half = (block / 2) as f64;
        let two_pi = 2.0*core::f32::consts::PI;
        for out_i in 0..out_l.len() {
            let emit = self.s2_emit;
            while self.s2_synth <= emit as f64 + half {
                let analysis_hop = interval / time_factor.max(1e-6);
                let center = libm::round(self.s2_src) as isize;
                // ONE complex FFT for BOTH channels: pack left into the real part and right into the imaginary
                // part of the windowed frame, transform once, then unpack the two real-input spectra (the
                // classic two-reals-for-one-FFT trick) — halves the analysis FFT cost.
                // PITCH is done here, in the TIME domain: the window CENTRE advances at the native rate (so
                // duration/tempo is unchanged) but each window sample steps by `resample * pitch` — a wider read
                // compresses the content, raising pitch. No spectral bin interpolation (which smears complex
                // phases), so a 1-cent shift barely widens the window and stays clean. pitch 1.0 == native read.
                let half_b = block as f64 / 2.0;
                let center_src = center as f64 * resample;
                let step = resample * pitch as f64;
                for i in 0..block {
                    let pos = center_src + (i as f64 - half_b) * step;
                    self.re[i] = resample_read(left, pos) * self.window[i];
                    self.im[i] = resample_read(right, pos) * self.window[i];
                }
                self.fft.forward(&mut self.re, &mut self.im);
                for b in 0..self.bands {
                    let nb = if b == 0 { 0 } else { block - b };
                    self.in_l[b] = Cplx { re: (self.re[b] + self.re[nb]) * 0.5, im: (self.im[b] - self.im[nb]) * 0.5 };
                }
                for b in 0..self.bands {
                    let nb = if b == 0 { 0 } else { block - b };
                    self.in_r[b] = Cplx { re: (self.im[b] + self.im[nb]) * 0.5, im: (self.re[nb] - self.re[b]) * 0.5 };
                }
                for b in 0..self.bands {
                    let al = self.in_l[b]; let ar = self.in_r[b];
                    let ml = approx::sqrt(al.norm()); let mr = approx::sqrt(ar.norm());
                    let pl = approx::atan2(al.im, al.re); let pr = approx::atan2(ar.im, ar.re);
                    self.mag_l[b]=ml; self.mag_r[b]=mr; self.ana_l[b]=pl; self.ana_r[b]=pr;
                    if !self.s2_started {
                        self.sphase[b] = pl; self.sphase_r[b] = pr;
                    } else {
                        // The time-domain window read raises pitch by `pitch`, so window bin b carries the
                        // content of source bin b/pitch: its frame-to-frame phase evolves at the SOURCE rate
                        // (hence expected uses b/pitch), and the output must advance `pitch` faster. sphase is
                        // wrapped to [-pi,pi] so the phase polynomials never see a large (imprecise) argument.
                        let src = b as f32 / pitch;
                        let expected = two_pi * src * analysis_hop as f32 / block as f32;
                        let mut dl = pl - self.prev_l[b] - expected; dl -= two_pi * approx::round_f32(dl/two_pi);
                        self.sphase[b] = approx::wrap_pi(self.sphase[b] + (expected + dl) / analysis_hop as f32 * pitch * interval as f32);
                        let mut dr = pr - self.prev_r[b] - expected; dr -= two_pi * approx::round_f32(dr/two_pi);
                        self.sphase_r[b] = approx::wrap_pi(self.sphase_r[b] + (expected + dr) / analysis_hop as f32 * pitch * interval as f32);
                    }
                    self.prev_l[b]=pl; self.prev_r[b]=pr;
                }
                self.s2_started = true;
                self.build_locked_output_stereo();
                let start = self.s2_synth - half;
                // ONE inverse FFT for BOTH channels: pack the output spectra as Z = left + j*right; the IFFT of
                // the full hermitian Z yields Re = left time-signal, Im = right (the inverse of the trick above).
                for b in 0..self.bands {
                    self.re[b] = self.in_l[b].re - self.in_r[b].im;
                    self.im[b] = self.in_l[b].im + self.in_r[b].re;
                }
                for b in 1..self.bands - 1 {
                    self.re[block - b] = self.in_l[b].re + self.in_r[b].im;
                    self.im[block - b] = self.in_r[b].re - self.in_l[b].im;
                }
                self.fft.inverse(&mut self.re, &mut self.im);
                for i in 0..block {
                    let pos = start + i as f64;
                    if pos >= 0.0 {
                        let idx = (pos as usize) % block;
                        self.ring_l[idx] += self.re[i] * self.window[i];
                        self.ring_r[idx] += self.im[i] * self.window[i];
                        self.ring_n[idx] += self.window[i] * self.window[i];
                    }
                }
                self.s2_synth += interval;
                self.s2_src += analysis_hop;
            }
            // The priming frames for this reset have all run; snapshot the primed state so future loop wraps to
            // the same position restore it instead of re-priming. Only at emit==0 (the block right after a reset).
            if self.capture_pending && emit == 0 {
                self.capture_primed();
            }
            let idx = emit % block;
            let nrm = self.ring_n[idx];
            out_l[out_i] = if nrm > 1e-6 { self.ring_l[idx]/nrm } else { 0.0 };
            out_r[out_i] = if nrm > 1e-6 { self.ring_r[idx]/nrm } else { 0.0 };
            self.ring_l[idx]=0.0; self.ring_r[idx]=0.0; self.ring_n[idx]=0.0;
            self.s2_emit += 1;
        }
    }

    /// Vertical rigid locking on the COMBINED (L+R) magnitude. Each bin is voiced from its DOMINANT channel's
    /// own accumulated phase (locked to the nearest peak); the other channel is offset by the analysis-time
    /// inter-channel phase difference. This preserves the stereo image AND — because each channel's accumulator
    /// tracks its own analysis phase — reconstructs the input exactly at unity (no phase scrambling on
    /// transients). Writes each channel's final output bins back into `in_l`/`in_r`.
    fn build_locked_output_stereo(&mut self) {
        let bands = self.bands;
        self.peaks_s.clear();
        let alpha = 0.15f32; let mut sm = 0.0f32; let mut max_cm = 0.0f32;
        for b in 0..bands { let cm=self.mag_l[b]+self.mag_r[b]; if cm > max_cm { max_cm = cm; } sm += alpha*(cm-sm); self.frame[b]=sm; }
        // Below this the bin is inaudible, so its output is ~0 regardless of phase — skip the cos/sin (the hot
        // transcendentals). Relative + tiny, so it only ever drops true silence (most bins in typical spectra).
        let gate = max_cm * 1e-4;
        sm = 0.0;
        for b in (0..bands).rev() { let cm=self.mag_l[b]+self.mag_r[b]; sm += alpha*(cm-sm); self.frame[b]=0.5*(self.frame[b]+sm); }
        let w=3usize;
        for b in 0..bands {
            let cm=self.mag_l[b]+self.mag_r[b];
            if cm <= self.frame[b]*1.2 { continue; }
            let lo=b.saturating_sub(w); let hi=(b+w+1).min(bands);
            if (lo..hi).all(|other| self.mag_l[other]+self.mag_r[other] <= cm) { self.peaks_s.push(b); }
        }
        let has_peaks = !self.peaks_s.is_empty();
        let mut pi=0usize;
        for b in 0..bands {
            // p = the peak this bin locks to (itself when there are no peaks -> free-run, i.e. identity).
            let p = if has_peaks {
                while pi+1 < self.peaks_s.len() && (self.peaks_s[pi+1] as isize - b as isize).abs() < (self.peaks_s[pi] as isize - b as isize).abs() { pi+=1; }
                self.peaks_s[pi]
            } else { b };
            if self.mag_l[b] + self.mag_r[b] <= gate {
                self.in_l[b] = Cplx::default(); self.in_r[b] = Cplx::default();
                continue;
            }
            let dom_left = self.mag_l[b] >= self.mag_r[b];
            let (sphase_dom_p, ana_dom_p, ana_dom_b, ana_oth_b) = if dom_left {
                (self.sphase[p], self.ana_l[p], self.ana_l[b], self.ana_r[b])
            } else {
                (self.sphase_r[p], self.ana_r[p], self.ana_r[b], self.ana_l[b])
            };
            let out_dom = sphase_dom_p + (ana_dom_b - ana_dom_p);   // dominant channel: locked to its peak
            let out_oth = out_dom + (ana_oth_b - ana_dom_b);        // other channel: keep the input L/R phase diff
            let (lp, rp) = if dom_left { (out_dom, out_oth) } else { (out_oth, out_dom) };
            let (sl, cl) = approx::sin_cos(lp);
            let (sr, cr) = approx::sin_cos(rp);
            self.in_l[b] = Cplx{re:self.mag_l[b]*cl, im:self.mag_l[b]*sl};
            self.in_r[b] = Cplx{re:self.mag_r[b]*cr, im:self.mag_r[b]*sr};
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

/// Linearly-interpolated read of `input` at fractional sample `pos` (out of range -> 0). `pos = engine_index *
/// resample` converts the engine-rate window to the source rate, so the phase vocoder runs at the engine rate
/// and the sample-rate conversion never touches the spectral pitch.
#[inline]
fn resample_read(input: &[f32], pos: f64) -> f32 {
    if pos < 0.0 { return 0.0; }
    let i0 = pos as usize;
    let f = (pos - i0 as f64) as f32;
    let n = input.len();
    if i0 + 1 < n { input[i0] * (1.0 - f) + input[i0 + 1] * f } else if i0 < n { input[i0] } else { 0.0 }
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

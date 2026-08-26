//! Zero-latency non-uniform partitioned convolution (Gardner scheme) for the Convolver device.
//!
//! Three cascaded stages, all ALLOCATION-FREE (state built IN PLACE in an engine-allocated zeroed
//! block, the analyser/soundfont pattern):
//!  - head, taps 0..128: direct time-domain FIR (zero latency)
//!  - partitioned FFT levels: each `Level` runs uniform partitioned convolution (overlap-save,
//!    frequency-domain delay line) for one partition size. An EAGER level (b = 128) does
//!    FFT + MAC + IFFT at every 128 boundary; a SLACK level (start delay = 2b) pipelines the work
//!    across its period (FFT at step 0, MAC spread over the middle steps, IFFT at the last step),
//!    so big partitions never spike a single render quantum.
//!
//! Spectra are SPLIT re/im (the complex MAC — the dominant cost — autovectorizes to SIMD128 with
//! no shuffles). The IR transform is TIME-DISTRIBUTED via `load_step` (a few partitions per
//! quantum); head partitions become audible first, the tail fades in over a few dozen ms.

use crate::rfft::FftTables;

pub const BLOCK: usize = 128;
const HEAD: usize = 128;

/// One uniform partitioned-convolution level. `FFT` = 2b, `BINS` >= b + 1 (padded to a multiple of
/// 4 for SIMD), `TABLE` >= b + 1, `SPEC` >= 2 * max_parts * BINS (channel-major flat spectra).
pub struct Level<const FFT: usize, const BINS: usize, const TABLE: usize, const SPEC: usize> {
    tables: FftTables<TABLE>,
    ir_re: [f32; SPEC],
    ir_im: [f32; SPEC],
    fdl_re: [f32; SPEC],
    fdl_im: [f32; SPEC],
    acc_re: [[f32; BINS]; 2],
    acc_im: [[f32; BINS]; 2],
    staging: [[f32; FFT]; 2],
    b: usize,
    d0: usize,
    parts: usize,
    ready: usize,
    steps: usize,
    slot: usize,
    mac_cursor: usize,
    eager: bool
}

impl<const FFT: usize, const BINS: usize, const TABLE: usize, const SPEC: usize> Level<FFT, BINS, TABLE, SPEC> {
    /// Build IN PLACE for partition size `b` starting at IR delay `d0`.
    pub fn init(&mut self, b: usize, d0: usize, eager: bool) {
        assert!(FFT == 2 * b && BINS >= b + 1 && BINS % 4 == 0 && TABLE >= b + 1 && b % BLOCK == 0);
        assert!(if eager { b == BLOCK && d0 == b } else { d0 == 2 * b });
        self.tables.init(FFT);
        self.b = b;
        self.d0 = d0;
        self.steps = b / BLOCK;
        self.eager = eager;
        self.parts = 0;
        self.ready = 0;
        self.clear_runtime();
    }

    pub fn max_parts(&self) -> usize {
        SPEC / (2 * BINS)
    }

    pub fn parts(&self) -> usize {
        self.parts
    }

    pub fn partition_size(&self) -> usize {
        self.b
    }

    fn bins(&self) -> usize {
        self.b + 1
    }

    /// Configure for a new IR of `frames` total frames; partitions cover `d0 ..` in `b` chunks.
    /// A loaded level keeps its input history and old spectra (repacked on a partition-count change)
    /// so the tail keeps sounding while `load_partition` replaces the IR; only an EMPTY level clears.
    pub fn begin_ir(&mut self, frames: usize) {
        let span = frames.saturating_sub(self.d0);
        let parts = span.div_ceil(self.b).min(self.max_parts());
        if parts == 0 || self.parts == 0 {
            self.parts = parts;
            self.ready = 0;
            self.clear_runtime();
            return;
        }
        if parts != self.parts {
            self.repack(parts);
        }
        self.parts = parts;
        self.ready = parts;
    }

    // FDL ring rotated to age order (slot 0 = newest), channel 1 moved to its new base, grown slots zeroed.
    fn repack(&mut self, parts: usize) {
        let old = self.parts;
        let keep = old.min(parts) * BINS;
        for channel in 0..2 {
            let base = channel * old * BINS;
            self.fdl_re[base..base + old * BINS].rotate_left(self.slot * BINS);
            self.fdl_im[base..base + old * BINS].rotate_left(self.slot * BINS);
        }
        self.slot = 0;
        for buffer in [&mut self.fdl_re, &mut self.fdl_im, &mut self.ir_re, &mut self.ir_im] {
            buffer.copy_within(old * BINS..old * BINS + keep, parts * BINS);
            if parts > old {
                buffer[old * BINS..parts * BINS].fill(0.0);
                buffer[parts * BINS + old * BINS..2 * parts * BINS].fill(0.0);
            }
        }
    }

    /// Transform partition `part` from the IR reader `read(channel, index) -> f32`. Runs off the
    /// hot MAC path (the time-distributed loader), earliest partition first.
    pub fn load_partition<F: Fn(usize, usize) -> f32>(&mut self, part: usize, read: &F,
                                                      fft_in: &mut [f32], sc_re: &mut [f32], sc_im: &mut [f32]) {
        let b = self.b;
        let offset = self.d0 + part * b;
        for channel in 0..2 {
            for index in 0..b {
                fft_in[index] = read(channel, offset + index);
            }
            fft_in[b..2 * b].fill(0.0);
            let base = channel * self.parts * BINS + part * BINS;
            let (re, im) = (&mut self.ir_re[base..base + BINS], &mut self.ir_im[base..base + BINS]);
            re.fill(0.0);
            im.fill(0.0);
            self.tables.forward(&fft_in[..2 * b], re, im, sc_re, sc_im);
        }
        self.ready = self.ready.max(part + 1);
    }

    /// The loaded spectrum (`b + 1` bins) of partition `part`, split re/im.
    pub fn spectrum(&self, channel: usize, part: usize) -> (&[f32], &[f32]) {
        let base = channel * self.parts * BINS + part * BINS;
        (&self.ir_re[base..base + self.b + 1], &self.ir_im[base..base + self.b + 1])
    }

    /// Forward FFT of `input` (`2b` samples) with this level's tables.
    pub fn transform(&self, input: &[f32], re: &mut [f32], im: &mut [f32], sc_re: &mut [f32], sc_im: &mut [f32]) {
        self.tables.forward(input, re, im, sc_re, sc_im);
    }

    /// Add this level's contribution for the UPCOMING quantum (period step `step`) into `tail`.
    pub fn consume(&mut self, step: usize, tail: &mut [[f32; BLOCK]; 2]) {
        if self.parts == 0 {
            return;
        }
        let offset = self.b + step * BLOCK;
        for channel in 0..2 {
            let staging = &self.staging[channel];
            let out = &mut tail[channel];
            for index in 0..BLOCK {
                out[index] += staging[offset + index];
            }
        }
    }

    /// Run the pipeline for period step `step` (0 = a `b` block just completed). `window` holds at
    /// least the last `2b` input samples per channel ending at the 128 boundary.
    pub fn on_boundary(&mut self, step: usize, window: &[[f32; 16384]; 2],
                       sc_re: &mut [f32], sc_im: &mut [f32]) {
        if self.parts == 0 {
            return;
        }
        if step == 0 {
            self.slot = if self.slot == 0 { self.parts - 1 } else { self.slot - 1 };
            for channel in 0..2 {
                let base = channel * self.parts * BINS + self.slot * BINS;
                let (re, im) = (&mut self.fdl_re[base..base + BINS], &mut self.fdl_im[base..base + BINS]);
                re.fill(0.0);
                im.fill(0.0);
                self.tables.forward(&window[channel][..2 * self.b], re, im, sc_re, sc_im);
                self.acc_re[channel].fill(0.0);
                self.acc_im[channel].fill(0.0);
            }
            self.mac_cursor = 0;
        }
        let mac_steps = if self.eager { 1 } else { self.steps - 1 };
        if step < mac_steps {
            let per_step = self.ready.div_ceil(mac_steps);
            let end = (self.mac_cursor + per_step).min(self.ready);
            for channel in 0..2 {
                let ch_base = channel * self.parts * BINS;
                for part in self.mac_cursor..end {
                    let slot = (self.slot + part) % self.parts;
                    let x_base = ch_base + slot * BINS;
                    let h_base = ch_base + part * BINS;
                    spectral_mac(&mut self.acc_re[channel], &mut self.acc_im[channel],
                                 &self.fdl_re[x_base..x_base + BINS], &self.fdl_im[x_base..x_base + BINS],
                                 &self.ir_re[h_base..h_base + BINS], &self.ir_im[h_base..h_base + BINS]);
                }
            }
            self.mac_cursor = end;
        }
        if self.eager || step == self.steps - 1 {
            for channel in 0..2 {
                let bins = self.bins();
                self.tables.inverse(&self.acc_re[channel][..bins], &self.acc_im[channel][..bins],
                                    &mut self.staging[channel][..2 * self.b], sc_re, sc_im);
            }
        }
    }

    /// Silence the runtime (FDL, accumulators, staging), keeping the IR spectra.
    pub fn clear_runtime(&mut self) {
        self.fdl_re.fill(0.0);
        self.fdl_im.fill(0.0);
        for channel in 0..2 {
            self.acc_re[channel].fill(0.0);
            self.acc_im[channel].fill(0.0);
            self.staging[channel].fill(0.0);
        }
        self.slot = 0;
        self.mac_cursor = 0;
    }
}

/// `acc += x * h` (complex, split arrays). The hot loop: independent lanes, no shuffles, no
/// reductions — LLVM autovectorizes it to SIMD128 (wasm) / NEON (native).
#[inline]
pub fn spectral_mac(acc_re: &mut [f32], acc_im: &mut [f32], x_re: &[f32], x_im: &[f32], h_re: &[f32], h_im: &[f32]) {
    let n = acc_re.len().min(acc_im.len()).min(x_re.len()).min(x_im.len()).min(h_re.len()).min(h_im.len());
    for index in 0..n {
        let xr = x_re[index];
        let xi = x_im[index];
        let hr = h_re[index];
        let hi = h_im[index];
        acc_re[index] += xr * hr - xi * hi;
        acc_im[index] += xr * hi + xi * hr;
    }
}

// Canonical device layout: head 0..128 direct, 128..2048 @ b=128 (eager), 2048..16384 @ b=1024,
// 16384..770048 @ b=8192 — validated by the crate's tests, sized by the bench in tests/.
pub const MAX_IR_FRAMES: usize = 770048;
const L1_PARTS: usize = 15;
const L2_PARTS: usize = 14;
const L3_PARTS: usize = 92;
const L1_BINS: usize = 132;
const L2_BINS: usize = 1028;
const L3_BINS: usize = 8196;
const L1_SPEC: usize = 2 * L1_PARTS * L1_BINS;
const L2_SPEC: usize = 2 * L2_PARTS * L2_BINS;
const L3_SPEC: usize = 2 * L3_PARTS * L3_BINS;
const RING: usize = 32768;
const PREDELAY_CAP: usize = 49152;

pub type Level1 = Level<256, L1_BINS, 129, L1_SPEC>;
pub type Level2 = Level<2048, L2_BINS, 1025, L2_SPEC>;
pub type Level3 = Level<16384, L3_BINS, 8193, L3_SPEC>;

struct Loader {
    frames: usize,
    stereo: bool,
    reverse: bool,
    normalize: bool,
    ratio: f32,
    cursor: usize,
    total: usize,
    head_done: bool,
    settle: bool,
    previous_gain: f32,
    active: bool
}

// normalize gain: drops snap (a hotter IR must never play at the old gain), rises wait until the L3
// pipeline has flushed the old IR (2 periods + 1) and then glide over ~40 ms
const GAIN_RISE: f32 = 0.0005;
const GAIN_HOLD_QUANTA: usize = 2 * (8192 / BLOCK) + 1;
// pre-delay changes crossfade between the old and the new tap over 10 ms (no read-head jump, no pitch zip)
const PREDELAY_FADE_STEP: f32 = 1.0 / 480.0;
// the full-IR spectrum for normalize lives on the L3 grid: 16384-point bins, 8193 of them
const SPEC_FFT: usize = 16384;
const SPEC_BINS: usize = SPEC_FFT / 2 + 1;
const NORMALIZE_BAND: usize = 8;
// +3 dB over the band peak: calibrated on the 48 cloud IRs (pink-noise wet level median -6 dB, IQR 3 dB)
const NORMALIZE_MAKEUP: f64 = 1.4125375;

// Linear-interpolating read at `index * ratio` (IR resampled to the engine rate at load time).
#[inline]
fn read_resampled(source: &[f32], index: usize, ratio: f32) -> f32 {
    if ratio == 1.0 {
        return if index < source.len() { source[index] } else { 0.0 };
    }
    let position = index as f64 * ratio as f64;
    let base = position as usize;
    if base + 1 >= source.len() {
        return if base < source.len() { source[base] } else { 0.0 };
    }
    let fraction = (position - base as f64) as f32;
    source[base] + fraction * (source[base + 1] - source[base])
}

/// The full convolver: stereo in, stereo IR (channel-wise), zero latency, wet predelay + wet/dry.
pub struct Convolver {
    head_taps: [[f32; HEAD]; 2],
    head_hist: [[f32; 2 * BLOCK]; 2],
    l1: Level1,
    l2: Level2,
    l3: Level3,
    in_ring: [[f32; RING]; 2],
    window: [[f32; 16384]; 2],
    tail: [[f32; BLOCK]; 2],
    predelay_ring: [[f32; PREDELAY_CAP]; 2],
    fft_in: [f32; 16384],
    sc_re: [f32; 8192],
    sc_im: [f32; 8192],
    spec_re: [[f32; L3_BINS]; 2],
    spec_im: [[f32; L3_BINS]; 2],
    loader: Loader,
    write: usize,
    pos: usize,
    quantum: usize,
    stagger: usize,
    predelay_pos: usize,
    predelay_current: usize,
    predelay_next: usize,
    predelay_fade: f32,
    pub predelay_samples: usize,
    pub wet_gain: f32,
    pub dry_gain: f32,
    ir_gain: f32,
    ir_gain_target: f32,
    gain_pending: f32,
    gain_hold_until: usize,
    gain_pending_active: bool,
    loaded: bool
}

impl Convolver {
    /// Build IN PLACE (the state block arrives zeroed).
    pub fn init(&mut self) {
        self.l1.init(128, 128, true);
        self.l2.init(1024, 2048, false);
        self.l3.init(8192, 16384, false);
        self.loader = Loader {frames: 0, stereo: false, reverse: false, normalize: false, ratio: 1.0, cursor: 0, total: 0, head_done: false, settle: false, previous_gain: 1.0, active: false};
        self.wet_gain = 1.0;
        self.dry_gain = 1.0;
        self.ir_gain = 1.0;
        self.ir_gain_target = 1.0;
        self.loaded = false;
        self.predelay_samples = 0;
        self.gain_pending = 1.0;
        self.gain_hold_until = 0;
        self.gain_pending_active = false;
        self.stagger = 0;
        self.clear_runtime();
    }

    /// Offset this instance's partition-period phase so the heavy L3 FFT quanta of multiple
    /// instances do not align and stack their spikes. Any offset is correct (the rings start
    /// silent, so a mid-period start convolves leading silence).
    pub fn set_stagger(&mut self, offset: usize) {
        self.stagger = offset % (8192 / BLOCK);
        self.quantum = self.stagger;
    }

    /// Start loading a new IR (`stereo` = distinct right channel; mono duplicates left).
    /// `normalize` scales the wet path so the IR's peak |H(f)| is 0 dB (the wet signal is never
    /// louder than the input at any frequency); `ratio` = IR rate / engine rate (the IR is
    /// linear-resampled at load time). The transform runs via `load_step`, which also accumulates
    /// the IR spectrum and re-targets the gain to the portion loaded so far.
    pub fn begin_load(&mut self, ir_left: &[f32], ir_right: &[f32], stereo: bool, normalize: bool, reverse: bool, ratio: f32) {
        let source_frames = if stereo { ir_left.len().min(ir_right.len()) } else { ir_left.len() };
        let frames = ((source_frames as f64 / ratio.max(1e-3) as f64) as usize).min(MAX_IR_FRAMES);
        let settle = !self.loaded;
        let previous_gain = self.ir_gain_target;
        self.loader = Loader {frames, stereo, reverse, normalize, ratio, cursor: 0, total: 0, head_done: false, settle, previous_gain, active: frames > 0};
        self.head_taps = [[0.0; HEAD]; 2];
        self.l1.begin_ir(frames);
        self.l2.begin_ir(frames);
        self.l3.begin_ir(frames);
        self.loader.total = self.l1.parts() + self.l2.parts() + self.l3.parts();
        let read = |channel: usize, index: usize| -> f32 {
            if index >= frames { return 0.0 }
            let source = if reverse { frames - 1 - index } else { index };
            read_resampled(if channel == 1 && stereo { ir_right } else { ir_left }, source, ratio)
        };
        for channel in 0..2 {
            for index in 0..HEAD {
                self.head_taps[channel][index] = read(channel, index);
            }
            self.spec_re[channel].fill(0.0);
            self.spec_im[channel].fill(0.0);
        }
        self.gain_pending_active = false;
        if settle {
            self.ir_gain = if normalize { 0.0 } else { 1.0 };
            self.ir_gain_target = self.ir_gain;
        } else if !normalize {
            self.retarget_gain(1.0);
        }
        self.loaded = frames > 0;
    }

    // 1 / peak of the NORMALIZE_BAND-bin mean power over the accumulated spectrum (both channels): a dense
    // tail's random spectral peaks average out, a real resonance stays bounded; a silent IR keeps unity
    fn peak_gain(&self) -> f32 {
        let mut peak = 0.0f64;
        for channel in 0..2 {
            let (re, im) = (&self.spec_re[channel], &self.spec_im[channel]);
            let power = |bin: usize| (re[bin] * re[bin] + im[bin] * im[bin]) as f64;
            let mut sum = 0.0f64;
            for bin in 0..SPEC_BINS {
                sum += power(bin);
                if bin >= NORMALIZE_BAND {
                    sum -= power(bin - NORMALIZE_BAND);
                }
                peak = peak.max(sum / (bin + 1).min(NORMALIZE_BAND) as f64);
            }
        }
        if peak > 1e-24 { (NORMALIZE_MAKEUP / libm::sqrt(peak)) as f32 } else { 1.0 }
    }

    // L3 partition `part` sits at offset 16384 + 8192 * part: on the 16384 grid its phase factor is (-1)^(bin * part)
    fn accumulate_l3_spectrum(&mut self, part: usize) {
        for channel in 0..2 {
            let (re, im) = self.l3.spectrum(channel, part);
            let (acc_re, acc_im) = (&mut self.spec_re[channel], &mut self.spec_im[channel]);
            if part % 2 == 0 {
                for bin in 0..SPEC_BINS {
                    acc_re[bin] += re[bin];
                    acc_im[bin] += im[bin];
                }
            } else {
                for bin in 0..SPEC_BINS {
                    let sign = if bin % 2 == 0 { 1.0 } else { -1.0 };
                    acc_re[bin] += sign * re[bin];
                    acc_im[bin] += sign * im[bin];
                }
            }
        }
    }

    /// Transform up to `budget` FFT work units (1 unit = one 8192 partition; smaller partitions
    /// cost proportionally less). Returns true while loading continues. Call once per quantum with
    /// the resident IR frames.
    pub fn load_step(&mut self, ir_left: &[f32], ir_right: &[f32], budget: usize) -> bool {
        if !self.loader.active {
            return false;
        }
        let Loader {frames, stereo, reverse, ratio, ..} = self.loader;
        let read = move |channel: usize, index: usize| -> f32 {
            if index >= frames { return 0.0 }
            let source = if reverse { frames - 1 - index } else { index };
            read_resampled(if channel == 1 && stereo { ir_right } else { ir_left }, source, ratio)
        };
        let mut work = (budget * 16384) as isize;
        if self.loader.normalize && !self.loader.head_done {
            for channel in 0..2 {
                for index in 0..SPEC_FFT {
                    self.fft_in[index] = read(channel, index);
                }
                self.l3.transform(&self.fft_in, &mut self.spec_re[channel], &mut self.spec_im[channel], &mut self.sc_re, &mut self.sc_im);
            }
            self.loader.head_done = true;
            work -= 16384;
        }
        while self.loader.cursor < self.loader.total {
            let part = self.loader.cursor;
            let (l1, l2) = (self.l1.parts(), self.l2.parts());
            let cost = if part < l1 { 256 } else if part < l1 + l2 { 2048 } else { 16384 };
            if work < cost {
                break;
            }
            if part < l1 {
                self.l1.load_partition(part, &read, &mut self.fft_in, &mut self.sc_re, &mut self.sc_im);
            } else if part < l1 + l2 {
                self.l2.load_partition(part - l1, &read, &mut self.fft_in, &mut self.sc_re, &mut self.sc_im);
            } else {
                self.l3.load_partition(part - l1 - l2, &read, &mut self.fft_in, &mut self.sc_re, &mut self.sc_im);
                if self.loader.normalize {
                    self.accumulate_l3_spectrum(part - l1 - l2);
                }
            }
            work -= cost;
            self.loader.cursor += 1;
        }
        let done = self.loader.cursor >= self.loader.total;
        if self.loader.normalize {
            // while old partitions still sound, neither they nor the new ones may exceed their own gain
            let gain = self.peak_gain();
            if self.loader.settle {
                self.ir_gain = gain;
                self.ir_gain_target = gain;
                self.loader.settle = false;
            } else {
                self.retarget_gain(if done { gain } else { gain.min(self.loader.previous_gain) });
            }
        }
        if done {
            self.loader.active = false;
        }
        self.loader.active
    }

    pub fn loading(&self) -> bool {
        self.loader.active
    }

    /// Drop the IR entirely (unbound pointer): dry-only until the next `begin_load`.
    pub fn unload(&mut self) {
        self.loader.active = false;
        self.head_taps = [[0.0; HEAD]; 2];
        self.l1.begin_ir(0);
        self.l2.begin_ir(0);
        self.l3.begin_ir(0);
        self.ir_gain = 1.0;
        self.ir_gain_target = 1.0;
        self.gain_pending_active = false;
        self.loaded = false;
        self.clear_runtime();
    }

    /// Silence rings, FDLs and staging (transport STOP), keeping IR spectra and parameters.
    pub fn clear_runtime(&mut self) {
        self.head_hist = [[0.0; 2 * BLOCK]; 2];
        for channel in 0..2 {
            self.in_ring[channel].fill(0.0);
            self.window[channel].fill(0.0);
            self.tail[channel].fill(0.0);
            self.predelay_ring[channel].fill(0.0);
        }
        self.l1.clear_runtime();
        self.l2.clear_runtime();
        self.l3.clear_runtime();
        self.write = 0;
        self.pos = 0;
        self.quantum = self.stagger;
        self.predelay_pos = 0;
        self.predelay_current = self.predelay_samples.min(PREDELAY_CAP - 1);
        self.predelay_next = self.predelay_current;
        self.predelay_fade = 1.0;
    }

    // A rise waits until the old IR has drained from the L3 pipeline, a drop applies at once.
    fn retarget_gain(&mut self, gain: f32) {
        if gain > self.ir_gain_target {
            self.gain_pending = gain;
            self.gain_hold_until = self.quantum + GAIN_HOLD_QUANTA;
            self.gain_pending_active = true;
        } else {
            self.ir_gain_target = gain;
            self.gain_pending_active = false;
        }
    }

    /// Process `[s0, s1)` of the quantum buffers (the `FreeVerb::process` calling convention).
    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], s0: usize, s1: usize) {
        for index in s0..s1 {
            let dry = [in_left[index], in_right[index]];
            let pos = self.pos;
            let mut wet = [0.0f32; 2];
            for channel in 0..2 {
                let x = dry[channel];
                self.in_ring[channel][self.write & (RING - 1)] = x;
                self.head_hist[channel][BLOCK + pos] = x;
                let hist = &self.head_hist[channel];
                let taps = &self.head_taps[channel];
                let mut acc = 0.0f32;
                for k in 0..HEAD {
                    acc += taps[k] * hist[BLOCK + pos - k];
                }
                wet[channel] = acc + self.tail[channel][pos];
            }
            self.write += 1;
            if self.ir_gain_target < self.ir_gain {
                self.ir_gain = self.ir_gain_target;
            } else {
                self.ir_gain += (self.ir_gain_target - self.ir_gain) * GAIN_RISE;
            }
            if self.predelay_fade < 1.0 {
                self.predelay_fade += PREDELAY_FADE_STEP;
                if self.predelay_fade >= 1.0 {
                    self.predelay_current = self.predelay_next;
                }
            } else if self.predelay_samples.min(PREDELAY_CAP - 1) != self.predelay_current {
                self.predelay_next = self.predelay_samples.min(PREDELAY_CAP - 1);
                self.predelay_fade = 0.0;
            }
            let fade = self.predelay_fade.min(1.0);
            let read_current = (self.predelay_pos + PREDELAY_CAP - self.predelay_current) % PREDELAY_CAP;
            let read_next = (self.predelay_pos + PREDELAY_CAP - self.predelay_next) % PREDELAY_CAP;
            for channel in 0..2 {
                let ring = &mut self.predelay_ring[channel];
                ring[self.predelay_pos] = wet[channel];
                let delayed = if fade < 1.0 { ring[read_current] * (1.0 - fade) + ring[read_next] * fade } else { ring[read_current] };
                let out = self.dry_gain * dry[channel] + self.wet_gain * self.ir_gain * delayed;
                if channel == 0 { out_left[index] = out } else { out_right[index] = out }
            }
            self.predelay_pos = (self.predelay_pos + 1) % PREDELAY_CAP;
            self.pos += 1;
            if self.pos == BLOCK {
                self.on_block_boundary();
            }
        }
    }

    fn fill_window(&mut self, length: usize) {
        for channel in 0..2 {
            for index in 0..length {
                self.window[channel][index] = self.in_ring[channel][(self.write + RING - length + index) & (RING - 1)];
            }
        }
    }

    fn on_block_boundary(&mut self) {
        self.pos = 0;
        self.quantum += 1;
        if self.gain_pending_active && self.quantum >= self.gain_hold_until {
            self.ir_gain_target = self.gain_pending;
            self.gain_pending_active = false;
        }
        for channel in 0..2 {
            self.head_hist[channel].copy_within(BLOCK..2 * BLOCK, 0);
            self.tail[channel].fill(0.0);
        }
        self.fill_window(256);
        self.l1.on_boundary(0, &self.window, &mut self.sc_re, &mut self.sc_im);
        self.l1.consume(0, &mut self.tail);
        let step2 = self.quantum % (1024 / BLOCK);
        self.l2.consume(step2, &mut self.tail);
        if step2 == 0 {
            self.fill_window(2048);
        }
        self.l2.on_boundary(step2, &self.window, &mut self.sc_re, &mut self.sc_im);
        let step3 = self.quantum % (8192 / BLOCK);
        self.l3.consume(step3, &mut self.tail);
        if step3 == 0 {
            self.fill_window(16384);
        }
        self.l3.on_boundary(step3, &self.window, &mut self.sc_re, &mut self.sc_im);
    }
}

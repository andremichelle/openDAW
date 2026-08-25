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
    /// Clears the runtime (slot indexing depends on the partition count).
    pub fn begin_ir(&mut self, frames: usize) {
        let span = frames.saturating_sub(self.d0);
        self.parts = span.div_ceil(self.b).min(self.max_parts());
        self.ready = 0;
        self.clear_runtime();
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
// 16384..385024 @ b=8192 — validated by the crate's tests, sized by the bench in tests/.
pub const MAX_IR_FRAMES: usize = 385024;
const L1_PARTS: usize = 15;
const L2_PARTS: usize = 14;
const L3_PARTS: usize = 45;
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
    ratio: f32,
    cursor: usize,
    total: usize,
    active: bool
}

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
    loader: Loader,
    write: usize,
    pos: usize,
    quantum: usize,
    predelay_pos: usize,
    pub predelay_samples: usize,
    pub wet_gain: f32,
    pub dry_gain: f32,
    ir_gain: f32
}

impl Convolver {
    /// Build IN PLACE (the state block arrives zeroed).
    pub fn init(&mut self) {
        self.l1.init(128, 128, true);
        self.l2.init(1024, 2048, false);
        self.l3.init(8192, 16384, false);
        self.loader = Loader {frames: 0, stereo: false, reverse: false, ratio: 1.0, cursor: 0, total: 0, active: false};
        self.wet_gain = 1.0;
        self.dry_gain = 1.0;
        self.ir_gain = 1.0;
        self.predelay_samples = 0;
        self.clear_runtime();
    }

    /// Start loading a new IR (`stereo` = distinct right channel; mono duplicates left).
    /// `normalize` scales the wet path to unity IR energy; `ratio` = IR rate / engine rate (the
    /// IR is linear-resampled at load time). The transform runs via `load_step`.
    pub fn begin_load(&mut self, ir_left: &[f32], ir_right: &[f32], stereo: bool, normalize: bool, reverse: bool, ratio: f32) {
        let source_frames = if stereo { ir_left.len().min(ir_right.len()) } else { ir_left.len() };
        let frames = ((source_frames as f64 / ratio.max(1e-3) as f64) as usize).min(MAX_IR_FRAMES);
        self.loader = Loader {frames, stereo, reverse, ratio, cursor: 0, total: 0, active: frames > 0};
        self.head_taps = [[0.0; HEAD]; 2];
        self.l1.begin_ir(frames);
        self.l2.begin_ir(frames);
        self.l3.begin_ir(frames);
        self.loader.total = self.l1.parts() + self.l2.parts() + self.l3.parts();
        self.ir_gain = if normalize && frames > 0 {
            let mut energy = 0.0f64;
            for index in 0..frames {
                let left = read_resampled(ir_left, index, ratio) as f64;
                let right = if stereo { read_resampled(ir_right, index, ratio) as f64 } else { left };
                energy += 0.5 * (left * left + right * right);
            }
            if energy > 1e-12 { (1.0 / libm::sqrt(energy)) as f32 } else { 1.0 }
        } else { 1.0 };
        let Loader {frames, stereo, reverse, ratio, ..} = self.loader;
        let read = |channel: usize, index: usize| -> f32 {
            if index >= frames { return 0.0 }
            let source = if reverse { frames - 1 - index } else { index };
            read_resampled(if channel == 1 && stereo { ir_right } else { ir_left }, source, ratio)
        };
        for channel in 0..2 {
            for index in 0..HEAD {
                self.head_taps[channel][index] = read(channel, index);
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
        while work > 0 && self.loader.cursor < self.loader.total {
            let part = self.loader.cursor;
            let (l1, l2) = (self.l1.parts(), self.l2.parts());
            if part < l1 {
                self.l1.load_partition(part, &read, &mut self.fft_in, &mut self.sc_re, &mut self.sc_im);
                work -= 256;
            } else if part < l1 + l2 {
                self.l2.load_partition(part - l1, &read, &mut self.fft_in, &mut self.sc_re, &mut self.sc_im);
                work -= 2048;
            } else {
                self.l3.load_partition(part - l1 - l2, &read, &mut self.fft_in, &mut self.sc_re, &mut self.sc_im);
                work -= 16384;
            }
            self.loader.cursor += 1;
        }
        if self.loader.cursor >= self.loader.total {
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
        self.quantum = 0;
        self.predelay_pos = 0;
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
            for channel in 0..2 {
                let delayed = if self.predelay_samples == 0 { wet[channel] } else {
                    let read = (self.predelay_pos + PREDELAY_CAP - self.predelay_samples.min(PREDELAY_CAP - 1)) % PREDELAY_CAP;
                    let value = self.predelay_ring[channel][read];
                    self.predelay_ring[channel][self.predelay_pos] = wet[channel];
                    value
                };
                let out = self.dry_gain * dry[channel] + self.wet_gain * self.ir_gain * delayed;
                if channel == 0 { out_left[index] = out } else { out_right[index] = out }
            }
            if self.predelay_samples != 0 {
                self.predelay_pos = (self.predelay_pos + 1) % PREDELAY_CAP;
            }
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

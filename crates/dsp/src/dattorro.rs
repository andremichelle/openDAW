#![allow(clippy::approx_constant, clippy::excessive_precision, clippy::needless_range_loop)]
//! A Dattorro plate reverb (`DattorroReverbDsp`), a faithful port of the TS core-processors `DattorroReverbDsp`
//! (after https://github.com/khoin/DattorroReverbNode and Dattorro's "Effect Design Part 1"). A mono sum feeds a
//! pre-delay + input-diffusion allpass chain into a figure-of-eight tank of decay-diffusion allpasses and damped
//! delays, with two excursion-modulated (cubic-interpolated) delays. `f32`, fixed buffers (no allocation) sized
//! for 48 kHz — the delay LENGTHS are computed from the real rate and clamped to the fixed rings.

/// Smallest power of two >= `value` (used by the tests to verify the fixed ring sizes).
#[allow(dead_code)]
fn next_pow_of_2(value: usize) -> usize {
    let mut power = 1;
    while power < value {
        power <<= 1;
    }
    power
}

// Delay-line tunings (seconds) and their 48 kHz power-of-two ring sizes (indices 0..11).
const DELAY_TIMES: [f32; 12] = [
    0.004771345, 0.003595309, 0.012734787, 0.009307483, 0.022579886, 0.149625349,
    0.060481839, 0.1249958, 0.030509727, 0.141695508, 0.089244313, 0.106280031
];
// Output tap offsets (seconds), rounded to samples at init.
const TAP_TIMES: [f32; 14] = [
    0.008937872, 0.099929438, 0.064278754, 0.067067639, 0.066866033, 0.006283391, 0.035818689,
    0.011861161, 0.121870905, 0.041262054, 0.08981553, 0.070931756, 0.011256342, 0.004065724
];
const PRE_DELAY_SIZE: usize = 65536; // next_pow_of_2(48000 + 1)
const PRE_DELAY_MASK: usize = PRE_DELAY_SIZE - 1;

// The 12 ring sizes at 48 kHz (masks are size - 1). Kept as one flat backing store with per-line offsets.
const DELAY_SIZES: [usize; 12] = [256, 256, 1024, 512, 2048, 8192, 4096, 8192, 2048, 8192, 8192, 8192];
const TOTAL_DELAY: usize = 256 + 256 + 1024 + 512 + 2048 + 8192 + 4096 + 8192 + 2048 + 8192 + 8192 + 8192;

/// The plate-reverb DSP. A device holds it in its (engine-zeroed) state and calls `init` in place — the struct
/// is ~500 KB, too large for the device stack, so it is never constructed by value on the audio thread.
pub struct DattorroReverbDsp {
    sample_rate: f32,
    pre_delay_buffer: [f32; PRE_DELAY_SIZE],
    delay: [f32; TOTAL_DELAY], // 12 rings packed end to end (offsets in DELAY_OFFSET)
    offsets: [usize; 12],
    masks: [usize; 12],
    writes: [usize; 12],
    reads: [usize; 12],
    taps: [i32; 14],
    pre_delay_write: usize,
    lp1: f32,
    lp2: f32,
    lp3: f32,
    // f64 like TS: the phase accumulates forever (never wraps), and at the default rate the per-sample
    // increment (~1e-5) falls below the f32 ulp once the phase passes 256, freezing the tank LFO after
    // ~8 minutes of playback (the tail turns static / metallic).
    exc_phase: f64,
    pre_delay: usize,
    bandwidth: f32,
    input_diffusion1: f32,
    input_diffusion2: f32,
    decay: f32,
    decay_diffusion1: f32,
    decay_diffusion2: f32,
    damping: f32,
    excursion_rate: f32,
    excursion_depth: f32,
    wet: f32,
    dry: f32
}

impl DattorroReverbDsp {
    /// Initialise (delay geometry + default params) on an ALREADY-ZEROED instance; the buffers stay zero.
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        let mut offset = 0usize;
        for index in 0..12 {
            let size = DELAY_SIZES[index];
            let len = (libm::roundf(DELAY_TIMES[index] * sample_rate) as usize).min(size); // clamp to the fixed ring
            self.offsets[index] = offset;
            self.masks[index] = size - 1;
            self.writes[index] = len - 1;
            self.reads[index] = 0;
            offset += size;
        }
        for (index, &time) in TAP_TIMES.iter().enumerate() {
            self.taps[index] = libm::roundf(time * sample_rate) as i32;
        }
        self.pre_delay_write = 0;
        self.bandwidth = 0.9999;
        self.input_diffusion1 = 0.75;
        self.input_diffusion2 = 0.625;
        self.decay = 0.5;
        self.decay_diffusion1 = 0.7;
        self.decay_diffusion2 = 0.5;
        self.damping = 0.005;
        self.excursion_rate = 0.5;
        self.excursion_depth = 0.7;
        self.wet = 0.3;
        self.dry = 0.6;
    }

    /// Clear the sounding state on a transport STOP (TS `DattorroReverbDsp.reset`): pre-delay + delay rings,
    /// the input lowpass histories, the write position, and the excursion phase go to zero; the delay geometry
    /// (offsets / masks / read-write pointers) and the parameters survive.
    pub fn reset(&mut self) {
        self.pre_delay_buffer.fill(0.0);
        self.delay.fill(0.0);
        self.pre_delay_write = 0;
        self.lp1 = 0.0;
        self.lp2 = 0.0;
        self.lp3 = 0.0;
        self.exc_phase = 0.0;
    }

    pub fn set_pre_delay_ms(&mut self, ms: f32) {self.pre_delay = (libm::floorf(ms / 1000.0 * self.sample_rate) as usize).min(PRE_DELAY_SIZE - 1);}
    pub fn set_bandwidth(&mut self, value: f32) {self.bandwidth = value * 0.9999;}
    pub fn set_input_diffusion1(&mut self, value: f32) {self.input_diffusion1 = value;}
    pub fn set_input_diffusion2(&mut self, value: f32) {self.input_diffusion2 = value;}
    pub fn set_decay(&mut self, value: f32) {self.decay = value;}
    pub fn set_decay_diffusion1(&mut self, value: f32) {self.decay_diffusion1 = value * 0.999999;}
    pub fn set_decay_diffusion2(&mut self, value: f32) {self.decay_diffusion2 = value * 0.999999;}
    pub fn set_damping(&mut self, value: f32) {self.damping = value;}
    pub fn set_excursion_rate(&mut self, value: f32) {self.excursion_rate = value * 2.0;}
    pub fn set_excursion_depth(&mut self, value: f32) {self.excursion_depth = value * 2.0;}
    pub fn set_wet_gain(&mut self, value: f32) {self.wet = value;}
    pub fn set_dry_gain(&mut self, value: f32) {self.dry = value;}

    // Read/write one packed ring by index (offset + (pos & mask)).
    #[inline]
    fn get(&self, line: usize, pos: usize) -> f32 {
        self.delay[self.offsets[line] + (pos & self.masks[line])]
    }
    #[inline]
    fn put(&mut self, line: usize, pos: usize, value: f32) {
        let index = self.offsets[line] + (pos & self.masks[line]);
        self.delay[index] = value;
    }

    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        let pd = self.pre_delay;
        let bw = self.bandwidth;
        let fi = self.input_diffusion1;
        let si = self.input_diffusion2;
        let dc = self.decay;
        let ft = self.decay_diffusion1;
        let st = self.decay_diffusion2;
        let dp = 1.0 - self.damping;
        let ex = (self.excursion_rate / self.sample_rate) as f64;
        let ed = self.excursion_depth * self.sample_rate / 1000.0;
        let we = self.wet * 0.6;
        let dr = self.dry;
        let mut pdw = self.pre_delay_write;
        let (mut lp1, mut lp2, mut lp3) = (self.lp1, self.lp2, self.lp3);
        let mut exc_phase = self.exc_phase;
        let read = |slf: &Self, line: usize| slf.reads[line];
        for i in from..to {
            let inp_left = in_left[i];
            let inp_right = in_right[i];
            self.pre_delay_buffer[pdw] = (inp_left + inp_right) * 0.5;
            out_left[i] = inp_left * dr;
            out_right[i] = inp_right * dr;
            let delayed_input = self.pre_delay_buffer[(pdw + PRE_DELAY_SIZE - pd) & PRE_DELAY_MASK];
            lp1 += bw * (delayed_input - lp1);
            // input diffusion allpass chain (lines 0..3)
            let mut pre = lp1 - fi * self.get(0, read(self, 0));
            self.put(0, self.writes[0], pre);
            let d0r = self.get(0, read(self, 0));
            pre = fi * (pre - self.get(1, read(self, 1))) + d0r;
            self.put(1, self.writes[1], pre);
            let d1r = self.get(1, read(self, 1));
            pre = fi * pre + d1r - si * self.get(2, read(self, 2));
            self.put(2, self.writes[2], pre);
            let d2r = self.get(2, read(self, 2));
            pre = si * (pre - self.get(3, read(self, 3))) + d2r;
            self.put(3, self.writes[3], pre);
            let d3r = self.get(3, read(self, 3));
            let split = si * pre + d3r;
            // excursion-modulated cubic reads for lines 4 and 8
            // WASM CONTRACT: TAU here and 6.2847 on the sin line mirror the TS `DattorroReverbDsp` exactly
            // (the sin rate is deliberately detuned from TAU so the two excursion LFOs decorrelate).
            let exc = ed * (1.0 + libm::cos(exc_phase * core::f64::consts::TAU)) as f32;
            let exc2 = ed * (1.0 + libm::sin(exc_phase * 6.2847)) as f32;
            let read_c4 = self.cubic_excursion(4, read(self, 4), exc);
            let read_c8 = self.cubic_excursion(8, read(self, 8), exc2);
            // tank, first half (lines 4..7)
            let mut temp = split + dc * self.get(11, read(self, 11)) + ft * read_c4;
            self.put(4, self.writes[4], temp);
            self.put(5, self.writes[5], read_c4 - ft * temp);
            lp2 += dp * (self.get(5, read(self, 5)) - lp2);
            temp = dc * lp2 - st * self.get(6, read(self, 6));
            let d6r = self.get(6, read(self, 6));
            self.put(6, self.writes[6], temp);
            self.put(7, self.writes[7], d6r + st * temp);
            // tank, second half (lines 8..11)
            temp = split + dc * self.get(7, read(self, 7)) + ft * read_c8;
            self.put(8, self.writes[8], temp);
            self.put(9, self.writes[9], read_c8 - ft * temp);
            lp3 += dp * (self.get(9, read(self, 9)) - lp3);
            temp = dc * lp3 - st * self.get(10, read(self, 10));
            let d10r = self.get(10, read(self, 10));
            self.put(10, self.writes[10], temp);
            self.put(11, self.writes[11], d10r + st * temp);
            // output taps
            let t = &self.taps;
            let lo = self.get(9, (read(self, 9) as i32 + t[0]) as usize) + self.get(9, (read(self, 9) as i32 + t[1]) as usize)
                - self.get(10, (read(self, 10) as i32 + t[2]) as usize) + self.get(11, (read(self, 11) as i32 + t[3]) as usize)
                - self.get(5, (read(self, 5) as i32 + t[4]) as usize) - self.get(6, (read(self, 6) as i32 + t[5]) as usize)
                - self.get(7, (read(self, 7) as i32 + t[6]) as usize);
            let ro = self.get(5, (read(self, 5) as i32 + t[7]) as usize) + self.get(5, (read(self, 5) as i32 + t[8]) as usize)
                - self.get(6, (read(self, 6) as i32 + t[9]) as usize) + self.get(7, (read(self, 7) as i32 + t[10]) as usize)
                - self.get(9, (read(self, 9) as i32 + t[11]) as usize) - self.get(10, (read(self, 10) as i32 + t[12]) as usize)
                - self.get(11, (read(self, 11) as i32 + t[13]) as usize);
            out_left[i] += lo * we;
            out_right[i] += ro * we;
            exc_phase += ex;
            pdw = (pdw + 1) & PRE_DELAY_MASK;
            for d in 0..12 {
                self.writes[d] = (self.writes[d] + 1) & self.masks[d];
                self.reads[d] = (self.reads[d] + 1) & self.masks[d];
            }
        }
        self.pre_delay_write = pdw;
        self.lp1 = lp1;
        self.lp2 = lp2;
        self.lp3 = lp3;
        self.exc_phase = exc_phase;
    }

    /// A 4-point cubic (Catmull-Rom-like) read of `line` at `read + excursion`, mirroring the TS `readC4/readC8`.
    #[inline]
    fn cubic_excursion(&self, line: usize, read: usize, exc: f32) -> f32 {
        let frac = exc - libm::truncf(exc);
        let base = libm::truncf(exc) as i32 + read as i32 - 1;
        let x0 = self.get(line, base as usize);
        let x1 = self.get(line, (base + 1) as usize);
        let x2 = self.get(line, (base + 2) as usize);
        let x3 = self.get(line, (base + 3) as usize);
        (((3.0 * (x1 - x2) - x0 + x3) * 0.5 * frac + 2.0 * x2 + x0 - (5.0 * x1 + x3) * 0.5) * frac
            + (x2 - x0) * 0.5) * frac + x1
    }
}

#[cfg(test)]
mod tests {
    use super::{next_pow_of_2, DattorroReverbDsp, TOTAL_DELAY, PRE_DELAY_SIZE};

    fn make() -> alloc::boxed::Box<DattorroReverbDsp> {
        // heap-allocate the large struct for tests (it is ~500 KB).
        let mut verb: alloc::boxed::Box<DattorroReverbDsp> = unsafe {
            alloc::boxed::Box::new(core::mem::zeroed())
        };
        verb.init(48_000.0);
        verb
    }

    extern crate alloc;

    #[test]
    fn sizes_are_consistent() {
        assert_eq!(TOTAL_DELAY, 256 + 256 + 1024 + 512 + 2048 + 8192 + 4096 + 8192 + 2048 + 8192 + 8192 + 8192);
        assert_eq!(PRE_DELAY_SIZE, next_pow_of_2(48_001));
    }

    #[test]
    fn an_impulse_produces_a_decaying_tail() {
        let mut verb = make();
        verb.set_wet_gain(1.0);
        verb.set_dry_gain(0.0);
        verb.set_decay(0.5);
        verb.set_pre_delay_ms(0.0);
        let mut tail = alloc::vec::Vec::new();
        for block in 0..300 {
            let mut in_l = [0.0f32; 256];
            let mut in_r = [0.0f32; 256];
            if block == 0 {
                in_l[0] = 1.0;
                in_r[0] = 1.0;
            }
            let (mut out_l, mut out_r) = ([0.0f32; 256], [0.0f32; 256]);
            verb.process(&in_l, &in_r, &mut out_l, &mut out_r, 0, 256);
            tail.extend_from_slice(&out_l);
        }
        assert!(tail.iter().all(|s| s.is_finite()));
        // The plate tank fills over the first ~0.2 s; past that, energy decays. Compare a long first half of the
        // settled tail against a long second half (robust to the exact build-up timing).
        let first: f32 = tail[15_000..40_000].iter().map(|s| s * s).sum();
        let second: f32 = tail[45_000..70_000].iter().map(|s| s * s).sum();
        assert!(first > 0.0, "the reverb tail has energy");
        assert!(second < first, "and it decays over time (first {first} > second {second})");
    }

    #[test]
    fn dry_only_passes_the_input() {
        let mut verb = make();
        verb.set_wet_gain(0.0);
        verb.set_dry_gain(1.0);
        let in_l = [0.5f32, -0.3, 0.7, -0.2];
        let (mut out_l, mut out_r) = ([0.0f32; 4], [0.0f32; 4]);
        verb.process(&in_l, &in_l, &mut out_l, &mut out_r, 0, 4);
        for (got, want) in out_l.iter().zip(in_l) {
            assert!((got - want).abs() < 1e-6, "dry-only passes the input");
        }
    }
}

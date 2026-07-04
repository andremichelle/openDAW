#![allow(clippy::needless_range_loop)]
//! A stereo Freeverb (`FreeVerb`), a faithful port of the TS core-processors `FreeVerb`: 8 damped feedback comb
//! filters into 4 allpass filters per channel, fed by a stereo pre-delay. `f32`, fixed buffers (no allocation).
//! The comb / allpass buffer sizes are the classic Freeverb tunings; the pre-delay ring is sized for 0.5 s at
//! up to 48 kHz. The dense per-sample loop mirrors the TS exactly (same tap offsets, same feedback structure).

/// Smallest power of two >= `value` (mirrors lib-std `nextPowOf2`).
fn next_pow_of_2(value: usize) -> usize {
    let mut power = 1;
    while power < value {
        power <<= 1;
    }
    power
}

// Comb tap offsets (samples) per channel, the classic Freeverb tunings.
const LEFT_COMB_TAPS: [usize; 8] = [1617, 1557, 1491, 1422, 1356, 1277, 1188, 1116];
const RIGHT_COMB_TAPS: [usize; 8] = [1640, 1580, 1514, 1445, 1379, 1300, 1211, 1139];

const MAX_DELAY_SIZE: usize = 32768; // next_pow_of_2(ceil(0.5 * 48000)); the pre-delay ring (per channel)
const MAGIC_GAIN: f32 = 0.01;

/// The Freeverb DSP. Built with `new`; a device holds it in its state (large: ~700 KB of fixed buffers) and
/// drives it per block. `room_size` / `damp` / `wet_gain` / `dry_gain` / `predelay_in_samples` are set directly.
pub struct FreeVerb {
    pub room_size: f32,
    pub damp: f32,
    pub predelay_in_samples: usize,
    pub wet_gain: f32,
    pub dry_gain: f32,
    comb_left: [[f32; 2048]; 8],
    comb_right: [[f32; 2048]; 8],
    lp_left: [f32; 8],
    fb_left: [f32; 8],
    lp_right: [f32; 8],
    fb_right: [f32; 8],
    // left allpass: 1024, 512, 512, 256
    ap_l0: [f32; 1024],
    ap_l1: [f32; 512],
    ap_l2: [f32; 512],
    ap_l3: [f32; 256],
    // right allpass: 1024, 512, 512, 256
    ap_r0: [f32; 1024],
    ap_r1: [f32; 512],
    ap_r2: [f32; 512],
    ap_r3: [f32; 256],
    ap_left: [f32; 4],  // the a6/a4/a2/a0 feedback states (in that order)
    ap_right: [f32; 4],
    delay_buffer: [f32; MAX_DELAY_SIZE * 2], // stereo interleaved pre-delay ring
    delay_size: usize,
    index: usize,
    delay_position: usize
}

impl FreeVerb {
    /// Set the scalar parameters + delay geometry on an ALREADY-ZEROED instance (the buffers stay zero). A device
    /// calls this on its engine-zeroed state so the ~400 KB struct is never built on the (256 KB) device stack.
    pub fn init(&mut self, sample_rate: f32) {
        self.delay_size = next_pow_of_2(libm::ceilf(0.5 * sample_rate) as usize).min(MAX_DELAY_SIZE);
        self.room_size = 0.5;
        self.damp = 0.0;
        self.predelay_in_samples = (0.008 * sample_rate) as usize;
        self.wet_gain = 0.3333;
        self.dry_gain = 1.0 - 0.3333;
        self.index = 0;
        self.delay_position = 0;
    }

    /// Clear the sounding state on a transport STOP (TS `FreeVerb.clear`): all rings + feedback histories +
    /// positions go to zero, the parameters + delay geometry survive.
    pub fn clear(&mut self) {
        self.index = 0;
        self.delay_position = 0;
        for buffer in self.comb_left.iter_mut().chain(self.comb_right.iter_mut()) {
            buffer.fill(0.0);
        }
        self.lp_left.fill(0.0);
        self.fb_left.fill(0.0);
        self.lp_right.fill(0.0);
        self.fb_right.fill(0.0);
        self.ap_l0.fill(0.0);
        self.ap_l1.fill(0.0);
        self.ap_l2.fill(0.0);
        self.ap_l3.fill(0.0);
        self.ap_r0.fill(0.0);
        self.ap_r1.fill(0.0);
        self.ap_r2.fill(0.0);
        self.ap_r3.fill(0.0);
        self.ap_left.fill(0.0);
        self.ap_right.fill(0.0);
        self.delay_buffer.fill(0.0);
    }

    pub fn new(sample_rate: f32) -> Self {
        let delay_size = next_pow_of_2(libm::ceilf(0.5 * sample_rate) as usize).min(MAX_DELAY_SIZE);
        FreeVerb {
            room_size: 0.5,
            damp: 0.0,
            predelay_in_samples: (0.008 * sample_rate) as usize,
            wet_gain: 0.3333,
            dry_gain: 1.0 - 0.3333,
            comb_left: [[0.0; 2048]; 8],
            comb_right: [[0.0; 2048]; 8],
            lp_left: [0.0; 8],
            fb_left: [0.0; 8],
            lp_right: [0.0; 8],
            fb_right: [0.0; 8],
            ap_l0: [0.0; 1024],
            ap_l1: [0.0; 512],
            ap_l2: [0.0; 512],
            ap_l3: [0.0; 256],
            ap_r0: [0.0; 1024],
            ap_r1: [0.0; 512],
            ap_r2: [0.0; 512],
            ap_r3: [0.0; 256],
            ap_left: [0.0; 4],
            ap_right: [0.0; 4],
            delay_buffer: [0.0; MAX_DELAY_SIZE * 2],
            delay_size,
            index: 0,
            delay_position: 0
        }
    }

    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        let p0 = 0.4 * self.damp;
        let p1 = 1.0 - p0;
        let p2 = 0.7 + 0.28 * self.room_size;
        let predelay = self.predelay_in_samples.min(self.delay_size);
        for i in from..to {
            let inp_left = in_left[i];
            let inp_right = in_right[i];
            // stereo pre-delay
            // `delay_size` is a power of two: mask instead of a per-sample integer division.
            let delay_read = (self.delay_position + self.delay_size - predelay) & (self.delay_size - 1);
            let read_left = self.delay_buffer[delay_read << 1] * MAGIC_GAIN;
            let read_right = self.delay_buffer[(delay_read << 1) + 1] * MAGIC_GAIN;
            self.delay_buffer[self.delay_position << 1] = inp_left;
            self.delay_buffer[(self.delay_position << 1) + 1] = inp_right;
            self.delay_position = (self.delay_position + 1) & (self.delay_size - 1);
            let p = self.index & 2047;
            // left comb bank
            let mut lt0 = 0.0f32;
            for c in 0..8 {
                self.lp_left[c] = p1 * self.fb_left[c] + p0 * self.lp_left[c];
                self.comb_left[c][p] = read_left + p2 * self.lp_left[c];
                self.fb_left[c] = self.comb_left[c][(self.index.wrapping_sub(LEFT_COMB_TAPS[c])) & 2047];
                lt0 += self.fb_left[c];
            }
            // left allpass chain (a6/a4/a2/a0 == ap_left[0..4])
            let lt1 = self.ap_left[0] - lt0;
            let lt2 = self.ap_left[1] - lt1;
            let lt3 = self.ap_left[2] - lt2;
            self.ap_l0[self.index & 1023] = lt0 + 0.5 * self.ap_left[0];
            self.ap_left[0] = self.ap_l0[(self.index.wrapping_sub(556)) & 1023];
            self.ap_l1[self.index & 511] = lt1 + 0.5 * self.ap_left[1];
            self.ap_left[1] = self.ap_l1[(self.index.wrapping_sub(441)) & 511];
            self.ap_l2[self.index & 511] = lt2 + 0.5 * self.ap_left[2];
            self.ap_left[2] = self.ap_l2[(self.index.wrapping_sub(341)) & 511];
            self.ap_l3[self.index & 255] = lt3 + 0.5 * self.ap_left[3];
            self.ap_left[3] = self.ap_l3[(self.index.wrapping_sub(225)) & 255];
            out_left[i] = self.dry_gain * inp_left + self.wet_gain * (self.ap_left[3] - lt3);
            // right comb bank
            let mut rt0 = 0.0f32;
            for c in 0..8 {
                self.lp_right[c] = p1 * self.fb_right[c] + p0 * self.lp_right[c];
                self.comb_right[c][p] = read_right + p2 * self.lp_right[c];
                self.fb_right[c] = self.comb_right[c][(self.index.wrapping_sub(RIGHT_COMB_TAPS[c])) & 2047];
                rt0 += self.fb_right[c];
            }
            // right allpass chain
            let rt1 = self.ap_right[0] - rt0;
            let rt2 = self.ap_right[1] - rt1;
            let rt3 = self.ap_right[2] - rt2;
            self.ap_r0[self.index & 1023] = rt0 + 0.5 * self.ap_right[0];
            self.ap_right[0] = self.ap_r0[(self.index.wrapping_sub(579)) & 1023];
            self.ap_r1[self.index & 511] = rt1 + 0.5 * self.ap_right[1];
            self.ap_right[1] = self.ap_r1[(self.index.wrapping_sub(464)) & 511];
            self.ap_r2[self.index & 511] = rt2 + 0.5 * self.ap_right[2];
            self.ap_right[2] = self.ap_r2[(self.index.wrapping_sub(364)) & 511];
            self.ap_r3[self.index & 255] = rt3 + 0.5 * self.ap_right[3];
            self.ap_right[3] = self.ap_r3[(self.index.wrapping_sub(248)) & 255];
            out_right[i] = self.dry_gain * inp_right + self.wet_gain * (self.ap_right[3] - rt3);
            self.index = self.index.wrapping_add(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{next_pow_of_2, FreeVerb};

    #[test]
    fn next_pow_of_2_rounds_up() {
        assert_eq!(next_pow_of_2(1), 1);
        assert_eq!(next_pow_of_2(24000), 32768);
        assert_eq!(next_pow_of_2(32768), 32768);
        assert_eq!(next_pow_of_2(32769), 65536);
    }

    #[test]
    fn an_impulse_produces_a_decaying_tail() {
        let mut verb = FreeVerb::new(48_000.0);
        verb.room_size = 0.8;
        verb.damp = 0.3;
        verb.wet_gain = 1.0;
        verb.dry_gain = 0.0;
        verb.predelay_in_samples = 200; // a real pre-delay: the impulse reaches the combs quickly (0 = a full ring loop)
        // Feed one impulse, then silence; capture the wet tail.
        let mut tail = Vec::new();
        for block in 0..80 {
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
        // Energy appears after the pre-delay (reverb tail) and is smaller late than early (it decays).
        let early: f32 = tail[400..2400].iter().map(|s| s * s).sum();
        let late: f32 = tail[16000..18000].iter().map(|s| s * s).sum();
        assert!(early > 0.0, "the reverb tail has energy");
        assert!(late < early, "and it decays over time (early {early} > late {late})");
    }

    #[test]
    fn a_dry_only_setting_passes_the_input() {
        let mut verb = FreeVerb::new(48_000.0);
        verb.wet_gain = 0.0;
        verb.dry_gain = 1.0;
        verb.predelay_in_samples = 0;
        let in_l = [0.5f32, -0.3, 0.7, -0.2];
        let (mut out_l, mut out_r) = ([0.0f32; 4], [0.0f32; 4]);
        verb.process(&in_l, &in_l, &mut out_l, &mut out_r, 0, 4);
        for (got, want) in out_l.iter().zip(in_l) {
            assert!((got - want).abs() < 1e-6, "dry-only passes the input through");
        }
    }
}

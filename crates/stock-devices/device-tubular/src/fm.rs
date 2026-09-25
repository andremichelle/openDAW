//! The FM operator kernels and the 32-algorithm router (`fm_op_kernel.cc`, `fm_core.cc`): each operator
//! reads a bus (or none, or its own feedback), writes / adds to a bus or the output, gains ramp linearly
//! across the N-sample frame. Integer Q24 phase, Q24 sine.

use crate::tables::Tables;
use crate::{LG_N, N};

#[derive(Clone, Copy, Default)]
pub struct FmOpParams {
    pub level_in: i32,
    pub gain_out: i32,
    pub freq: i32,
    pub phase: i32
}

pub const OUT_BUS_ADD: u8 = 1 << 2;
pub const FB_IN: u8 = 1 << 6;
pub const FB_OUT: u8 = 1 << 7;

/// The operator kernel: Dexed's Mark I (its default, hardware-like 10-bit log tables) or the msfa
/// "Modern" kernel (interpolated 24-bit tables).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum Engine {
    #[default]
    MarkI,
    Modern
}

impl Engine {
    pub fn from_index(index: i32) -> Self {
        if index == 1 {Engine::Modern} else {Engine::MarkI}
    }
}

pub const ALGORITHMS: [[u8; 6]; 32] = [
    [0xc1, 0x11, 0x11, 0x14, 0x01, 0x14], // 1
    [0x01, 0x11, 0x11, 0x14, 0xc1, 0x14], // 2
    [0xc1, 0x11, 0x14, 0x01, 0x11, 0x14], // 3
    [0xc1, 0x11, 0x94, 0x01, 0x11, 0x14], // 4
    [0xc1, 0x14, 0x01, 0x14, 0x01, 0x14], // 5
    [0xc1, 0x94, 0x01, 0x14, 0x01, 0x14], // 6
    [0xc1, 0x11, 0x05, 0x14, 0x01, 0x14], // 7
    [0x01, 0x11, 0xc5, 0x14, 0x01, 0x14], // 8
    [0x01, 0x11, 0x05, 0x14, 0xc1, 0x14], // 9
    [0x01, 0x05, 0x14, 0xc1, 0x11, 0x14], // 10
    [0xc1, 0x05, 0x14, 0x01, 0x11, 0x14], // 11
    [0x01, 0x05, 0x05, 0x14, 0xc1, 0x14], // 12
    [0xc1, 0x05, 0x05, 0x14, 0x01, 0x14], // 13
    [0xc1, 0x05, 0x11, 0x14, 0x01, 0x14], // 14
    [0x01, 0x05, 0x11, 0x14, 0xc1, 0x14], // 15
    [0xc1, 0x11, 0x02, 0x25, 0x05, 0x14], // 16
    [0x01, 0x11, 0x02, 0x25, 0xc5, 0x14], // 17
    [0x01, 0x11, 0x11, 0xc5, 0x05, 0x14], // 18
    [0xc1, 0x14, 0x14, 0x01, 0x11, 0x14], // 19
    [0x01, 0x05, 0x14, 0xc1, 0x14, 0x14], // 20
    [0x01, 0x14, 0x14, 0xc1, 0x14, 0x14], // 21
    [0xc1, 0x14, 0x14, 0x14, 0x01, 0x14], // 22
    [0xc1, 0x14, 0x14, 0x01, 0x14, 0x04], // 23
    [0xc1, 0x14, 0x14, 0x14, 0x04, 0x04], // 24
    [0xc1, 0x14, 0x14, 0x04, 0x04, 0x04], // 25
    [0xc1, 0x05, 0x14, 0x01, 0x14, 0x04], // 26
    [0x01, 0x05, 0x14, 0xc1, 0x14, 0x04], // 27
    [0x04, 0xc1, 0x11, 0x14, 0x01, 0x14], // 28
    [0xc1, 0x14, 0x01, 0x14, 0x04, 0x04], // 29
    [0x04, 0xc1, 0x11, 0x14, 0x04, 0x04], // 30
    [0xc1, 0x14, 0x04, 0x04, 0x04, 0x04], // 31
    [0xc4, 0x04, 0x04, 0x04, 0x04, 0x04]  // 32
];

pub fn is_carrier(algorithm: usize, op: usize) -> bool {
    (ALGORITHMS[algorithm & 31][op] & OUT_BUS_ADD) != 0
}

fn compute(tables: &Tables, output: &mut [i32; N], input: &[i32; N], phase0: i32, freq: i32, gain1: i32, gain2: i32, add: bool) {
    let dgain = (gain2.wrapping_sub(gain1).wrapping_add((N >> 1) as i32)) >> LG_N;
    let mut gain = gain1;
    let mut phase = phase0;
    for i in 0..N {
        gain = gain.wrapping_add(dgain);
        let y = tables.sin_lookup(phase.wrapping_add(input[i]));
        let y1 = ((y as i64 * gain as i64) >> 24) as i32;
        if add {
            output[i] = output[i].wrapping_add(y1);
        } else {
            output[i] = y1;
        }
        phase = phase.wrapping_add(freq);
    }
}

fn compute_pure(tables: &Tables, output: &mut [i32; N], phase0: i32, freq: i32, gain1: i32, gain2: i32, add: bool) {
    let dgain = (gain2.wrapping_sub(gain1).wrapping_add((N >> 1) as i32)) >> LG_N;
    let mut gain = gain1;
    let mut phase = phase0;
    for i in 0..N {
        gain = gain.wrapping_add(dgain);
        let y = tables.sin_lookup(phase);
        let y1 = ((y as i64 * gain as i64) >> 24) as i32;
        if add {
            output[i] = output[i].wrapping_add(y1);
        } else {
            output[i] = y1;
        }
        phase = phase.wrapping_add(freq);
    }
}

fn compute_fb(tables: &Tables, output: &mut [i32; N], phase0: i32, freq: i32, gain1: i32, gain2: i32, fb_buf: &mut [i32; 2], fb_shift: i32, add: bool) {
    let dgain = (gain2.wrapping_sub(gain1).wrapping_add((N >> 1) as i32)) >> LG_N;
    let mut gain = gain1;
    let mut phase = phase0;
    let mut y0 = fb_buf[0];
    let mut y = fb_buf[1];
    for i in 0..N {
        gain = gain.wrapping_add(dgain);
        let scaled_fb = y0.wrapping_add(y) >> (fb_shift + 1).clamp(0, 31);
        y0 = y;
        y = tables.sin_lookup(phase.wrapping_add(scaled_fb));
        y = ((y as i64 * gain as i64) >> 24) as i32;
        if add {
            output[i] = output[i].wrapping_add(y);
        } else {
            output[i] = y;
        }
        phase = phase.wrapping_add(freq);
    }
    fb_buf[0] = y0;
    fb_buf[1] = y;
}

/// The two modulation buses shared by every voice (`FmCore::buf_`).
#[derive(Clone, Copy)]
pub struct FmCore {
    buf: [[i32; N]; 2]
}

impl Default for FmCore {
    fn default() -> Self {
        Self {buf: [[0; N]; 2]}
    }
}

impl FmCore {
    pub fn render(&mut self, engine: Engine, tables: &Tables, output: &mut [i32; N], params: &mut [FmOpParams; 6], algorithm: usize, fb_buf: &mut [i32; 2], feedback_shift: i32) {
        match engine {
            Engine::MarkI => crate::mki::render(&mut self.buf, tables, output, params, algorithm, fb_buf, feedback_shift),
            Engine::Modern => self.render_modern(tables, output, params, algorithm, fb_buf, feedback_shift)
        }
    }

    fn render_modern(&mut self, tables: &Tables, output: &mut [i32; N], params: &mut [FmOpParams; 6], algorithm: usize, fb_buf: &mut [i32; 2], feedback_shift: i32) {
        const LEVEL_THRESH: i32 = 1120;
        let alg = ALGORITHMS[algorithm & 31];
        let mut has_contents = [true, false, false];
        for op in 0..6 {
            let flags = alg[op];
            let mut add = (flags & OUT_BUS_ADD) != 0;
            let inbus = ((flags >> 4) & 3) as usize;
            let outbus = (flags & 3) as usize;
            let gain1 = params[op].gain_out;
            let gain2 = tables.exp2_lookup(params[op].level_in.wrapping_sub(14 * (1 << 24)));
            params[op].gain_out = gain2;
            if gain1 >= LEVEL_THRESH || gain2 >= LEVEL_THRESH {
                if !has_contents[outbus] {
                    add = false;
                }
                let (phase, freq) = (params[op].phase, params[op].freq);
                if inbus == 0 || !has_contents[inbus] {
                    if (flags & (FB_IN | FB_OUT)) == (FB_IN | FB_OUT) && feedback_shift < 16 {
                        match outbus {
                            0 => compute_fb(tables, output, phase, freq, gain1, gain2, fb_buf, feedback_shift, add),
                            bus => compute_fb(tables, &mut self.buf[bus - 1], phase, freq, gain1, gain2, fb_buf, feedback_shift, add)
                        }
                    } else {
                        match outbus {
                            0 => compute_pure(tables, output, phase, freq, gain1, gain2, add),
                            bus => compute_pure(tables, &mut self.buf[bus - 1], phase, freq, gain1, gain2, add)
                        }
                    }
                } else {
                    match outbus {
                        0 => compute(tables, output, &self.buf[inbus - 1], phase, freq, gain1, gain2, add),
                        bus => {
                            // in and out are distinct buses in every algorithm; copy the input to keep the borrow simple
                            let input = self.buf[inbus - 1];
                            compute(tables, &mut self.buf[bus - 1], &input, phase, freq, gain1, gain2, add)
                        }
                    }
                }
                has_contents[outbus] = true;
            } else if !add {
                has_contents[outbus] = false;
            }
            params[op].phase = params[op].phase.wrapping_add(params[op].freq.wrapping_shl(LG_N));
        }
    }
}

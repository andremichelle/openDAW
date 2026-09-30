//! Dexed's Mark I operator kernel (`EngineMkI.cpp`, Pascal Gauthier, GPL-3.0, after the OPL3 math notes
//! and ppplay): a 10-bit log-sine table and a 10-bit exp table like the hardware, envelopes in a 14-bit
//! log domain, plus Dexed's dedicated feedback paths for algorithms 4, 6 and 32. Dexed's default engine.

use crate::fm::{FmOpParams, ALGORITHMS, FB_IN, FB_OUT, OUT_BUS_ADD};
use crate::tables::Tables;
use crate::{LG_N, N};

const NEGATIVE_BIT: u16 = 0x8000;
const ENV_BITDEPTH: u32 = 14;
const ENV_MAX: i32 = 1 << ENV_BITDEPTH;
pub const SINLOG_TABLESIZE: usize = 1 << 10;
pub const SINEXP_TABLESIZE: usize = 1 << 10;

pub fn init_tables(sin_log: &mut [u16; SINLOG_TABLESIZE], sin_exp: &mut [u16; SINEXP_TABLESIZE]) {
    for i in 0..SINLOG_TABLESIZE {
        let x1 = libm::sin(((0.5 + i as f64) / SINLOG_TABLESIZE as f32 as f64) * core::f64::consts::PI / 2.0) as f32;
        sin_log[i] = libm::round(-1024.0 * libm::log2(x1 as f64)) as u16;
    }
    for i in 0..SINEXP_TABLESIZE {
        let x1 = ((libm::pow(2.0, (i as f32 / SINEXP_TABLESIZE as f32) as f64) - 1.0) * 4096.0) as f32;
        sin_exp[i] = libm::round(x1 as f64) as u16;
    }
}

#[inline]
fn sin_log(tables: &Tables, phi: u16) -> u16 {
    const FILTER: u16 = SINLOG_TABLESIZE as u16 - 1;
    let index = (phi & FILTER) as usize;
    match phi & (SINLOG_TABLESIZE as u16 * 3) {
        0 => tables.sin_log[index],
        x if x == SINLOG_TABLESIZE as u16 => tables.sin_log[index ^ FILTER as usize],
        x if x == SINLOG_TABLESIZE as u16 * 2 => tables.sin_log[index] | NEGATIVE_BIT,
        _ => tables.sin_log[index ^ FILTER as usize] | NEGATIVE_BIT
    }
}

#[inline]
fn mki_sin(tables: &Tables, phase: i32, env: u16) -> i32 {
    let mut exp_val = sin_log(tables, ((phase >> 12) & 0xFFFF) as u16).wrapping_add(env);
    let is_signed = exp_val & NEGATIVE_BIT != 0;
    exp_val &= !NEGATIVE_BIT;
    const SINEXP_FILTER: u16 = 0x3FF;
    let result = 4096u32 + tables.sin_exp[((exp_val & SINEXP_FILTER) ^ SINEXP_FILTER) as usize] as u32;
    let result = (result >> (exp_val >> 10)) as i32;
    if is_signed {(-result - 1) << 13} else {result << 13}
}

#[inline]
fn write(output: &mut [i32; N], i: usize, y: i32, add: bool) {
    output[i] = if add {y.wrapping_add(output[i])} else {y};
}

fn compute(tables: &Tables, output: &mut [i32; N], input: &[i32; N], phase0: i32, freq: i32, gain1: i32, gain2: i32, add: bool) {
    let dgain = (gain2.wrapping_sub(gain1).wrapping_add((N >> 1) as i32)) >> LG_N;
    let mut gain = gain1;
    let mut phase = phase0;
    for i in 0..N {
        gain = gain.wrapping_add(dgain);
        let y = mki_sin(tables, phase.wrapping_add(input[i]), gain as u16);
        write(output, i, y, add);
        phase = phase.wrapping_add(freq);
    }
}

fn compute_pure(tables: &Tables, output: &mut [i32; N], phase0: i32, freq: i32, gain1: i32, gain2: i32, add: bool) {
    let dgain = (gain2.wrapping_sub(gain1).wrapping_add((N >> 1) as i32)) >> LG_N;
    let mut gain = gain1;
    let mut phase = phase0;
    for i in 0..N {
        gain = gain.wrapping_add(dgain);
        let y = mki_sin(tables, phase, gain as u16);
        write(output, i, y, add);
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
        y = mki_sin(tables, phase.wrapping_add(scaled_fb), gain as u16);
        write(output, i, y, add);
        phase = phase.wrapping_add(freq);
    }
    fb_buf[0] = y0;
    fb_buf[1] = y;
}

fn env_gain(level_in: i32) -> i32 {
    ENV_MAX.wrapping_sub(level_in >> (28 - ENV_BITDEPTH))
}

fn start_gain(gain_out: i32) -> i32 {
    if gain_out == 0 {ENV_MAX - 1} else {gain_out}
}

/// Algorithm 6 with feedback: operator 6 feeds back into itself and modulates operator 5 in one pass.
fn compute_fb2(tables: &Tables, output: &mut [i32; N], parms: &mut [FmOpParams; 6], gain01: i32, gain02: i32, fb_buf: &mut [i32; 2], fb_shift: i32) {
    let mut y0 = fb_buf[0];
    let mut y = fb_buf[1];
    let mut phase = [parms[0].phase, parms[1].phase];
    parms[1].gain_out = env_gain(parms[1].level_in);
    let mut gain = [gain01, start_gain(parms[1].gain_out)];
    let dgain = [
        (gain02.wrapping_sub(gain01).wrapping_add((N >> 1) as i32)) >> LG_N,
        parms[1].gain_out.wrapping_sub(start_gain(parms[1].gain_out))
    ];
    for i in 0..N {
        let scaled_fb = y0.wrapping_add(y) >> (fb_shift + 1).clamp(0, 31);
        gain[0] = gain[0].wrapping_add(dgain[0]);
        y0 = y;
        y = mki_sin(tables, phase[0].wrapping_add(scaled_fb), gain[0] as u16);
        phase[0] = phase[0].wrapping_add(parms[0].freq);
        gain[1] = gain[1].wrapping_add(dgain[1]);
        y = mki_sin(tables, phase[1].wrapping_add(y), gain[1] as u16);
        phase[1] = phase[1].wrapping_add(parms[1].freq);
        output[i] = y;
    }
    fb_buf[0] = y0;
    fb_buf[1] = y;
}

/// Algorithm 4 with feedback: operators 6, 5, 4 as one feedback chain.
fn compute_fb3(tables: &Tables, output: &mut [i32; N], parms: &mut [FmOpParams; 6], gain01: i32, gain02: i32, fb_buf: &mut [i32; 2], fb_shift: i32) {
    let mut y0 = fb_buf[0];
    let mut y = fb_buf[1];
    let mut phase = [parms[0].phase, parms[1].phase, parms[2].phase];
    parms[1].gain_out = env_gain(parms[1].level_in);
    parms[2].gain_out = env_gain(parms[2].level_in);
    let mut gain = [gain01, start_gain(parms[1].gain_out), start_gain(parms[2].gain_out)];
    let dgain = [
        (gain02.wrapping_sub(gain01).wrapping_add((N >> 1) as i32)) >> LG_N,
        parms[1].gain_out.wrapping_sub(start_gain(parms[1].gain_out)),
        parms[2].gain_out.wrapping_sub(start_gain(parms[2].gain_out))
    ];
    for i in 0..N {
        let scaled_fb = y0.wrapping_add(y) >> (fb_shift + 1).clamp(0, 31);
        gain[0] = gain[0].wrapping_add(dgain[0]);
        y0 = y;
        y = mki_sin(tables, phase[0].wrapping_add(scaled_fb), gain[0] as u16);
        phase[0] = phase[0].wrapping_add(parms[0].freq);
        gain[1] = gain[1].wrapping_add(dgain[1]);
        y = mki_sin(tables, phase[1].wrapping_add(y), gain[1] as u16);
        phase[1] = phase[1].wrapping_add(parms[1].freq);
        gain[2] = gain[2].wrapping_add(dgain[2]);
        y = mki_sin(tables, phase[2].wrapping_add(y), gain[2] as u16);
        phase[2] = phase[2].wrapping_add(parms[2].freq);
        output[i] = y;
    }
    fb_buf[0] = y0;
    fb_buf[1] = y;
}

pub fn render(buf: &mut [[i32; N]; 2], tables: &Tables, output: &mut [i32; N], params: &mut [FmOpParams; 6], algorithm: usize, fb_buf: &mut [i32; 2], feedback_shift: i32) {
    const LEVEL_THRESH: i32 = ENV_MAX - 100;
    let algorithm = algorithm & 31;
    let mut alg = ALGORITHMS[algorithm];
    let mut has_contents = [true, false, false];
    let fb_on = feedback_shift < 16;
    if (algorithm == 3 || algorithm == 5) && fb_on {
        alg[0] = 0xc4;
    }
    let mut op = 0;
    while op < 6 {
        let flags = alg[op];
        let mut add = (flags & OUT_BUS_ADD) != 0;
        let inbus = ((flags >> 4) & 3) as usize;
        let outbus = (flags & 3) as usize;
        let gain1 = start_gain(params[op].gain_out);
        let gain2 = env_gain(params[op].level_in);
        params[op].gain_out = gain2;
        if gain1 <= LEVEL_THRESH || gain2 <= LEVEL_THRESH {
            if !has_contents[outbus] {
                add = false;
            }
            let (phase, freq) = (params[op].phase, params[op].freq);
            if inbus == 0 || !has_contents[inbus] {
                if (flags & (FB_IN | FB_OUT)) == (FB_IN | FB_OUT) && fb_on {
                    let shift = (feedback_shift + 2).min(16);
                    match algorithm {
                        3 => {
                            match outbus {
                                0 => compute_fb3(tables, output, params, gain1, gain2, fb_buf, shift),
                                bus => compute_fb3(tables, &mut buf[bus - 1], params, gain1, gain2, fb_buf, shift)
                            }
                            params[1].phase = params[1].phase.wrapping_add(params[1].freq.wrapping_shl(LG_N));
                            params[2].phase = params[2].phase.wrapping_add(params[2].freq.wrapping_shl(LG_N));
                            op += 2;
                        }
                        5 => {
                            match outbus {
                                0 => compute_fb2(tables, output, params, gain1, gain2, fb_buf, shift),
                                bus => compute_fb2(tables, &mut buf[bus - 1], params, gain1, gain2, fb_buf, shift)
                            }
                            params[1].phase = params[1].phase.wrapping_add(params[1].freq.wrapping_shl(LG_N));
                            op += 1;
                        }
                        31 => match outbus {
                            0 => compute_fb(tables, output, phase, freq, gain1, gain2, fb_buf, shift, add),
                            bus => compute_fb(tables, &mut buf[bus - 1], phase, freq, gain1, gain2, fb_buf, shift, add)
                        },
                        _ => match outbus {
                            0 => compute_fb(tables, output, phase, freq, gain1, gain2, fb_buf, feedback_shift, add),
                            bus => compute_fb(tables, &mut buf[bus - 1], phase, freq, gain1, gain2, fb_buf, feedback_shift, add)
                        }
                    }
                } else {
                    match outbus {
                        0 => compute_pure(tables, output, phase, freq, gain1, gain2, add),
                        bus => compute_pure(tables, &mut buf[bus - 1], phase, freq, gain1, gain2, add)
                    }
                }
            } else {
                match outbus {
                    0 => compute(tables, output, &buf[inbus - 1], phase, freq, gain1, gain2, add),
                    bus => {
                        let input = buf[inbus - 1];
                        compute(tables, &mut buf[bus - 1], &input, phase, freq, gain1, gain2, add)
                    }
                }
            }
            has_contents[outbus] = true;
        } else if !add {
            has_contents[outbus] = false;
        }
        // The chain paths above bind `op` to the FIRST operator of the chain, whose phase advances here.
        let first = if algorithm == 3 && op >= 2 && fb_on && (flags & (FB_IN | FB_OUT)) == (FB_IN | FB_OUT) {0}
            else if algorithm == 5 && op >= 1 && fb_on && (flags & (FB_IN | FB_OUT)) == (FB_IN | FB_OUT) {0} else {op};
        params[first].phase = params[first].phase.wrapping_add(params[first].freq.wrapping_shl(LG_N));
        op += 1;
    }
}

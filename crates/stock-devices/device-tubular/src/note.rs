//! One sounding note (`dx7note.cc`): six operator envelopes + frequencies from the patch, the pitch
//! envelope, LFO pitch / amp modulation, portamento, feedback, rendered through the algorithm router.
//! Standard tuning only (no SCL / MTS / MPE); `note_offset` carries openDAW's per-note cents and the
//! A4 base tuning in Q24-per-octave, zero for a stock MIDI note.

use crate::env::{scaleoutlevel, Env};
use crate::fm::{is_carrier, FmCore, FmOpParams};
use crate::pitchenv::PitchEnv;
use crate::porta::Porta;
use crate::tables::Tables;
use crate::N;

const FEEDBACK_BITDEPTH: i32 = 8;

const COARSEMUL: [i32; 32] = [
    -16777216, 0, 16777216, 26591258, 33554432, 38955489, 43368474, 47099600,
    50331648, 53182516, 55732705, 58039632, 60145690, 62083076, 63876816,
    65546747, 67108864, 68576247, 69959732, 71268397, 72509921, 73690858,
    74816848, 75892776, 76922906, 77910978, 78860292, 79773775, 80654032,
    81503396, 82323963, 83117622
];

const VELOCITY_DATA: [u8; 64] = [
    0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163,
    166, 170, 173, 174, 178, 181, 184, 186, 189, 190, 194, 196, 198, 200, 202,
    205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232,
    233, 235, 237, 238, 240, 241, 242, 243, 244, 246, 246, 248, 249, 250, 251,
    252, 253, 254
];

const EXP_SCALE_DATA: [u8; 33] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 16, 19, 23, 27, 33, 39, 47, 56, 66,
    80, 94, 110, 126, 142, 158, 174, 190, 206, 222, 238, 250
];

const PITCHMODSENSTAB: [u8; 8] = [0, 10, 20, 33, 55, 92, 153, 255];
const AMPMODSENSTAB: [u32; 4] = [0, 4342338, 7171437, 16777216];

pub const LOGFREQ_BASE: i32 = 50857777; // (1 << 24) * (log(440) / log(2) - 69/12)
pub const LOGFREQ_STEP: i32 = (1 << 24) / 12;

pub fn midinote_to_logfreq(midinote: i32) -> i32 {
    LOGFREQ_BASE.wrapping_add(LOGFREQ_STEP.wrapping_mul(midinote))
}

fn logfreq_round2semi(freq: i32) -> i32 {
    let rem = (freq - LOGFREQ_BASE) % LOGFREQ_STEP;
    freq - rem
}

fn osc_freq(midinote: i32, mode: i32, coarse: i32, fine: i32, detune: i32, note_offset: i32) -> i32 {
    if mode == 0 {
        let mut logfreq = midinote_to_logfreq(midinote).wrapping_add(note_offset);
        let detune_ratio = 0.0209 * libm::exp(-0.396 * ((logfreq as f32) / (1 << 24) as f32) as f64) / 7.0;
        logfreq = (logfreq as f64 + detune_ratio * logfreq as f64 * (detune - 7) as f64) as i32;
        logfreq = logfreq.wrapping_add(COARSEMUL[(coarse & 31) as usize]);
        if fine != 0 {
            logfreq = logfreq.wrapping_add(libm::floor(24204406.323123 * libm::log(1.0 + 0.01 * fine as f64) + 0.5) as i32);
        }
        logfreq
    } else {
        let mut logfreq = (4458616 * ((coarse & 3) * 100 + fine)) >> 3;
        logfreq += if detune > 7 {13457 * (detune - 7)} else {0};
        logfreq
    }
}

fn scale_velocity(velocity: i32, sensitivity: i32) -> i32 {
    let clamped_vel = velocity.clamp(0, 127);
    let vel_value = VELOCITY_DATA[(clamped_vel >> 1) as usize] as i32 - 239;
    ((sensitivity * vel_value + 7) >> 3) << 4
}

fn scale_rate(midinote: i32, sensitivity: i32) -> i32 {
    let x = (midinote / 3 - 7).clamp(0, 31);
    (sensitivity * x) >> 3
}

fn scale_curve(group: i32, depth: i32, curve: i32) -> i32 {
    let mut scale = if curve == 0 || curve == 3 {
        (group * depth * 329) >> 12
    } else {
        let raw_exp = EXP_SCALE_DATA[group.min(EXP_SCALE_DATA.len() as i32 - 1).max(0) as usize] as i32;
        (raw_exp * depth * 329) >> 15
    };
    if curve < 2 {
        scale = -scale;
    }
    scale
}

fn scale_level(midinote: i32, break_pt: i32, left_depth: i32, right_depth: i32, left_curve: i32, right_curve: i32) -> i32 {
    let offset = midinote - break_pt - 17;
    if offset >= 0 {
        scale_curve((offset + 1) / 3, right_depth, right_curve)
    } else {
        scale_curve(-(offset - 1) / 3, left_depth, left_curve)
    }
}

/// The controller state a note reads each frame (`Controllers`): no MIDI CC sources in openDAW, so the
/// modulation amounts stay at their `refresh()` rest values and the bend at centre.
#[derive(Clone, Copy)]
pub struct Controllers {
    pub pitch_bend: i32,
    pub pitch_range_up: i32,
    pub pitch_range_dn: i32,
    pub pitch_step: i32,
    pub master_tune: i32,
    pub portamento_enable: bool,
    pub portamento_cc: i32,
    pub portamento_gliss: bool,
    pub op_switch: [bool; 6],
    pub amp_mod: i32,
    pub pitch_mod: i32,
    pub eg_mod: i32
}

impl Default for Controllers {
    fn default() -> Self {
        Self {
            pitch_bend: 0x2000, pitch_range_up: 0, pitch_range_dn: 0, pitch_step: 0, master_tune: 0,
            portamento_enable: false, portamento_cc: 0, portamento_gliss: false, op_switch: [true; 6],
            amp_mod: 0, pitch_mod: 0, eg_mod: 127
        }
    }
}

/// The per-sample-rate constants a note needs at init.
#[derive(Clone, Copy, Default)]
pub struct NoteRates {
    pub sr_multiplier: u32,
    pub pitchenv_unit: i32
}

#[derive(Clone, Copy, Default)]
pub struct Dx7Note {
    initialised: bool,
    env: [Env; 6],
    params: [FmOpParams; 6],
    pitchenv: PitchEnv,
    basepitch: [i32; 6],
    fb_buf: [i32; 2],
    fb_shift: i32,
    ampmodsens: [i32; 6],
    op_mode: [i32; 6],
    ampmoddepth: i32,
    algorithm: i32,
    pitchmoddepth: i32,
    pitchmodsens: i32,
    porta_curpitch: [i32; 6],
    note_offset: i32
}

impl Dx7Note {
    pub fn init(&mut self, patch: &[u8], midinote: i32, velocity: i32, note_offset: i32, rates: &NoteRates) {
        self.initialised = true;
        self.note_offset = note_offset;
        for op in 0..6 {
            let off = op * 21;
            let (rates4, levels4) = stage_values(patch, off);
            let mut outlevel = scaleoutlevel(patch[off + 16] as i32);
            let level_scaling = scale_level(midinote, patch[off + 8] as i32, patch[off + 9] as i32,
                                            patch[off + 10] as i32, patch[off + 11] as i32, patch[off + 12] as i32);
            outlevel += level_scaling;
            outlevel = outlevel.min(127);
            outlevel <<= 5;
            outlevel += scale_velocity(velocity, patch[off + 15] as i32);
            outlevel = outlevel.max(0);
            let rate_scaling = scale_rate(midinote, patch[off + 13] as i32);
            self.env[op].init(&rates4, &levels4, outlevel, rate_scaling, rates.sr_multiplier);
            let mode = patch[off + 17] as i32;
            let freq = osc_freq(midinote, mode, patch[off + 18] as i32, patch[off + 19] as i32, patch[off + 20] as i32, note_offset);
            self.op_mode[op] = mode;
            self.basepitch[op] = freq;
            self.porta_curpitch[op] = freq;
            self.ampmodsens[op] = AMPMODSENSTAB[(patch[off + 14] & 3) as usize] as i32;
        }
        let (pe_rates, pe_levels) = stage_values(patch, 126);
        self.pitchenv.set(&pe_rates, &pe_levels, rates.pitchenv_unit);
        self.set_globals(patch);
    }

    fn set_globals(&mut self, patch: &[u8]) {
        self.algorithm = patch[134] as i32;
        let feedback = patch[135] as i32;
        self.fb_shift = if feedback != 0 {FEEDBACK_BITDEPTH - feedback} else {16};
        self.pitchmoddepth = (patch[139] as i32 * 165) >> 6;
        self.pitchmodsens = PITCHMODSENSTAB[(patch[143] & 7) as usize] as i32;
        self.ampmoddepth = (patch[140] as i32 * 165) >> 6;
    }

    pub fn init_portamento(&mut self, src: &Dx7Note) {
        self.porta_curpitch = src.porta_curpitch;
    }

    pub fn compute(&mut self, buf: &mut [i32; N], lfo_val: i32, lfo_delay: i32, ctrls: &Controllers, tables: &Tables, porta: &Porta, core: &mut FmCore) {
        let pmd: u32 = (self.pitchmoddepth as u32).wrapping_mul(lfo_delay as u32);
        let senslfo = self.pitchmodsens.wrapping_mul(lfo_val - (1 << 23));
        let pmod_1 = (((pmd as i64) * (senslfo as i64)) >> 39) as i32;
        let pmod_1 = pmod_1.abs();
        let pmod_2 = (((ctrls.pitch_mod as i64) * (senslfo as i64)) >> 14) as i32;
        let pmod_2 = pmod_2.abs();
        let mut pitch_mod = pmod_1.max(pmod_2);
        pitch_mod = self.pitchenv.getsample().wrapping_add(pitch_mod * (if senslfo < 0 {-1} else {1}));
        let mut pb = ctrls.pitch_bend - 0x2000;
        if pb != 0 {
            if ctrls.pitch_step == 0 {
                let range = if pb >= 0 {ctrls.pitch_range_up} else {ctrls.pitch_range_dn};
                pb = (((pb << 11) as f32 * range as f32) as f64 / 12.0) as i32;
            } else {
                let stp = 12 / ctrls.pitch_step;
                pb = pb * stp / 8191;
                pb = (pb * (8191 / stp)) << 11;
            }
        }
        let pitch_base = pb + ctrls.master_tune;
        pitch_mod = pitch_mod.wrapping_add(pitch_base);
        let lfo_val = (1 << 24) - lfo_val;
        let amod_1 = ((self.ampmoddepth as i64 * lfo_delay as i64) >> 8) as u32;
        let amod_1 = ((amod_1 as i64 * lfo_val as i64) >> 24) as u32;
        let amod_2 = ((ctrls.amp_mod as i64 * lfo_val as i64) >> 7) as u32;
        let mut amd_mod = amod_1.max(amod_2);
        let amod_3 = ((ctrls.eg_mod + 1) << 17) as u32;
        amd_mod = (1u32 << 24).wrapping_sub(amod_3).max(amd_mod);
        let porta_rate = if ctrls.portamento_enable {
            let index = ctrls.portamento_cc.clamp(0, 127) as usize;
            if ctrls.portamento_gliss {porta.rates_glissando[index]} else {porta.rates[index]}
        } else {
            porta.rates[0]
        };
        for op in 0..6 {
            if !ctrls.op_switch[op] {
                self.env[op].getsample();
                self.params[op].level_in = 0;
            } else {
                let mut basepitch = self.basepitch[op];
                if self.op_mode[op] != 0 {
                    self.params[op].freq = tables.freq_lookup(basepitch.wrapping_add(pitch_base));
                } else {
                    if self.porta_curpitch[op] != self.basepitch[op] {
                        basepitch = self.porta_curpitch[op];
                        if ctrls.portamento_gliss {
                            basepitch = logfreq_round2semi(basepitch);
                        }
                        let cur = self.porta_curpitch[op];
                        let dst = self.basepitch[op];
                        let going_up = cur < dst;
                        let mut newpitch = cur + (if going_up {porta_rate} else {-porta_rate});
                        if (going_up && newpitch > dst) || (!going_up && newpitch < dst) {
                            newpitch = dst;
                        }
                        self.porta_curpitch[op] = newpitch;
                    }
                    self.params[op].freq = tables.freq_lookup(basepitch.wrapping_add(pitch_mod));
                }
                let mut level = self.env[op].getsample();
                if self.ampmodsens[op] != 0 {
                    let sensamp = (((amd_mod as u64) * (self.ampmodsens[op] as u64)) >> 24) as u32;
                    let pt = libm::exp(((sensamp as f32) / 262144.0f32) as f64 * 0.07 + 12.2) as u32;
                    let ldiff = (((level as u64) * ((pt as u64) << 4)) >> 28) as u32;
                    level = level.wrapping_sub(ldiff as i32);
                }
                self.params[op].level_in = level;
            }
        }
        core.render(tables, buf, &mut self.params, self.algorithm as usize, &mut self.fb_buf, self.fb_shift);
    }

    pub fn keyup(&mut self) {
        for env in self.env.iter_mut() {
            env.keydown(false);
        }
        self.pitchenv.keydown(false);
    }

    pub fn update(&mut self, patch: &[u8], midinote: i32, velocity: i32) {
        for op in 0..6 {
            let off = op * 21;
            let mode = patch[off + 17] as i32;
            self.basepitch[op] = osc_freq(midinote, mode, patch[off + 18] as i32, patch[off + 19] as i32, patch[off + 20] as i32, self.note_offset);
            self.ampmodsens[op] = AMPMODSENSTAB[(patch[off + 14] & 3) as usize] as i32;
            self.op_mode[op] = mode;
            let (rates4, levels4) = stage_values(patch, off);
            let mut outlevel = scaleoutlevel(patch[off + 16] as i32);
            let level_scaling = scale_level(midinote, patch[off + 8] as i32, patch[off + 9] as i32,
                                            patch[off + 10] as i32, patch[off + 11] as i32, patch[off + 12] as i32);
            outlevel += level_scaling;
            outlevel = outlevel.min(127);
            outlevel <<= 5;
            outlevel += scale_velocity(velocity, patch[off + 15] as i32);
            outlevel = outlevel.max(0);
            let rate_scaling = scale_rate(midinote, patch[off + 13] as i32);
            self.env[op].update(&rates4, &levels4, outlevel, rate_scaling);
        }
        self.set_globals(patch);
    }

    pub fn transfer_state(&mut self, src: &Dx7Note) {
        for i in 0..6 {
            self.env[i].transfer(&src.env[i]);
            self.params[i].gain_out = src.params[i].gain_out;
            self.params[i].phase = src.params[i].phase;
        }
    }

    pub fn transfer_signal(&mut self, src: &Dx7Note) {
        for i in 0..6 {
            self.params[i].gain_out = src.params[i].gain_out;
            self.params[i].phase = src.params[i].phase;
        }
    }

    pub fn transfer_phase(&mut self, src: &Dx7Note) {
        for i in 0..6 {
            self.params[i].phase = src.params[i].phase;
        }
    }

    pub fn osc_sync(&mut self) {
        for param in self.params.iter_mut() {
            param.gain_out = 0;
            param.phase = 0;
        }
    }

    pub fn is_playing(&self) -> bool {
        self.initialised && (0..6).any(|op| is_carrier(self.algorithm as usize, op) && self.env[op].is_active())
    }
}

fn stage_values(patch: &[u8], off: usize) -> ([i32; 4], [i32; 4]) {
    let mut rates = [0i32; 4];
    let mut levels = [0i32; 4];
    for i in 0..4 {
        rates[i] = patch[off + i] as i32;
        levels[i] = patch[off + 4 + i] as i32;
    }
    (rates, levels)
}

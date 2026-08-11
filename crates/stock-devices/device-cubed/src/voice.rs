use crate::generated::Cal;
use crate::tables::{read_cubic, MipTables, TABLE_SIZE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VegPhase {Idle, Delay, Rise, Decay, Hold, Fall}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub tuning: f64,
    pub waveform: f64,
    pub cutoff: f64,
    pub resonance: f64,
    pub envmod: f64,
    pub decay: f64,
    pub accent: f64,
    pub volume: f64
}

impl Default for Params {
    fn default() -> Self {
        Self {tuning: 0.5, waveform: 0.0, cutoff: 0.5, resonance: 0.5,
              envmod: 0.5, decay: 0.5, accent: 0.5, volume: 0.8}
    }
}

/// Both wavetable banks. ~160 KB and identical for every instance, so it is BORROWED into
/// `process_block` rather than owned per voice: the deployed cdylib is heap-free and the engine
/// owns all memory, and duplicating this per voice would be pure waste.
pub struct Tables {pub saw: MipTables, pub square: MipTables}

impl Tables {
    pub const fn zeroed() -> Self {Self {saw: MipTables::zeroed(), square: MipTables::zeroed()}}

    pub fn fill(&mut self, saw_amp: &[f64], saw_phase: &[f64], sq_amp: &[f64], sq_phase: &[f64]) {
        self.saw.fill(saw_amp, saw_phase);
        self.square.fill(sq_amp, sq_phase);
    }

    pub fn is_filled(&self) -> bool {self.saw.level_count > 0}
}

pub struct Voice303 {
    sample_rate: f64,
    pub cal: Cal,
    pub params: Params,
    phase: f64,
    current_semitone: f64,
    target_semitone: f64,
    sliding: bool,
    gate_on: bool,
    accented: bool,
    hp1_x1: f64,
    hp1_y1: f64,
    dv1: f64, dv2: f64, dv3: f64, dv4: f64,
    meg_value: f64,
    meg_time_ms: f64,
    cv_state: f64,
    ln_accent_smoothed: f64,
    veg_phase: VegPhase,
    veg_value: f64,
    veg_time_ms: f64,
    veg_level_at_release: f64,
    veg_fall_phase: f64,
    veg_rise_phase: f64,
    veg_note_ms: f64,
    wow_state: f64,
    accent_vca: f64,
    meg_vca: f64,
    veg_charge: f64,
    accent_charge: f64,
    accent_fire: f64,
    accent_time_ms: f64,
    // "undefined on first use" in the JS; the fallbacks below reproduce those first-block values
    mip_position: Option<f64>,
    ln_fc_now: Option<f64>,
    feedback: Option<f64>,
    gain_linear: Option<f64>,
    accent_vca_prev: Option<f64>,
    meg_vca_prev: Option<f64>,
    // written by update_control, read by process_block
    ln_fc_prev: f64,
    feedback_prev: f64,
    gain_prev: f64
}

impl Voice303 {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            cal: Cal::default(),
            params: Params::default(),
            phase: 0.0,
            current_semitone: 36.0,
            target_semitone: 36.0,
            sliding: false,
            gate_on: false,
            accented: false,
            hp1_x1: 0.0, hp1_y1: 0.0,
            dv1: 0.0, dv2: 0.0, dv3: 0.0, dv4: 0.0,
            meg_value: 0.0,
            meg_time_ms: 0.0,
            cv_state: 0.0,
            ln_accent_smoothed: 0.0,
            veg_phase: VegPhase::Idle,
            veg_value: 0.0,
            veg_time_ms: 0.0,
            veg_level_at_release: 0.0,
            veg_fall_phase: 0.0,
            veg_rise_phase: 0.0,
            veg_note_ms: 0.0,
            wow_state: 0.0,
            accent_vca: 0.0,
            meg_vca: 0.0,
            veg_charge: 1.0,
            accent_charge: 1.0,
            accent_fire: 1.0,
            accent_time_ms: 0.0,
            mip_position: None,
            ln_fc_now: None,
            feedback: None,
            gain_linear: None,
            accent_vca_prev: None,
            meg_vca_prev: None,
            ln_fc_prev: 0.0,
            feedback_prev: 0.0,
            gain_prev: 1.0
        }
    }

    pub fn note_on(&mut self, midi_note: f64, accent: bool, slide: bool) {
        self.target_semitone = midi_note;
        // slide holds the gate unbroken across the tie, so neither envelope retriggers; only the
        // pitch CV glides
        let retrigger = !(slide && self.gate_on);
        if retrigger {
            self.current_semitone = midi_note;
            self.sliding = false;
            self.meg_time_ms = 0.0;
            self.meg_value = 1.0;
            self.veg_time_ms = 0.0;
            self.veg_note_ms = 0.0;
            self.veg_rise_phase = 0.0;
            self.veg_phase = VegPhase::Delay;
        } else {
            self.sliding = true;
        }
        // per-step gate signal: follows THIS step's accent bit even across a tie
        self.accented = accent;
        // the accent cap is drained by EVERY gate retrigger; fire reads the charge BEFORE this
        // step's own depletion
        if accent {
            self.accent_fire = self.accent_charge;
            self.accent_time_ms = 0.0;
        }
        if retrigger || accent {
            self.accent_charge *= self.cal.accent_retain;
        }
        self.gate_on = true;
    }

    pub fn note_off(&mut self) {
        self.gate_on = false;
        self.veg_level_at_release = self.veg_value;
        self.veg_time_ms = 0.0;
        self.veg_fall_phase = 0.0;
        self.veg_phase = VegPhase::Hold;
    }

    fn update_control(&mut self, block_samples: usize) {
        let cal = self.cal;
        let par = self.params;
        let dt_ms = block_samples as f64 / self.sample_rate * 1000.0;
        self.meg_time_ms += dt_ms;

        // MEG: accent shorts the decay pot to its minimum, so accented decay is not free
        let decay_ms = if self.accented {
            cal.meg_decay_min_ms
        } else {
            cal.meg_decay_min_ms * libm::pow(cal.meg_decay_max_ms / cal.meg_decay_min_ms, par.decay)
        };
        // decay INCREMENTALLY: recomputing from absolute elapsed time makes the cutoff jump at a
        // tie where the accent state differs between steps
        self.meg_value *= libm::exp(-core::f64::consts::LN_2 * dt_ms / (decay_ms * 0.5));

        // accent RC: one cap, charge rate set by the resonance pot (the sweep pot is its 2nd gang)
        let charge_ms = cal.wow_charge_ms_min + cal.wow_charge_span_ms.max(0.0) * par.resonance;
        self.accent_time_ms += dt_ms;
        let pulse_on = self.accented && self.gate_on && self.accent_time_ms < cal.accent_pulse_ms;
        let wow_target = if pulse_on {1.0} else {0.0};
        let wow_tau = if wow_target > self.wow_state {charge_ms} else {cal.wow_discharge_ms};
        self.wow_state += (wow_target - self.wow_state) * (1.0 - libm::exp(-dt_ms / wow_tau));

        // cutoff CV summing node. The cutoff pot is a LINEAR taper whose wiper is loaded by the
        // node, so the voltage sags mid-travel while both endpoints stay put.
        let knob = par.cutoff;
        let warped = knob / (1.0 + cal.fc_pot_load * knob * (1.0 - knob));
        let ln_base = libm::log(cal.fc_min_hz) + libm::log(cal.fc_max_hz / cal.fc_min_hz) * warped;
        self.cv_state += (self.meg_value - self.cv_state) * (1.0 - libm::exp(-dt_ms / cal.cutoff_cv_rc_ms));
        // negative K makes the curve CONCAVE, so the sweep dwells high long enough to ring up
        let curved = if cal.env_curve_k.abs() > 0.01 {
            (libm::exp(cal.env_curve_k * self.cv_state) - 1.0) / (libm::exp(cal.env_curve_k) - 1.0)
        } else {
            self.cv_state
        };
        let mod_amount = cal.env_mod_residual + (1.0 - cal.env_mod_residual) * par.envmod;
        let ln_env = cal.env_mod_depth * mod_amount * curved - cal.env_mod_floor * par.envmod;
        let accent_knob = libm::pow(par.accent, cal.accent_knob_curve);
        // the cap that sags the VCA also feeds the cutoff node
        let accent_sag = libm::exp(-self.accent_time_ms / cal.accent_vca_decay_ms.max(1.0));
        let sweep_sag = 1.0 - cal.accent_sweep_sag + cal.accent_sweep_sag * accent_sag;
        // no accent GATE here: the cap is charged by a fire and then simply discharges. Gating on
        // this step's accent bit cuts the sweep off mid tie-chain and the accent re-articulates.
        let ln_accent_target = cal.wow_sweep_depth * accent_knob * self.wow_state * self.accent_fire * sweep_sag;
        self.ln_accent_smoothed += (ln_accent_target - self.ln_accent_smoothed)
            * (1.0 - libm::exp(-dt_ms / cal.cutoff_cv_rc_ms));
        let ln_accent = self.ln_accent_smoothed;
        let ln_fc = ln_base + ln_env + ln_accent;
        let fc = (0.45 * self.sample_rate).min(libm::exp(ln_fc).max(20.0));

        // keep the cutoff in the LOG domain across the block; linear coefficient interpolation
        // makes fast sweeps sound stepped
        let fc_clamped = (0.45 * self.sample_rate).min(fc);
        self.ln_fc_prev = self.ln_fc_now.unwrap_or_else(|| libm::log(fc_clamped));
        self.ln_fc_now = Some(libm::log(fc_clamped));
        let skew = (1.0 - libm::exp(-cal.res_skew * par.resonance)) / (1.0 - libm::exp(-cal.res_skew));
        self.feedback_prev = self.feedback.unwrap_or(0.0);
        // loop gain FALLS as the filter opens: the ladder's dynamic resistance is set by the same
        // control current as the cutoff, so a wide-open filter cannot ring as hard as a closed one
        let fc_span = libm::log(fc.max(20.0) / cal.fc_min_hz) / libm::log(cal.fc_max_hz / cal.fc_min_hz);
        let res_fall = 1.0 - cal.res_cut_falloff * fc_span.min(1.0).max(0.0);
        let feedback = cal.res_k1 * skew * res_fall;
        self.feedback = Some(feedback);
        self.gain_prev = self.gain_linear.unwrap_or(1.0);
        let knob_equivalent = libm::log(fc.max(20.0) / cal.fc_min_hz) / libm::log(cal.fc_max_hz / cal.fc_min_hz);
        let tilt = cal.gain_tilt_db
            * ((cal.gain_tilt_knee - knob_equivalent) / cal.gain_tilt_knee.max(0.05)).max(0.0);
        let res_comp = 1.0 + cal.res_makeup * feedback;
        self.gain_linear = Some(libm::pow(10.0, (cal.out_gain_db + tilt) / 20.0) * res_comp);

        // the release LENGTHENS as the resonance pot closes
        let fall_ms = (cal.veg_fall_ms * (1.0 + cal.veg_fall_res_depth * (1.0 - par.resonance))).max(0.05);
        let release_mul = libm::pow(10.0, -60.0 / 20.0 * dt_ms / fall_ms.max(0.05));
        // the accent's sustained tail is largely the RESONANT RING, so it scales with loop gain
        let loop_frac = if cal.res_k1 > 1e-6 {(feedback / cal.res_k1).min(1.0).max(0.0)} else {0.0};
        let accent_rel_ms = fall_ms.max(cal.accent_release_ms * loop_frac);
        let accent_release_mul = libm::pow(10.0, -60.0 / 20.0 * dt_ms / accent_rel_ms.max(0.05));
        let accent_target = if self.accented && self.gate_on {
            libm::pow(par.accent, cal.accent_knob_curve) * cal.accent_vca_depth * self.accent_fire * accent_sag
        } else {
            0.0
        };
        // additive on top of the DEPLETED envelope, but it must still collapse when the note ends.
        // Hold through the VEG's hold stage, then fall WITH it - switching at the gate edge is a
        // derivative discontinuity heard as a click at gateFraction * step.
        if self.gate_on {
            self.accent_vca += (accent_target - self.accent_vca)
                * (1.0 - libm::exp(-dt_ms / cal.accent_vca_rc_ms.max(0.05)));
        } else if self.veg_phase != VegPhase::Hold {
            self.accent_vca *= accent_release_mul;
        }
        // the MEG reaches the VCA through that SAME node, so it cannot step either
        let meg_vca_target = cal.meg_to_vca_depth * self.meg_value
            * if self.veg_phase == VegPhase::Idle {0.0} else {1.0};
        if self.gate_on {
            self.meg_vca += (meg_vca_target - self.meg_vca)
                * (1.0 - libm::exp(-dt_ms / cal.accent_vca_rc_ms.max(0.05)));
        } else if self.veg_phase != VegPhase::Hold {
            self.meg_vca *= release_mul;
        }
    }

    pub fn process_block(&mut self, tables: &Tables, output: &mut [f32], offset: usize, length: usize) {
        if !tables.is_filled() {
            for slot in output[offset..offset + length].iter_mut() {*slot = 0.0;}
            return;
        }
        let cal = self.cal;
        let par = self.params;
        self.update_control(length);
        let table_set = if par.waveform < 0.5 {&tables.saw} else {&tables.square};
        let tuning_semis = (par.tuning - 0.5) * 24.0;
        let slide_alpha = 1.0 - libm::exp(-1000.0 / (cal.slide_tau_ms * self.sample_rate));
        let hp_pole = libm::exp(-2.0 * core::f64::consts::PI * cal.coupling_hp_hz / self.sample_rate);
        let hp_gain = (1.0 + hp_pole) / 2.0;
        let sample_ms = 1000.0 / self.sample_rate;
        let veg_rise_step = 1.0 - libm::exp(-3000.0 / (cal.veg_rise_ms.max(0.05) * self.sample_rate));
        let veg_rise_ease = sample_ms / (0.35 * cal.veg_rise_ms).max(0.2);
        // accented notes bypass the decay pot
        let decay_seconds = if self.accented {cal.accent_decay_seconds} else {cal.veg_decay_seconds};
        let veg_decay_mul = libm::exp(-1.0 / (decay_seconds * self.sample_rate));
        let veg_droop_mul = libm::pow(10.0, -cal.veg_droop_db_per_s / 20.0 / self.sample_rate) * veg_decay_mul;
        let fall_ms = (cal.veg_fall_ms * (1.0 + cal.veg_fall_res_depth * (1.0 - par.resonance))).max(0.05);
        let veg_release_mul = libm::pow(10.0, -60.0 / 20.0 * sample_ms / fall_ms);
        let veg_ease_step = sample_ms / 1.0;
        let veg_recharge_step = 1.0 - libm::exp(-1000.0 / (cal.veg_recharge_ms.max(1.0) * self.sample_rate));
        let mip_slew = 1.0 - libm::exp(-1000.0 / (2.0 * self.sample_rate));
        let gain_prev = self.gain_prev;
        let accent_vca_prev = self.accent_vca_prev.unwrap_or(self.accent_vca);
        self.accent_vca_prev = Some(self.accent_vca);
        let meg_vca_prev = self.meg_vca_prev.unwrap_or(self.meg_vca);
        self.meg_vca_prev = Some(self.meg_vca);
        let ln_prev = self.ln_fc_prev;
        let ln_now = self.ln_fc_now.unwrap();
        let k_prev = self.feedback_prev;
        let feedback = self.feedback.unwrap();
        let gain_linear = self.gain_linear.unwrap();

        // Hoists, all EXACT: each recomputes whenever its input can change, so the arithmetic and
        // its ORDER are untouched and the parity gate still holds. Worth doing because every one of
        // these is a SOFTWARE transcendental on wasm - there is no hardware pow/tan/log2 - and at
        // 48kHz they dominate the per-sample cost.
        //
        // Pitch only moves while sliding, so a non-gliding note pays pow+log2 once per block.
        let mut cached_pitch: Option<(f64, f64)> = None;
        // The cutoff only moves when the block's endpoints differ; a static filter then costs one
        // exp+tan per block instead of one per sample.
        let static_g = if ln_prev == ln_now {
            Some(libm::tan(core::f64::consts::PI * (0.45 * self.sample_rate)
                .min(libm::exp(ln_now)) / self.sample_rate))
        } else {
            None
        };
        for i in 0..length {
            if self.sliding {
                self.current_semitone += (self.target_semitone - self.current_semitone) * slide_alpha;
                cached_pitch = None;
            }
            let (frequency, mip_target) = match cached_pitch {
                Some(cached) => cached,
                None => {
                    let frequency = 440.0 * libm::pow(2.0, (self.current_semitone - 69.0 + tuning_semis) / 12.0);
                    let max_harmonic = (0.45 * self.sample_rate / frequency).max(1.0);
                    let mip_target = libm::log2(table_set.counts[0] as f64 / max_harmonic)
                        .min((table_set.level_count - 1) as f64).max(0.0);
                    cached_pitch = Some((frequency, mip_target));
                    (frequency, mip_target)
                }
            };
            // slew the mip selection: two differently bandlimited tables do not agree at the same
            // phase, so switching them on a pitch jump steps the waveform
            if self.mip_position.is_none() {self.mip_position = Some(mip_target);}
            let mut mip_position = self.mip_position.unwrap();
            mip_position += (mip_target - mip_position) * mip_slew;
            self.mip_position = Some(mip_position);
            let mip_index = mip_position as usize;
            let mip_fraction = mip_position - mip_index as f64;
            let position = self.phase * TABLE_SIZE as f64;
            let index = position as usize;
            let fraction = position - index as f64;
            let rich = read_cubic(&table_set.levels[mip_index], index, fraction);
            let oscillator = if mip_fraction > 0.0 && mip_index + 1 < table_set.level_count {
                rich * (1.0 - mip_fraction) + read_cubic(&table_set.levels[mip_index + 1], index, fraction) * mip_fraction
            } else {
                rich
            };
            self.phase += frequency / self.sample_rate;
            if self.phase >= 1.0 {self.phase -= 1.0;}

            // VEG: delay, rise, fixed slow decay while held, then hold and a fall at note-off
            self.veg_time_ms += sample_ms;
            match self.veg_phase {
                VegPhase::Delay => {
                    if self.veg_time_ms >= cal.veg_delay_ms {self.veg_phase = VegPhase::Rise;}
                }
                VegPhase::Rise => {
                    // ease the attack IN the way the release eases out; a straight start is a slope
                    // jump at the end of vegDelayMs and ticks on every note
                    self.veg_rise_phase = (self.veg_rise_phase + veg_rise_ease).min(1.0);
                    let rise_ease = self.veg_rise_phase * self.veg_rise_phase * (3.0 - 2.0 * self.veg_rise_phase);
                    self.veg_value += (self.veg_charge - self.veg_value) * veg_rise_step * rise_ease;
                    if self.veg_value > self.veg_charge - 1e-4 {
                        self.veg_value = self.veg_charge;
                        self.veg_phase = VegPhase::Decay;
                    }
                }
                VegPhase::Decay => {
                    self.veg_note_ms += sample_ms;
                    self.veg_value *= if self.veg_note_ms < cal.veg_droop_ms {veg_droop_mul} else {veg_decay_mul};
                    self.veg_charge = self.veg_value;
                }
                VegPhase::Hold => {
                    if self.veg_time_ms >= cal.veg_hold_ms {
                        self.veg_phase = VegPhase::Fall;
                        self.veg_time_ms = 0.0;
                    }
                }
                VegPhase::Fall => {
                    // ease the release IN over its first millisecond; the exponential itself is
                    // fast-then-slow by construction and never steps
                    self.veg_fall_phase = (self.veg_fall_phase + veg_ease_step).min(1.0);
                    let ease = self.veg_fall_phase * self.veg_fall_phase * (3.0 - 2.0 * self.veg_fall_phase);
                    self.veg_value *= 1.0 + (veg_release_mul - 1.0) * ease;
                    if self.veg_value <= self.veg_level_at_release * 1e-4 || self.veg_value < 1e-7 {
                        self.veg_value = 0.0;
                        self.veg_phase = VegPhase::Idle;
                    }
                }
                VegPhase::Idle => {}
            }
            if !self.gate_on {
                self.veg_charge += (1.0 - self.veg_charge) * veg_recharge_step;
                self.accent_charge += (1.0 - self.accent_charge) * veg_recharge_step;
            }

            let wave_scaled = if par.waveform < 0.5 {oscillator} else {oscillator * cal.square_input_scale};
            let hp_out = hp_gain * (wave_scaled - self.hp1_x1) + hp_pole * self.hp1_y1;
            self.hp1_x1 = wave_scaled;
            self.hp1_y1 = hp_out;

            // spread ladder: four one-pole sections at a geometric spread, solved for the
            // instantaneous feedback loop
            let blend = (i + 1) as f64 / length as f64;
            let g = match static_g {
                Some(value) => value,
                None => libm::tan(core::f64::consts::PI * (0.45 * self.sample_rate)
                    .min(libm::exp(ln_prev + (ln_now - ln_prev) * blend)) / self.sample_rate)
            };
            let k = k_prev + (feedback - k_prev) * blend;
            let r = cal.pole_spread_ratio;
            let g1 = g; let g2 = g * r; let g3 = g2 * r; let g4 = g3 * r;
            let i1 = 1.0 / (1.0 + g1); let i2 = 1.0 / (1.0 + g2);
            let i3 = 1.0 / (1.0 + g3); let i4 = 1.0 / (1.0 + g4);
            let h1 = g1 * i1; let h2 = g2 * i2; let h3 = g3 * i3; let h4 = g4 * i4;
            let c1 = self.dv1 * i1; let c2 = self.dv2 * i2;
            let c3 = self.dv3 * i3; let c4 = self.dv4 * i4;
            let loop_gain = h1 * h2 * h3 * h4;
            let ff = loop_gain * hp_out + h2 * h3 * h4 * c1 + h3 * h4 * c2 + h4 * c3 + c4;
            let y4lin = ff / (1.0 + k * loop_gain);
            let drive = cal.diode_sat_drive;
            let u1 = hp_out - k * (libm::tanh(y4lin * drive) / drive);
            let y1 = h1 * u1 + c1;
            let y2 = h2 * y1 + c2;
            let y3 = h3 * y2 + c3;
            let y4 = h4 * y3 + c4;
            self.dv1 = 2.0 * y1 - self.dv1;
            self.dv2 = 2.0 * y2 - self.dv2;
            self.dv3 = 2.0 * y3 - self.dv3;
            self.dv4 = 2.0 * y4 - self.dv4;
            // every control-rate term feeding the VCA is interpolated per sample, else the gain
            // staircases at the block rate
            let gain_l = gain_prev + (gain_linear - gain_prev) * blend;
            let accent_l = accent_vca_prev + (self.accent_vca - accent_vca_prev) * blend;
            let meg_l = meg_vca_prev + (self.meg_vca - meg_vca_prev) * blend;
            output[offset + i] = (y4 * gain_l * (self.veg_value + accent_l + meg_l + cal.vca_leak) * par.volume) as f32;
        }
    }
}

//! Bowed modal bank (glass harmonica / bowed vibe / friction drum / bowed wire). MSW friction
//! with a semi-implicit scalar solve against impulse-invariant force→displacement modes (exact
//! two-tap velocity readout — no half-sample lag, no chatter). The playability layer makes it an
//! instrument: pitch-anchored tables, a gated grip band around the note (harmonic-series comb for
//! wire, capped at 8 harmonics), an anchor-shape floor, a zero-crossing pitch servo that tunes in
//! like a player's finger then freezes, sub-lock recovery (lighten the bow out of period
//! doubling), and a living bow: speed drift + tremor, bow-change dips, attack dig-in, rosin grit
//! in the force plus a direct band-noise halo, delayed wandering vibrato with per-mode AM,
//! per-mode decorrelated shimmer, release re-damping, keyboard-compensated soft-clipped output.

use libm::{cosf, expf, fabsf, powf, sinf, sqrtf};

use crate::engine::driven::t60_scale;
use crate::engine::tables::{spec, Material};

const PI: f32 = core::f32::consts::PI;
const LN1000: f32 = 6.9077554;
pub const MAX_BOW_MODES: usize = 40;
const MAX_CANDIDATES: usize = 64;

#[derive(Clone, Copy)]
struct BowMode {
    base_theta: f32,
    r: f32,
    gamma: f32,
    b1: f32,
    b2: f32,
    force_gain: f32,
    cv1: f32,
    cv2: f32,
    phi: f32,
    tap_l: f32,
    tap_r: f32,
    pan_offset: f32,
    amp: f32,
    shim_state: f32,
    shim: f32,
    vib_am_sin: f32,
    vib_am_cos: f32,
    y1: f32,
    y2: f32,
}

const SILENT_MODE: BowMode = BowMode {base_theta: 0.1, r: 0.0, gamma: 1.0, b1: 0.0, b2: 0.0,
    force_gain: 0.0, cv1: 0.0, cv2: 0.0, phi: 0.0, tap_l: 0.0, tap_r: 0.0, pan_offset: 0.0,
    amp: 0.0, shim_state: 0.0, shim: 1.0, vib_am_sin: 0.0, vib_am_cos: 0.0, y1: 0.0, y2: 0.0};

#[derive(Clone, Copy)]
struct Candidate {
    frequency: f32,
    t60: f32,
    phi: f32,
    amp: f32,
    pan_offset: f32,
    keep: bool,
    is_anchor: bool,
}

const NO_CANDIDATE: Candidate = Candidate {frequency: 0.0, t60: 0.1, phi: 0.0, amp: 0.0,
    pan_offset: 0.0, keep: false, is_anchor: false};

#[inline]
fn dc_block(state: &mut (f32, f32), value: f32) -> f32 {
    let output = value - state.0 + 0.995 * state.1;
    state.0 = value;
    state.1 = output;
    output
}

fn realize(frequency: f32, t60: f32, phi: f32, phi_inject: f32, amp: f32, pan_offset: f32,
           width: f32, sample_rate: f32) -> BowMode {
    let w = 2.0 * PI * frequency;
    let gamma = LN1000 / t60;
    let theta = w / sample_rate;
    let r = expf(-gamma / sample_rate);
    let (s, c) = (sinf(theta), cosf(theta));
    let g = r * s / (w * sample_rate); // impulse-invariant force→displacement, m = 1
    let hash = frequency.to_bits().wrapping_mul(2654435761) >> 8;
    let phase = hash as f32 / 16777216.0 * 2.0 * PI;
    let depth = 0.15 + 0.25 * ((hash >> 4 & 0xff) as f32 / 255.0);
    let pan = (0.5 + pan_offset * width).clamp(0.05, 0.95);
    BowMode {
        base_theta: theta,
        r,
        gamma,
        b1: 2.0 * r * c,
        b2: -r * r,
        force_gain: g * phi_inject,
        cv1: w * c / s - gamma,
        cv2: -w * r / s,
        phi,
        tap_l: amp * sqrtf(1.0 - pan),
        tap_r: amp * sqrtf(pan),
        pan_offset,
        amp,
        shim_state: 0.0,
        shim: 1.0,
        vib_am_sin: depth * sinf(phase),
        vib_am_cos: depth * cosf(phase),
        y1: 0.0,
        y2: 0.0,
    }
}

pub struct BowState {
    modes: [BowMode; MAX_BOW_MODES],
    count: usize,
    anchor_slot: usize,
    f0: f32,
    sample_rate: f32,
    tune_ratio: f32,
    servo_error_lp: f32,
    cross_age: u32,
    period_sum: f32,
    period_count: u32,
    anchor_prev: f32,
    admittance: f32,
    bow_velocity: f32,
    bow_target: f32,
    slope: f32,
    force_scale: f32,
    force_max: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    gate: bool,
    contact: f32,
    drift_state: f32,
    tremor_sin: f32,
    tremor_cos: f32,
    tremor_rot: (f32, f32),
    noise_state: u32,
    rosin_lp: f32,
    rosin_hp: f32,
    rosin_lp2: f32,
    rosin_hp2: f32,
    tone_env: f32,
    attack_boost: f32,
    vibrato_depth: f32,
    vib_sin: f32,
    vib_cos: f32,
    vib_rot: (f32, f32),
    vib_ramp: f32,
    servo_locked: bool,
    servo_stable: u32,
    sub_lock_count: u32,
    force_floor: f32,
    released_damped: bool,
    grit: f32,
    halo_gain: f32,
    jitter_walk: f32,
    rate_walk: f32,
    stroke_timer: f32,
    stroke_dip: f32,
    age: f32,
    dc_l: (f32, f32),
    dc_r: (f32, f32),
    out_gain: f32,
    admittance_full: f32,
    force_trim: f32,
    live_pressure: f32,
    live_t60_ratio: f32,
    live_width: f32,
    live_freq_ratio: f32,
    last_retune: f32,
}

impl BowState {
    pub const fn silent() -> Self {
        Self {modes: [SILENT_MODE; MAX_BOW_MODES], count: 0, anchor_slot: 0, f0: 220.0,
            sample_rate: 48_000.0, tune_ratio: 1.0, servo_error_lp: 0.0, cross_age: 0,
            period_sum: 0.0, period_count: 0, anchor_prev: 0.0, admittance: 1.0e-5,
            bow_velocity: 0.0, bow_target: 0.0, slope: 4.0, force_scale: 0.0, force_max: 0.0,
            attack_coefficient: 0.001, release_coefficient: 0.001, gate: false, contact: 0.0,
            drift_state: 0.0, tremor_sin: 0.0, tremor_cos: 1.0, tremor_rot: (0.0, 1.0),
            noise_state: 0x3c6ef372, rosin_lp: 0.0, rosin_hp: 0.0, rosin_lp2: 0.0, rosin_hp2: 0.0,
            tone_env: 0.0, attack_boost: 1.0, vibrato_depth: 0.0, vib_sin: 0.0, vib_cos: 1.0,
            vib_rot: (0.0, 1.0), vib_ramp: 0.0, servo_locked: false, servo_stable: 0,
            sub_lock_count: 0, force_floor: 0.0, released_damped: false, grit: 1.0,
            halo_gain: 0.0, jitter_walk: 0.0, rate_walk: 0.0, stroke_timer: 2.4, stroke_dip: 0.0,
            age: 0.0, dc_l: (0.0, 0.0), dc_r: (0.0, 0.0), out_gain: 1.0, admittance_full: 1.0e-5,
            force_trim: 1.0, live_pressure: 0.5, live_t60_ratio: 1.0, live_width: 1.0,
            live_freq_ratio: 1.0, last_retune: 1.0}
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start(&mut self, material: Material, f0: f32, velocity: f32, pressure: f32,
                 position_knob: f32, damping: f32, width: f32, vibrato: f32, sample_rate: f32) {
        // Pitch anchor: the table ratio nearest 1.0 sits exactly at the played note.
        let mut anchor = 1.0f32;
        let mut anchor_error = f32::INFINITY;
        let mut table_index = 0;
        while let Some(mode) = spec(material, table_index) {
            let error = fabsf(mode.ratio - 1.0);
            if error < anchor_error {
                anchor_error = error;
                anchor = mode.ratio;
            }
            table_index += 1;
        }
        let pressure_gain = 0.2 + 0.5 * pressure;
        let t60_boost = t60_scale(damping) * 3.0; // bowing feeds on Q
        let position = 0.06 + 0.88 * position_knob;
        let harmonic_series = material.harmonic_series();
        let mut seed = 0x51ed270bu32;
        let mut raw = [NO_CANDIDATE; MAX_CANDIDATES];
        let mut raw_count = 0;
        let mut index = 0;
        while let Some(mode) = spec(material, index) {
            let table_slot = index;
            index += 1;
            if raw_count == MAX_CANDIDATES {
                break;
            }
            let ratio = mode.ratio / anchor;
            let frequency = f0 * ratio;
            if frequency < 25.0 || frequency > sample_rate * 0.4 {
                continue;
            }
            // Grip band: off-band modes are gated out of the friction loop (dense partial sets
            // pull chaotic multi-mode locks). Harmonic-series materials grip the first 8
            // harmonics as a comb — a bowed string entrains its whole series, and gripping all
            // 40 spreads the bow's energy so thin the string never speaks in tempo.
            let bump = if harmonic_series {
                let nearest = libm::roundf(ratio).max(1.0);
                if nearest > 8.0 {
                    0.0
                } else {
                    let detuning = (ratio - nearest) / 0.12;
                    1.0 / (1.0 + detuning * detuning)
                }
            } else {
                let detuning = (frequency - f0) / (0.18 * f0);
                1.0 / (1.0 + detuning * detuning)
            };
            let keep = bump * bump >= 0.3;
            let is_anchor = fabsf(ratio - 1.0) < 1.0e-4;
            let t60 = (mode.t60 * t60_boost * powf(f0 * 1.6 / frequency, 0.5)).max(0.05);
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let magnitude = 0.4 + 0.6 * ((seed >> 8) as f32 / 16777216.0);
            let sign = if seed & 0x10000 != 0 {1.0} else {-1.0};
            let mut phi = sinf((table_slot as f32 + 1.0) * PI * position) * magnitude * sign;
            // The player can always grip the note's own mode a little — no dead spots when the
            // bow position lands on the anchor's node.
            if is_anchor && fabsf(phi) < 0.35 {
                phi = 0.35 * sign;
            }
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let rand = (seed >> 8) as f32 / 16777216.0;
            let side = if table_slot % 2 == 0 {1.0} else {-1.0};
            let pan_offset = side * (0.1 + 0.3 * rand);
            raw[raw_count] = Candidate {frequency, t60, phi, amp: mode.amp, pan_offset, keep,
                is_anchor};
            raw_count += 1;
        }
        // phi normalization and the reference admittance run over ALL candidates so gating does
        // not shift the anchor's calibrated coupling strength.
        let mut phi_sum = 0.0f32;
        for candidate in raw[..raw_count].iter() {
            phi_sum += candidate.phi * candidate.phi;
        }
        let phi_norm = sqrtf(phi_sum.max(1.0e-6));
        let mut count = 0;
        let mut anchor_slot = 0;
        let mut admittance = 0.0f32;
        let mut admittance_full = 0.0f32;
        for candidate in raw[..raw_count].iter() {
            let phi = candidate.phi / phi_norm;
            let probe = realize(candidate.frequency, candidate.t60, phi, phi, candidate.amp,
                candidate.pan_offset, width, sample_rate);
            // Drive-point admittance terms computed directly (g = r·sinθ/(ω·fs), m = 1).
            let w = 2.0 * PI * candidate.frequency;
            let theta = w / sample_rate;
            let gamma = LN1000 / candidate.t60;
            let r = expf(-gamma / sample_rate);
            let g = r * sinf(theta) / (w * sample_rate);
            // Near-Nyquist modes have cos(theta) < 0 and would cancel the sum — a discretization
            // artifact, not physics; clamp each admittance term to non-negative.
            let term = (phi * phi * probe.cv1 * g).max(0.0);
            admittance_full += term;
            if !candidate.keep || count + 2 > MAX_BOW_MODES {
                continue;
            }
            admittance += term;
            if candidate.is_anchor {
                anchor_slot = count;
            }
            self.modes[count] = probe;
            count += 1;
            // Detuned doublet partner: invisible to the friction solve (phi = 0), weakly
            // injected — the bow cannot entrain it, so it rings sympathetically at its own
            // detuned frequency against the entrained primary. Shimmer DURING sustain.
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let detune = 1.0015 + 0.0035 * ((seed >> 8) as f32 / 16777216.0);
            self.modes[count] = realize(candidate.frequency * detune, candidate.t60 * 0.8, 0.0,
                phi * 0.12, candidate.amp * 0.85, -candidate.pan_offset, width, sample_rate);
            count += 1;
        }
        self.count = count;
        self.anchor_slot = anchor_slot;
        self.f0 = f0;
        self.sample_rate = sample_rate;
        // Strings barely flatten (multi-mode Helmholtz); the idiophone warm-start would push
        // them sharp and make the servo walk back down.
        let warm_cents = if harmonic_series {0.0}
            else {(40.0 + 460.0 * (pressure_gain - 0.3)).clamp(0.0, 260.0)};
        self.tune_ratio = powf(2.0, warm_cents / 1200.0).clamp(1.0, 1.16);
        self.servo_error_lp = 0.0;
        self.cross_age = 0;
        self.period_sum = 0.0;
        self.period_count = 0;
        self.anchor_prev = 0.0;
        self.admittance = admittance;
        self.bow_velocity = 0.0;
        self.bow_target = 0.06 + 0.10 * velocity;
        self.slope = 5.5 - 3.0 * pressure;
        self.admittance_full = admittance_full.max(1.0e-9);
        self.force_trim = 1.0;
        self.force_scale = pressure_gain / self.admittance_full;
        self.force_floor = 0.22 * self.force_scale;
        self.force_max = 1.5 * self.force_scale * self.bow_target;
        self.live_pressure = pressure;
        self.live_t60_ratio = 1.0;
        self.live_width = width;
        self.live_freq_ratio = 1.0;
        self.last_retune = self.tune_ratio;
        self.attack_coefficient =
            1.0 - expf(-1.0 / ((0.12 + 0.45 * (1.0 - velocity)) * sample_rate));
        self.release_coefficient = 1.0 - expf(-1.0 / (0.09 * sample_rate));
        self.gate = true;
        self.contact = 0.0;
        self.drift_state = 0.0;
        self.tremor_sin = 0.0;
        self.tremor_cos = 1.0;
        let tremor_angle = 2.0 * PI * 5.3 / sample_rate;
        self.tremor_rot = (sinf(tremor_angle), cosf(tremor_angle));
        self.rosin_lp = 0.0;
        self.rosin_hp = 0.0;
        self.rosin_lp2 = 0.0;
        self.rosin_hp2 = 0.0;
        self.tone_env = 0.0;
        self.attack_boost = 1.35;
        self.vibrato_depth = vibrato * 0.009; // up to ±15.6 cents at full knob
        self.vib_sin = 0.0;
        self.vib_cos = 1.0;
        let vib_angle = 2.0 * PI * 5.9 / sample_rate;
        self.vib_rot = (sinf(vib_angle), cosf(vib_angle));
        self.vib_ramp = 0.0;
        self.servo_locked = false;
        self.servo_stable = 0;
        self.sub_lock_count = 0;
        self.released_damped = false;
        self.grit = 0.6 + 1.1 * pressure;
        self.halo_gain = 0.06 * (0.5 + 1.4 * pressure);
        self.jitter_walk = 0.0;
        self.rate_walk = 0.0;
        self.stroke_timer = 2.4;
        self.stroke_dip = 0.0;
        self.age = 0.0;
        self.dc_l = (0.0, 0.0);
        self.dc_r = (0.0, 0.0);
        // Velocity output scales with omega — flatten the keyboard. The harmonic comb sums
        // eight gripped partials, so wire runs far hotter than single-band idiophones.
        let series_trim = if harmonic_series {0.24} else {1.0};
        self.out_gain = 0.82 * series_trim * powf(220.0 / f0, 0.6);
        for mode in self.modes[..self.count].iter_mut() {
            mode.y1 = 0.0;
            mode.y2 = 0.0;
        }
    }

    pub fn release(&mut self) {
        self.gate = false;
        if !self.released_damped {
            self.released_damped = true;
            self.last_retune = self.tune_ratio;
            // The bow fed on tripled Q; the free instrument rings at its natural T60.
            for mode in self.modes[..self.count].iter_mut() {
                let gamma = mode.gamma * 3.0;
                let r = expf(-gamma / self.sample_rate);
                let theta = (mode.base_theta * self.tune_ratio).clamp(1.0e-4, 2.4);
                let (s, c) = (sinf(theta), cosf(theta));
                let w = theta * self.sample_rate;
                mode.gamma = gamma;
                mode.r = r;
                mode.b1 = 2.0 * r * c;
                mode.b2 = -r * r;
                mode.cv1 = w * c / s - gamma;
                mode.cv2 = -w * r / s;
            }
        }
    }

    /// Live knob feedback on a sounding bow: pressure, damping, width, tune and vibrato act on
    /// the note in flight. Scalars are cheap; per-mode loops run only while a knob is moving.
    /// The caller hands in already-smoothed values (freq/t60 as ratios, width absolute).
    pub fn refresh(&mut self, pressure: f32, t60_ratio: f32, width: f32, freq_ratio: f32,
                   vibrato: f32) {
        self.vibrato_depth = vibrato * 0.009;
        if fabsf(pressure - self.live_pressure) > 1.0e-4 {
            self.live_pressure = pressure;
            let pressure_gain = 0.2 + 0.5 * pressure;
            self.slope = 5.5 - 3.0 * pressure;
            self.grit = 0.6 + 1.1 * pressure;
            self.halo_gain = 0.06 * (0.5 + 1.4 * pressure);
            let base_scale = pressure_gain / self.admittance_full;
            self.force_scale = base_scale * self.force_trim;
            self.force_floor = 0.22 * base_scale;
            self.force_max = 1.5 * base_scale * self.bow_target;
        }
        if fabsf(freq_ratio - self.live_freq_ratio) > 1.0e-4 {
            let factor = freq_ratio / self.live_freq_ratio;
            self.live_freq_ratio = freq_ratio;
            self.f0 *= factor;
            // The stored theta stays exact (no clamp) so an up-down sweep returns home; every
            // realization site clamps the effective theta instead.
            for mode in self.modes[..self.count].iter_mut() {
                mode.base_theta *= factor;
            }
            self.resync_modes();
        }
        if fabsf(t60_ratio - self.live_t60_ratio) > 1.0e-4 {
            let factor = self.live_t60_ratio / t60_ratio; // gamma ∝ 1/T60
            self.live_t60_ratio = t60_ratio;
            for mode in self.modes[..self.count].iter_mut() {
                mode.gamma *= factor;
                mode.r = expf(-mode.gamma / self.sample_rate);
            }
            self.resync_modes();
        }
        if fabsf(width - self.live_width) > 1.0e-4 {
            self.live_width = width;
            for mode in self.modes[..self.count].iter_mut() {
                let pan = (0.5 + mode.pan_offset * width).clamp(0.05, 0.95);
                mode.tap_l = mode.amp * sqrtf(1.0 - pan);
                mode.tap_r = mode.amp * sqrtf(pan);
            }
        }
    }

    /// Re-derives b1/b2/cv from the current theta, r and gamma — needed outside the servo's own
    /// per-chunk pass, which only runs while the bow is in contact. Uses the servo's last full
    /// retune (tuning + vibrato + jitter) so a moving knob does not suspend the vibrato.
    fn resync_modes(&mut self) {
        for mode in self.modes[..self.count].iter_mut() {
            let theta = (mode.base_theta * self.last_retune).clamp(1.0e-4, 2.4);
            let (s, c) = (sinf(theta), cosf(theta));
            let w = theta * self.sample_rate;
            mode.b1 = 2.0 * mode.r * c;
            mode.b2 = -mode.r * mode.r;
            mode.cv1 = w * c / s - mode.gamma;
            mode.cv2 = -w * mode.r / s;
        }
    }

    /// The MSW flattening pull depends on material, pitch and pressure; instead of fitting it,
    /// count the anchor mode's oscillation period (positive-going zero crossings — immune to the
    /// non-sinusoidal stick-phase waveform, accumulated ACROSS chunks since a period can span
    /// several) and retune the gripped modes toward f0 like a player fingering into tune.
    fn servo_update(&mut self, chunk_len: usize) {
        if !self.gate || self.contact < 0.8 {
            self.period_sum = 0.0;
            self.period_count = 0;
            return;
        }
        if self.period_count >= 4 {
            let f_sung = self.sample_rate * self.period_count as f32 / self.period_sum;
            self.period_sum = 0.0;
            self.period_count = 0;
            let error = (self.f0 - f_sung) / self.f0;
            let sub_ratio = f_sung / self.f0;
            if (0.25..0.82).contains(&sub_ratio) {
                // Sub-multiple lock (period doubling): the servo cannot retune out of it —
                // lighten the bow until the note speaks, like a player would.
                self.sub_lock_count += 1;
                if self.sub_lock_count >= 3 && self.force_scale > self.force_floor {
                    self.force_trim *= 0.85;
                    self.force_scale *= 0.85;
                    self.sub_lock_count = 0;
                }
            } else if fabsf(error) <= 0.2 {
                self.sub_lock_count = 0;
                if !self.servo_locked {
                    self.servo_error_lp += 0.25 * (error - self.servo_error_lp);
                    self.tune_ratio = (self.tune_ratio
                        + 0.03 * (chunk_len as f32 / 128.0) * self.servo_error_lp)
                        .clamp(0.90, 1.22);
                    if fabsf(error) < 0.006 {
                        self.servo_stable += 1;
                        if self.servo_stable >= 8 {
                            self.servo_locked = true; // in tune — freeze, vibrato takes over
                        }
                    } else {
                        self.servo_stable = 0;
                    }
                }
            }
        }
        // Vibrato rides ON TOP of the servo tuning: delayed onset, raised ramp, wandering rate.
        if self.servo_locked && self.vibrato_depth > 0.0 && self.age > 0.3 {
            self.vib_ramp = (self.vib_ramp + chunk_len as f32 * 1.6 / self.sample_rate).min(1.0);
        }
        self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
        let n1 = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
        self.rate_walk = (self.rate_walk + 0.04 * (n1 - self.rate_walk)).clamp(-1.0, 1.0);
        let vib_rate = 5.9 * (1.0 + 0.06 * self.rate_walk);
        let angle = 2.0 * PI * vib_rate / self.sample_rate;
        self.vib_rot = (sinf(angle), cosf(angle));
        // Pitch micro-jitter (post-servo, slow 1/f-ish): organ vs alive.
        self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
        let n2 = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
        self.jitter_walk = (self.jitter_walk + 0.012 * (n2 - self.jitter_walk)).clamp(-1.0, 1.0);
        let vibrato = 1.0 + self.vib_sin * self.vibrato_depth * self.vib_ramp * self.vib_ramp
            + self.jitter_walk * 0.0026;
        let retune = self.tune_ratio * vibrato;
        self.last_retune = retune;
        let vib_amount = self.vib_ramp * self.vib_ramp;
        for mode in self.modes[..self.count].iter_mut() {
            let theta = (mode.base_theta * retune).clamp(1.0e-4, 2.4);
            let (s, c) = (sinf(theta), cosf(theta));
            let w = theta * self.sample_rate;
            mode.b1 = 2.0 * mode.r * c;
            mode.cv1 = w * c / s - mode.gamma;
            mode.cv2 = -w * mode.r / s;
            // Per-mode shimmer walk (~1.5Hz, decorrelated) + vibrato AM at a per-mode phase —
            // partials that move in lockstep still read as an organ.
            self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
            let nm = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
            mode.shim_state += 0.018 * (nm - mode.shim_state);
            let vib_am = (self.vib_sin * mode.vib_am_cos + self.vib_cos * mode.vib_am_sin) * vib_amount;
            mode.shim = (1.0 + mode.shim_state * 1.35 + vib_am).clamp(0.3, 2.2);
        }
    }

    /// Renders additively; returns the chunk peak so the caller can free silent voices.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32]) -> f32 {
        let mut peak = 0.0f32;
        for index in 0..out_l.len() {
            let coefficient = if self.gate {self.attack_coefficient} else {self.release_coefficient};
            // Living bow: no real stroke moves at constant speed — slow drift, a faint 5.3Hz
            // tremor, a fresh stroke's dig-in relaxing, and bow-change dips every ~2.4-3.3s.
            self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
            self.drift_state += 0.00003 * (noise - self.drift_state);
            let (ts, tc) = (self.tremor_sin, self.tremor_cos);
            self.tremor_sin = ts * self.tremor_rot.1 + tc * self.tremor_rot.0;
            self.tremor_cos = tc * self.tremor_rot.1 - ts * self.tremor_rot.0;
            let (vs, vc) = (self.vib_sin, self.vib_cos);
            self.vib_sin = vs * self.vib_rot.1 + vc * self.vib_rot.0;
            self.vib_cos = vc * self.vib_rot.1 - vs * self.vib_rot.0;
            self.attack_boost += (1.0 - self.attack_boost) * 8.0 * (1.0 - expf(-1.0))
                / (0.18 * self.sample_rate);
            self.age += 1.0 / self.sample_rate;
            self.stroke_timer -= 1.0 / self.sample_rate;
            if self.stroke_timer <= 0.0 && self.gate {
                self.stroke_dip = 1.0;
                self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
                self.stroke_timer = 2.4 + 0.9 * ((self.noise_state >> 8) as f32 / 16777216.0);
            }
            self.stroke_dip *= 1.0 - 9.0 / self.sample_rate;
            let dip = self.stroke_dip * self.stroke_dip;
            let life = (1.0 + self.drift_state * 14.0 + self.tremor_sin * 0.012) * (1.0 - 0.8 * dip);
            let target = if self.gate {self.bow_target * life} else {0.0};
            self.bow_velocity += (target - self.bow_velocity) * coefficient;
            let contact_target = if self.gate {1.0} else {0.0};
            self.contact += (contact_target - self.contact) * coefficient;
            // 1. free advance; bow-point velocity from the exact two-tap readout.
            let mut v_free = 0.0f32;
            for mode in self.modes[..self.count].iter_mut() {
                let y_free = mode.b1 * mode.y1 + mode.b2 * mode.y2;
                v_free += mode.phi * (mode.cv1 * y_free + mode.cv2 * mode.y1);
                mode.y2 = y_free; // stash the free state until injection (old y2 is spent)
            }
            // 2. one scalar semi-implicit friction solve (the MSW curve).
            let delta = self.bow_velocity - v_free;
            let base = fabsf(delta) * self.slope + 0.75;
            let squared = base * base;
            let lambda = (1.0 / (squared * squared)).min(1.0);
            let force_scale = self.force_scale * self.attack_boost;
            let mut force = force_scale * lambda * delta
                / (1.0 + force_scale * lambda * self.admittance);
            // Rosin grit in the force, band-shaped 1-5kHz, continuous plus slip-scaled.
            self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
            let raw = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
            self.rosin_lp += 0.48 * (raw - self.rosin_lp);
            self.rosin_hp += 0.11 * (self.rosin_lp - self.rosin_hp);
            let band = self.rosin_lp - self.rosin_hp;
            force += band * fabsf(force) * (0.25 + 0.7 * (1.0 - lambda)) * self.grit;
            // The contact envelope lifts the hair off on release — the stick region (λ = 1 at
            // small delta) otherwise clamps released modes into a limit cycle.
            force = force.clamp(-self.force_max, self.force_max) * self.contact * self.contact;
            // 3. inject; velocity output blended with displacement for warmth.
            let mut left = 0.0f32;
            let mut right = 0.0f32;
            for (slot, mode) in self.modes[..self.count].iter_mut().enumerate() {
                let y0 = mode.y2 + mode.force_gain * force;
                mode.y2 = mode.y1;
                mode.y1 = y0;
                let mode_velocity = mode.cv1 * y0 + mode.cv2 * mode.y2;
                let blended = (mode_velocity * 0.72 + y0 * 3770.0 * 0.28) * mode.shim;
                left += blended * mode.tap_l;
                right += blended * mode.tap_r;
                if slot == self.anchor_slot {
                    self.cross_age += 1;
                    if self.anchor_prev <= 0.0 && y0 > 0.0 && self.cross_age > 8 {
                        let min_period = 0.55 * self.sample_rate / (self.f0 * 2.0);
                        if self.cross_age as f32 > min_period {
                            self.period_sum += self.cross_age as f32;
                            self.period_count += 1;
                        }
                        self.cross_age = 0;
                    }
                    self.anchor_prev = y0;
                }
            }
            // Direct bow-noise halo: continuous rosin air the high-Q force path filters away;
            // envelope-tracked to sit under the tone, only while the hair touches.
            let tone = fabsf(left) + fabsf(right);
            let follow = if tone > self.tone_env {0.002} else {0.00012};
            self.tone_env += follow * (tone - self.tone_env);
            self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
            let raw_r = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
            self.rosin_lp2 += 0.48 * (raw_r - self.rosin_lp2);
            self.rosin_hp2 += 0.11 * (self.rosin_lp2 - self.rosin_hp2);
            let halo = self.tone_env * self.halo_gain * self.contact * self.contact;
            let band_l = (self.rosin_lp - self.rosin_hp) * halo;
            let band_r = (self.rosin_lp2 - self.rosin_hp2) * halo;
            // Keyboard-compensated output with gentle soft saturation.
            let l = (dc_block(&mut self.dc_l, left) + band_l) * self.out_gain;
            let r = (dc_block(&mut self.dc_r, right) + band_r) * self.out_gain;
            let out_left = l / (1.0 + 0.35 * fabsf(l));
            let out_right = r / (1.0 + 0.35 * fabsf(r));
            out_l[index] += out_left;
            out_r[index] += out_right;
            peak = peak.max(fabsf(out_left)).max(fabsf(out_right));
        }
        self.servo_update(out_l.len());
        peak
    }
}

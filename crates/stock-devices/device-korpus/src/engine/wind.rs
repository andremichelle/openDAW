//! Blown pipe (the Wind exciter): an air jet with a cubic deflection nonlinearity locked to a
//! bore waveguide — a self-oscillating air column, not noise through resonators. The realism
//! layer follows the bow's aliveness recipe: pressure-riding multiplicative turbulence, an
//! overpressure attack that relaxes, slow breath drift plus a faint tremor, re-breath dips every
//! few seconds, delayed vibrato with a wandering rate (pressure-dominant, a few cents of pitch),
//! pitch micro-jitter, and a stereo air halo. Object A colors the pipe (loss, air, jet bite);
//! the bore length compensates the loop filter's exact phase delay so the pipe plays in tune.

use libm::{atan2f, cosf, expf, fabsf, powf, sinf};

use crate::engine::tables::Material;

const PI: f32 = core::f32::consts::PI;
const MAX_JET: usize = 1024;
const MAX_BORE: usize = 4096;

// Pipe color per object: reflection-loss brightness, air halo, jet bite, turbulence darkness,
// scoop depth (bright pipes speak straight — a scoop start pushes them into bad regimes).
fn pipe_color(material: Material) -> (f32, f32, f32, f32, f32) {
    match material {
        Material::Marimba => (0.34, 1.0, 0.95, 0.16, 1.0),     // bamboo: woody, round
        Material::Vibraphone => (0.58, 0.65, 1.0, 0.30, 0.4),  // silver: clear, singing
        Material::Bell => (0.68, 0.55, 1.05, 0.38, 0.0),       // metal whistle: bright, focused
        Material::Membrane => (0.26, 1.9, 0.88, 0.17, 1.2),    // husky: dark, airy
        Material::Plate => (0.42, 1.8, 0.82, 0.20, 1.0),       // shò-like: breath forward
        Material::PianoWire => (0.52, 0.85, 1.06, 0.26, 0.5),  // reedy: hard jet bite
    }
}

pub struct WindState {
    jet: [f32; MAX_JET],
    bore: [f32; MAX_BORE],
    jet_write: usize,
    bore_write: usize,
    jet_len: f32,
    bore_len: f32,
    bore_len_target: f32,
    jet_ratio: f32,
    loop_state: f32,
    loop_coefficient: f32,
    reflect: f32,
    jet_gain: f32,
    air_gain: f32,
    breath: f32,
    breath_target: f32,
    overshoot: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    gate: bool,
    chiff: f32,
    noise_state: u32,
    noise_lp: f32,
    noise_lp_state: f32,
    drift_state: f32,
    tremor_sin: f32,
    tremor_cos: f32,
    tremor_rot: (f32, f32),
    pulse_timer: f32,
    pulse_dip: f32,
    vibrato_depth: f32,
    vib_sin: f32,
    vib_cos: f32,
    vib_rot: (f32, f32),
    vib_ramp: f32,
    rate_walk: f32,
    jitter_walk: f32,
    scoop_state: f32,
    scoop_decay: f32,
    seed_sin: f32,
    seed_cos: f32,
    seed_rot: (f32, f32),
    seed_amp: f32,
    age: f32,
    noise_l: f32,
    noise_r: f32,
    width: f32,
    out_gain: f32,
    frequency: f32,
    target_frequency: f32,
    servo_trim: f32,
    servo_locked: bool,
    servo_stable: u32,
    servo_miss: u32,
    cross_prev: f32,
    cross_age: u32,
    period_sum: f32,
    period_count: u32,
    material: Material,
    live_pressure: f32,
    live_damping: f32,
    live_freq_ratio: f32,
    dc: (f32, f32),
    sample_rate: f32,
}

impl WindState {
    pub const fn silent() -> Self {
        Self {jet: [0.0; MAX_JET], bore: [0.0; MAX_BORE], jet_write: 0, bore_write: 0,
            jet_len: 40.0, bore_len: 100.0, bore_len_target: 100.0, jet_ratio: 0.45,
            loop_state: 0.0, loop_coefficient: 0.5, reflect: 0.5, jet_gain: 1.0, air_gain: 1.0,
            breath: 0.0, breath_target: 0.0, overshoot: 1.0, attack_coefficient: 0.001,
            release_coefficient: 0.001, gate: false, chiff: 0.0, noise_state: 0x7ee1a2b3,
            noise_lp: 0.2, noise_lp_state: 0.0, drift_state: 0.0, tremor_sin: 0.0,
            tremor_cos: 1.0, tremor_rot: (0.0, 1.0), pulse_timer: 2.6, pulse_dip: 0.0,
            vibrato_depth: 0.0, vib_sin: 0.0, vib_cos: 1.0, vib_rot: (0.0, 1.0), vib_ramp: 0.0,
            rate_walk: 0.0, jitter_walk: 0.0, scoop_state: 0.0, scoop_decay: 0.0002,
            seed_sin: 0.0, seed_cos: 1.0,
            seed_rot: (0.0, 1.0), seed_amp: 0.0, age: 0.0, noise_l: 0.0,
            noise_r: 0.0, width: 0.5, out_gain: 1.0, frequency: 220.0, target_frequency: 220.0,
            servo_trim: 1.0, servo_locked: false, servo_stable: 0, servo_miss: 0,
            cross_prev: 0.0, cross_age: 0,
            period_sum: 0.0, period_count: 0, material: Material::Marimba, live_pressure: 0.5,
            live_damping: 0.5, live_freq_ratio: 1.0, dc: (0.0, 0.0), sample_rate: 48_000.0}
    }

    // Exact phase delay (samples) of the reflection one-pole at the fundamental — the flat
    // tuning error of the naive length guess grows with pitch.
    fn loop_delay(&self, frequency: f32) -> f32 {
        let omega = (2.0 * PI * frequency / self.sample_rate).max(1.0e-4);
        let keep = 1.0 - self.loop_coefficient;
        atan2f(keep * sinf(omega), 1.0 - keep * cosf(omega)) / omega
    }

    fn bore_len_for(&self, frequency: f32) -> f32 {
        (self.sample_rate / frequency - self.loop_delay(frequency))
            .clamp(4.0, (MAX_BORE - 4) as f32)
    }

    fn set_damping(&mut self, damping: f32) {
        let (loss, _, _, _, _) = pipe_color(self.material);
        self.loop_coefficient = (loss * (0.55 + 0.9 * damping)).clamp(0.12, 0.95);
        // Bounded so full damping cannot push a bright pipe's passive loop into mode hops.
        self.reflect = 0.32 + 0.2 * damping;
        self.release_coefficient =
            1.0 - expf(-1.0 / ((0.025 + 0.3 * damping) * self.sample_rate));
    }

    #[allow(clippy::too_many_arguments)]
    pub fn blow(&mut self, material: Material, frequency: f32, velocity: f32, pressure: f32,
                position: f32, damping: f32, width: f32, vibrato: f32, sample_rate: f32) {
        let (_, air, jet, turbulence, scoop) = pipe_color(material);
        self.jet.fill(0.0);
        self.bore.fill(0.0);
        self.jet_write = 0;
        self.bore_write = 0;
        self.sample_rate = sample_rate;
        self.frequency = frequency;
        self.material = material;
        self.set_damping(damping);
        // The learned servo trim survives across notes — adjacent pitches need nearly the same
        // correction, so a run speaks in tune instead of re-learning the pipe every note.
        self.servo_trim = self.servo_trim.clamp(0.88, 1.12);
        self.bore_len = self.bore_len_for(frequency) * self.servo_trim;
        self.bore_len_target = self.bore_len;
        self.jet_ratio = (0.36 + 0.24 * position).min(0.47); // capped below the octave-regime boundary
        self.jet_len = (self.bore_len * self.jet_ratio).clamp(2.0, (MAX_JET - 4) as f32);
        self.jet_gain = jet;
        self.air_gain = air;
        self.loop_state = 0.0;
        self.breath = 0.0;
        self.breath_target = (0.62 + 0.3 * velocity) * (0.82 + 0.36 * pressure);
        self.overshoot = 1.0 + 0.22 * velocity;
        self.attack_coefficient =
            1.0 - expf(-1.0 / ((0.02 + 0.06 * (1.0 - velocity)) * sample_rate));
        self.gate = true;
        self.chiff = 1.0;
        self.noise_lp = turbulence + 0.1 * pressure;
        self.noise_lp_state = 0.0;
        self.drift_state = 0.0;
        self.tremor_sin = 0.0;
        self.tremor_cos = 1.0;
        let tremor_angle = 2.0 * PI * 4.7 / sample_rate;
        self.tremor_rot = (sinf(tremor_angle), cosf(tremor_angle));
        self.pulse_timer = 2.6;
        self.pulse_dip = 0.0;
        self.vibrato_depth = vibrato;
        self.vib_sin = 0.0;
        self.vib_cos = 1.0;
        let vib_angle = 2.0 * PI * 5.1 / sample_rate;
        self.vib_rot = (sinf(vib_angle), cosf(vib_angle));
        self.vib_ramp = 0.0;
        self.rate_walk = 0.0;
        self.jitter_walk = 0.0;
        // A decaying ping at the note's pitch entrains the mode; a cold jet+bore picks it chaotically.
        let seed_angle = 2.0 * PI * frequency / sample_rate;
        self.seed_rot = (sinf(seed_angle), cosf(seed_angle));
        self.seed_sin = 0.0;
        self.seed_cos = 1.0;
        self.seed_amp = 0.22;
        self.age = 0.0;
        self.noise_l = 0.0;
        self.noise_r = 0.0;
        self.width = width;
        // The jet's cubic saturates, so the level is nearly pitch-flat already.
        self.out_gain = 0.19;
        self.target_frequency = frequency;
        // Meri scoop: a decaying flat bend, deeper and longer on soft notes; the servo measures through it.
        self.scoop_state = (0.006 + 0.028 * (1.0 - velocity)) * scoop;
        self.scoop_decay = (4.0 + 24.0 * velocity * velocity) / sample_rate;
        // Trim and lock carry over from the previous note: adjacent pitches need nearly the same trim.
        self.servo_stable = 0;
        self.servo_miss = 0;
        self.cross_prev = 0.0;
        self.cross_age = 0;
        self.period_sum = 0.0;
        self.period_count = 0;
        self.live_pressure = pressure;
        self.live_damping = damping;
        self.live_freq_ratio = 1.0;
        self.dc = (0.0, 0.0);
    }

    pub fn release(&mut self) {
        self.gate = false;
    }

    /// Live knob feedback on a sounding pipe: pressure, bore damping, width, tune and vibrato.
    /// Values arrive already smoothed.
    pub fn refresh(&mut self, pressure: f32, damping: f32, width: f32, freq_ratio: f32,
                   vibrato: f32) {
        self.vibrato_depth = vibrato;
        self.width = width;
        if fabsf(pressure - self.live_pressure) > 1.0e-4 {
            let scale = (0.82 + 0.36 * pressure) / (0.82 + 0.36 * self.live_pressure);
            self.live_pressure = pressure;
            self.breath_target *= scale;
        }
        let damping_moved = fabsf(damping - self.live_damping) > 1.0e-4;
        if damping_moved {
            self.live_damping = damping;
            self.set_damping(damping);
            // The loop phase moved with the loss filter — let the servo re-find the pitch.
            self.servo_locked = false;
            self.servo_stable = 0;
        }
        if fabsf(freq_ratio - self.live_freq_ratio) > 1.0e-4 || damping_moved {
            self.live_freq_ratio = freq_ratio;
            self.target_frequency = self.frequency * freq_ratio;
            self.bore_len_target = self.bore_len_for(self.target_frequency) * self.servo_trim;
        }
    }

    // The jet loop blows slightly sharp of the passive bore resonance, by an amount that moves
    // with pitch, pressure and loss. Instead of fitting it, count the bore's oscillation period
    // and tune the pipe like a player, then freeze (the bow's servo, on an air column).
    fn servo_update(&mut self) {
        if !self.gate || self.breath < 0.75 * self.breath_target {
            // Attack, release and rising-breath periods are all biased — clear them so no
            // unsteady period ever leaks into a measured batch.
            self.period_sum = 0.0;
            self.period_count = 0;
            self.cross_age = 0;
            return;
        }
        if self.period_count < 6 {
            return;
        }
        let f_sung = self.sample_rate * self.period_count as f32 / self.period_sum;
        self.period_sum = 0.0;
        self.period_count = 0;
        // The scoop is deliberate flatness — measure through it or the trim chases the bend.
        let mut ratio = f_sung / self.target_frequency * (1.0 + self.scoop_state);
        if (0.42..0.58).contains(&ratio) {
            ratio *= 2.0; // period-doubled regime: only every other cycle crosses zero
        }
        if !(0.6..1.7).contains(&ratio) {
            return;
        }
        // Locked pipes keep correcting below the vibrato rate; each step is bounded against bad batches.
        let rate = if self.servo_locked {0.12} else {0.7};
        let error = fabsf(ratio - 1.0);
        let step = powf(ratio, rate).clamp(0.985, 1.015);
        self.servo_trim = (self.servo_trim * step).clamp(0.88, 1.12);
        self.bore_len_target = self.bore_len_for(self.target_frequency) * self.servo_trim;
        if error < 0.0025 {
            self.servo_stable += 1;
            self.servo_miss = 0;
            if self.servo_stable >= 3 {
                self.servo_locked = true; // in tune — vibrato ramps in
            }
        } else {
            self.servo_stable = 0;
            if self.servo_locked && error > 0.02 {
                self.servo_miss += 1;
                if self.servo_miss >= 2 {
                    self.servo_locked = false; // genuinely off — re-learn at full rate
                    self.servo_miss = 0;
                }
            }
        }
    }

    #[inline]
    fn noise(&mut self) -> f32 {
        self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.noise_state >> 8) as f32 / 8388608.0 - 1.0
    }

    #[inline]
    fn read(line: &[f32], write: usize, delay: f32, mask: usize) -> f32 {
        let read_pos = write as f32 - delay + mask as f32;
        let index = read_pos as usize;
        let frac = read_pos - index as f32;
        let a = line[index % mask];
        let b = line[(index + 1) % mask];
        a + (b - a) * frac
    }

    /// Renders additively; returns the chunk peak so the caller can free silent voices.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32]) -> f32 {
        // Wandering vibrato rate, updated at chunk rate like the bow's.
        self.rate_walk = (self.rate_walk + 0.04 * (self.noise() - self.rate_walk)).clamp(-1.0, 1.0);
        let vib_rate = 5.1 * (1.0 + 0.07 * self.rate_walk);
        let angle = 2.0 * PI * vib_rate / self.sample_rate;
        self.vib_rot = (sinf(angle), cosf(angle));
        let mut peak = 0.0f32;
        for index in 0..out_l.len() {
            self.age += 1.0 / self.sample_rate;
            self.overshoot += (1.0 - self.overshoot) * 9.0 / self.sample_rate;
            self.chiff *= 1.0 - 26.0 / self.sample_rate;
            // Living breath: drift walk, faint tremor, re-breath dips every ~2.6-3.7s.
            self.drift_state += 0.00005 * (self.noise() - self.drift_state);
            let (ts, tc) = (self.tremor_sin, self.tremor_cos);
            self.tremor_sin = ts * self.tremor_rot.1 + tc * self.tremor_rot.0;
            self.tremor_cos = tc * self.tremor_rot.1 - ts * self.tremor_rot.0;
            self.pulse_timer -= 1.0 / self.sample_rate;
            if self.pulse_timer <= 0.0 && self.gate {
                self.pulse_dip = 1.0;
                self.pulse_timer = 2.6 + 1.1 * (self.noise() * 0.5 + 0.5);
            }
            self.pulse_dip *= 1.0 - 5.0 / self.sample_rate;
            let dip = self.pulse_dip * self.pulse_dip;
            let life = (1.0 + self.drift_state * 8.0 + self.tremor_sin * 0.016)
                * (1.0 - 0.4 * dip);
            let coefficient = if self.gate {self.attack_coefficient} else {self.release_coefficient};
            let target = if self.gate {self.breath_target * life} else {0.0};
            self.breath += (target - self.breath) * coefficient;
            // Delayed vibrato, wandering rate; a flute's vibrato lives mostly in the breath.
            if self.servo_locked && self.age > 0.28 && self.vibrato_depth > 0.0 && self.gate {
                self.vib_ramp = (self.vib_ramp + 1.8 / self.sample_rate).min(1.0);
            }
            let (vs, vc) = (self.vib_sin, self.vib_cos);
            self.vib_sin = vs * self.vib_rot.1 + vc * self.vib_rot.0;
            self.vib_cos = vc * self.vib_rot.1 - vs * self.vib_rot.0;
            let vib_amount = self.vib_ramp * self.vib_ramp * self.vibrato_depth;
            let vib = self.vib_sin * vib_amount;
            self.jitter_walk += 0.00001 * (self.noise() - self.jitter_walk);
            // Multiplicative turbulence: the air rides the pressure, brighter while the chiff
            // speaks — the noise lives inside the tone, not next to it.
            let raw_noise = self.noise();
            self.noise_lp_state += self.noise_lp * (raw_noise - self.noise_lp_state);
            let turbulence = self.noise_lp_state * (0.05 + 0.32 * self.chiff);
            let pressure = self.breath * self.overshoot
                * (1.0 + vib * 0.55 + turbulence + self.drift_state * 4.0);
            // Pitch: bore glide toward target plus the decaying scoop, vibrato cents and
            // micro-jitter.
            self.bore_len += (self.bore_len_target - self.bore_len) * 0.002;
            self.scoop_state *= 1.0 - self.scoop_decay;
            let bend = 1.0 + self.scoop_state - vib * 0.0055 - self.jitter_walk * 0.6;
            let bore_delay = (self.bore_len * bend).clamp(4.0, (MAX_BORE - 4) as f32);
            let bore_out = Self::read(&self.bore, self.bore_write, bore_delay, MAX_BORE);
            // Positive-going crossings, sub-period ones merged: a harmonic-rich bore wave
            // crosses several times per cycle, and resetting on those reads a false 2-3x pitch.
            self.cross_age += 1;
            if self.cross_prev <= 0.0 && bore_out > 0.0 {
                let min_period = 0.55 * self.sample_rate / self.target_frequency;
                if self.cross_age as f32 > min_period {
                    self.period_sum += self.cross_age as f32;
                    self.period_count += 1;
                    self.cross_age = 0;
                }
            }
            self.cross_prev = bore_out;
            self.loop_state += self.loop_coefficient * (bore_out - self.loop_state);
            let feedback = self.loop_state;
            self.jet[self.jet_write % MAX_JET] = pressure - 0.5 * feedback;
            self.jet_write = (self.jet_write + 1) % MAX_JET;
            let jet_out = Self::read(&self.jet, self.jet_write,
                (self.bore_len * self.jet_ratio).clamp(2.0, (MAX_JET - 4) as f32), MAX_JET);
            // A slight jet offset breaks the cubic's symmetry: the even harmonics that separate
            // a breathy edge-tone from a hollow clarinet, growing with blowing pressure.
            let biased = jet_out + 0.12 + 0.1 * self.live_pressure;
            let shaped = (biased * (biased * biased - 1.0)).clamp(-1.0, 1.0) * self.jet_gain;
            // Breath noise blown INTO the bore: air filtered by the pipe's own resonances is
            // the shakuhachi airiness — hiss beside the tone never fuses with it.
            let breath_air = self.noise_lp_state * self.breath
                * (0.055 + 0.085 * self.live_pressure) * self.air_gain;
            let mut seed = 0.0;
            if self.seed_amp > 1.0e-4 {
                let (ss, sc) = (self.seed_sin, self.seed_cos);
                self.seed_sin = ss * self.seed_rot.1 + sc * self.seed_rot.0;
                self.seed_cos = sc * self.seed_rot.1 - ss * self.seed_rot.0;
                seed = self.seed_sin * self.seed_amp * self.breath;
                self.seed_amp *= 1.0 - 0.3 / (self.bore_len.max(8.0));
            }
            self.bore[self.bore_write % MAX_BORE] =
                shaped + self.reflect * feedback + breath_air + seed;
            self.bore_write = (self.bore_write + 1) % MAX_BORE;
            let blocked = bore_out - self.dc.0 + 0.995 * self.dc.1;
            self.dc.0 = bore_out;
            self.dc.1 = blocked;
            // Stereo air halo: decorrelated breath noise, width-spread, riding the pressure.
            self.noise_l += 0.3 * (self.noise() - self.noise_l);
            self.noise_r += 0.3 * (self.noise() - self.noise_r);
            // Direct air rides the vibrato and tremor — the breath wavers, not just the pitch.
            let air = self.breath * (0.019 + 0.02 * self.live_pressure) * self.air_gain
                * (1.0 + vib * 1.2 + self.tremor_sin * 0.25 + 0.6 * self.chiff);
            let spread = self.width * air;
            let center = self.noise_lp_state * air * 0.7;
            let tone = blocked * self.out_gain;
            let left = tone + (self.noise_l * spread + center) * 0.6;
            let right = tone + (self.noise_r * spread + center) * 0.6;
            out_l[index] += left;
            out_r[index] += right;
            peak = peak.max(fabsf(left)).max(fabsf(right));
        }
        self.servo_update();
        peak
    }
}

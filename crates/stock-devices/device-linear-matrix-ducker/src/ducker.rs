pub const RING: usize = 4096;
const MASK: usize = RING - 1;
pub const MAX_LOOKAHEAD_SECONDS: f32 = 0.010;
const MAX_LOOKAHEAD_FRAMES: usize = 1920;
pub const LATENCY_PADDING: usize = 9;
pub const ISP_TAPS: usize = 18;
pub const ISP_DELAY: usize = ISP_TAPS / 2;
const ISP_PHASES: usize = 3;
const RMS_SECONDS: f32 = 0.001_046_85;
pub const DISPLAY_ENTRIES: usize = 64;
pub const DISPLAY_VALUES: usize = 4;
pub const DISPLAY_COUNTER_WRAP: u32 = 1 << 20;
const DISPLAY_SECONDS: f32 = 0.005;

pub const MODE_PEAK: i32 = 0;
pub const MODE_ISP: i32 = 1;
pub const MODE_RMS: i32 = 2;

pub fn soft_clip(level: f32, threshold: f32, range: f32) -> f32 {
    let knee = threshold * range * 0.5;
    if knee <= 0.0 || level <= threshold - knee {
        level.min(threshold)
    } else if level >= threshold + knee {
        threshold
    } else {
        let over = level - threshold + knee;
        level - over * over / (4.0 * knee)
    }
}

pub fn floor_sidechain(level: f32, range: f32) -> f32 {
    if range >= 1.0 {
        level
    } else if range <= 0.0 {
        if level >= 1.0 {1.0} else {0.0}
    } else {
        ((level - (1.0 - range)) / range).clamp(0.0, 1.0)
    }
}

pub fn sidechain_gain(envelope: f32, range: f32) -> f32 {
    let open = (1.0 - envelope).max(0.0);
    if range <= 1.0 {return open}
    let knee = (range - 1.0).min(1.0);
    let scale = 1.0 - knee * 0.5;
    if open >= knee {(open - knee * 0.5) / scale} else {open * open / (2.0 * knee * scale)}
}

pub struct MaxWindow {
    values: [f32; RING],
    indices: [u32; RING],
    head: usize,
    length: usize
}

impl MaxWindow {
    fn reset(&mut self) {
        self.head = 0;
        self.length = 0;
    }

    fn push(&mut self, index: u32, value: f32) {
        while self.length > 0 && self.values[(self.head + self.length - 1) & MASK] <= value {self.length -= 1;}
        let tail = (self.head + self.length) & MASK;
        self.values[tail] = value;
        self.indices[tail] = index;
        self.length += 1;
    }

    fn expire(&mut self, oldest: u32) {
        while self.length > 0 && (self.indices[self.head].wrapping_sub(oldest) as i32) < 0 {
            self.head = (self.head + 1) & MASK;
            self.length -= 1;
        }
    }

    fn max(&self) -> f32 {
        if self.length == 0 {0.0} else {self.values[self.head]}
    }
}

pub struct Envelope {
    levels: [f32; RING],
    bases: [f32; RING],
    candidates: [u32; RING],
    candidate_head: usize,
    candidate_length: usize,
    ahead: MaxWindow,
    held: MaxWindow,
    entered: u32,
    value: f32
}

impl Envelope {
    fn reset(&mut self) {
        self.levels = [0.0; RING];
        self.bases = [0.0; RING];
        self.candidate_head = 0;
        self.candidate_length = 0;
        self.ahead.reset();
        self.held.reset();
        self.entered = 0;
        self.value = 0.0;
    }

    fn write(&mut self, index: u32, level: f32) {
        self.levels[index as usize & MASK] = level;
    }

    fn process(&mut self, now: u32, attack: usize, hold: usize, release_coeff: f32) -> f32 {
        let horizon = now.wrapping_add(attack as u32);
        while (horizon.wrapping_sub(self.entered) as i32) >= 0 {
            let index = self.entered;
            let slot = index as usize & MASK;
            let level = self.levels[slot];
            let base = self.value * release_coeff;
            self.bases[slot] = base;
            if level > base && self.candidate_length < RING {
                self.candidates[(self.candidate_head + self.candidate_length) & MASK] = index;
                self.candidate_length += 1;
            }
            self.ahead.push(index, level);
            self.entered = index.wrapping_add(1);
        }
        self.held.push(now, self.levels[now as usize & MASK]);
        let oldest = now.wrapping_sub(hold as u32);
        self.ahead.expire(oldest);
        self.held.expire(oldest);
        while self.candidate_length > 0 && (self.candidates[self.candidate_head].wrapping_sub(now) as i32) < 0 {
            self.candidate_head = (self.candidate_head + 1) & MASK;
            self.candidate_length -= 1;
        }
        let mut rising = 0.0f32;
        for offset in 0..self.candidate_length {
            let index = self.candidates[(self.candidate_head + offset) & MASK];
            let distance = index.wrapping_sub(now) as usize;
            if distance > attack {break}
            let slot = index as usize & MASK;
            let base = self.bases[slot];
            let ramp = if attack == 0 {1.0} else {1.0 - distance as f32 / attack as f32};
            rising = rising.max(base + (self.levels[slot] - base) * ramp * ramp);
        }
        let peak = self.ahead.max();
        let released = if self.value > peak {peak + (self.value - peak) * release_coeff} else {self.value};
        self.value = released.max(rising).max(self.held.max());
        self.value
    }
}

pub struct Detector {
    history: [f32; ISP_TAPS * 2],
    position: usize,
    segment: f32,
    mean_square: f32
}

impl Detector {
    fn reset(&mut self) {
        self.history = [0.0; ISP_TAPS * 2];
        self.position = 0;
        self.segment = 0.0;
        self.mean_square = 0.0;
    }

    fn detect(&mut self, sample: f32, mode: i32, phases: &[[f32; ISP_TAPS]; ISP_PHASES], rms_coeff: f32) -> f32 {
        self.history[self.position] = sample;
        self.history[self.position + ISP_TAPS] = sample;
        self.position = (self.position + 1) % ISP_TAPS;
        let square = sample * sample;
        self.mean_square = square + (self.mean_square - square) * rms_coeff;
        if mode == MODE_RMS {
            libm::sqrtf(2.0 * self.mean_square)
        } else if mode == MODE_ISP {
            let window = &self.history[self.position..self.position + ISP_TAPS];
            let mut points = [0.0f32; ISP_PHASES];
            for (point, phase) in points.iter_mut().zip(phases) {
                let mut sum = 0.0f32;
                for (tap, value) in phase.iter().zip(window) {sum += tap * value;}
                *point = sum.abs();
            }
            let level = window[ISP_DELAY - 1].abs().max(points[0]).max(points[1]).max(self.segment);
            self.segment = points[1].max(points[2]);
            level
        } else {
            sample.abs()
        }
    }
}

pub struct Ducker {
    phases: [[f32; ISP_TAPS]; ISP_PHASES],
    detectors: [Detector; 2],
    envelopes: [Envelope; 2],
    audio: [[f32; RING]; 2],
    levels: [f32; RING],
    sample_rate: f32,
    lookahead: usize,
    latency: usize,
    rms_coeff: f32,
    now: u32,
    threshold: f32,
    range: f32,
    stereo: f32,
    mix: f32,
    mode: i32,
    attack: usize,
    hold: usize,
    release_coeff: f32,
    display_frames: u32,
    display_count: u32,
    display_pending: [f32; DISPLAY_VALUES],
    pub display: [[f32; DISPLAY_VALUES]; DISPLAY_ENTRIES],
    pub display_written: u32
}

impl Ducker {
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.lookahead = (libm::roundf(MAX_LOOKAHEAD_SECONDS * sample_rate) as usize).clamp(1, MAX_LOOKAHEAD_FRAMES);
        self.latency = self.lookahead + LATENCY_PADDING;
        self.rms_coeff = libm::expf(-1.0 / (RMS_SECONDS * sample_rate));
        self.display_frames = (libm::roundf(DISPLAY_SECONDS * sample_rate) as u32).max(1);
        for (phase_index, phase) in self.phases.iter_mut().enumerate() {
            let fraction = (phase_index + 1) as f32 / (ISP_PHASES + 1) as f32;
            let mut sum = 0.0f32;
            for (tap_index, tap) in phase.iter_mut().enumerate() {
                let distance = (ISP_DELAY - 1) as f32 + fraction - tap_index as f32;
                let x = core::f32::consts::PI * distance;
                let sinc = if distance.abs() < 1e-6 {1.0} else {libm::sinf(x) / x};
                let window = 0.5 * (1.0 + libm::cosf(core::f32::consts::PI * distance / ISP_DELAY as f32));
                *tap = sinc * window;
                sum += *tap;
            }
            for tap in phase.iter_mut() {*tap /= sum;}
        }
        self.threshold = 1.0;
        self.range = 1.0;
        self.stereo = 0.0;
        self.mix = 1.0;
        self.mode = MODE_PEAK;
        self.set_attack_ms(5.0);
        self.set_hold_ms(0.0);
        self.set_release_ms(5.0);
        self.reset();
    }

    pub fn reset(&mut self) {
        for detector in &mut self.detectors {detector.reset();}
        for envelope in &mut self.envelopes {envelope.reset();}
        self.audio = [[0.0; RING]; 2];
        self.levels = [0.0; RING];
        self.now = 0;
        self.display_count = 0;
        self.display_pending = [0.0, 0.0, 0.0, 1.0];
    }

    pub fn latency(&self) -> usize {self.latency}
    pub fn set_threshold_db(&mut self, db: f32) {self.threshold = math::db_to_gain(db);}
    pub fn set_range(&mut self, range: f32) {self.range = range.clamp(0.0, 2.0);}
    pub fn set_stereo(&mut self, stereo: f32) {self.stereo = stereo.clamp(0.0, 1.0);}
    pub fn set_mix(&mut self, mix: f32) {self.mix = mix.clamp(0.0, 1.0);}
    pub fn set_mode(&mut self, mode: i32) {self.mode = mode.clamp(MODE_PEAK, MODE_RMS);}

    pub fn set_attack_ms(&mut self, ms: f32) {
        self.attack = (libm::roundf(ms.max(0.0) * 0.001 * self.sample_rate) as usize).min(self.lookahead);
    }

    pub fn set_hold_ms(&mut self, ms: f32) {
        self.hold = (libm::roundf(ms.max(0.0) * 0.001 * self.sample_rate) as usize).min(self.lookahead);
    }

    // Release is a half-life: the reduction halves every release time.
    pub fn set_release_ms(&mut self, ms: f32) {
        let frames = ms * 0.001 * self.sample_rate;
        self.release_coeff = if frames <= 0.0 {0.0} else {libm::exp2f(-1.0 / frames)};
    }

    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], side: Option<(&[f32], &[f32])>,
                   out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        let delay = if self.mode == MODE_ISP {ISP_DELAY} else {0};
        for index in from..to {
            let inputs = [in_left[index], in_right[index]];
            let sources = match side {
                Some((left, right)) => [left[index], right[index]],
                None => inputs
            };
            let detected = [
                self.detectors[0].detect(sources[0], self.mode, &self.phases, self.rms_coeff),
                self.detectors[1].detect(sources[1], self.mode, &self.phases, self.rms_coeff)
            ];
            let linked = if self.mode == MODE_RMS {
                libm::sqrtf((detected[0] * detected[0] + detected[1] * detected[1]) * 0.5)
            } else {
                detected[0].max(detected[1])
            };
            let written = self.now.wrapping_sub(delay as u32);
            self.levels[written as usize & MASK] = linked;
            for (envelope, level) in self.envelopes.iter_mut().zip(detected) {
                let blended = linked + (level - linked) * self.stereo;
                let value = if side.is_some() {floor_sidechain((blended / self.threshold).min(1.0), self.range)} else {blended};
                envelope.write(written, value);
            }
            let current = self.now.wrapping_sub(self.latency as u32);
            let slot = current as usize & MASK;
            let mut outputs = [0.0f32; 2];
            let mut dry_peak = 0.0f32;
            let mut min_gain = 1.0f32;
            for channel in 0..2 {
                let envelope = self.envelopes[channel].process(current, self.attack, self.hold, self.release_coeff);
                let gain = if side.is_some() {
                    sidechain_gain(envelope, self.range)
                } else if envelope > 0.0 {
                    soft_clip(envelope, self.threshold, self.range) / envelope
                } else {
                    1.0
                };
                let dry = self.audio[channel][slot];
                self.audio[channel][self.now as usize & MASK] = inputs[channel];
                outputs[channel] = dry * (1.0 + (gain - 1.0) * self.mix);
                dry_peak = dry_peak.max(dry.abs());
                min_gain = min_gain.min(gain);
            }
            out_left[index] = outputs[0];
            out_right[index] = outputs[1];
            self.collect(dry_peak, outputs[0].abs().max(outputs[1].abs()), self.levels[slot], min_gain);
            self.now = self.now.wrapping_add(1);
        }
    }

    fn collect(&mut self, dry: f32, output: f32, sidechain: f32, gain: f32) {
        let pending = &mut self.display_pending;
        pending[0] = pending[0].max(dry);
        pending[1] = pending[1].max(output);
        pending[2] = pending[2].max(sidechain);
        pending[3] = pending[3].min(gain);
        self.display_count += 1;
        if self.display_count >= self.display_frames {
            self.display[self.display_written as usize % DISPLAY_ENTRIES] = *pending;
            self.display_written = (self.display_written + 1) % DISPLAY_COUNTER_WRAP;
            self.display_pending = [0.0, 0.0, 0.0, 1.0];
            self.display_count = 0;
        }
    }
}

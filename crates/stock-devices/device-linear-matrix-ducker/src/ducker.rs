pub const RING: usize = 2048;
const MASK: usize = RING - 1;
const TARGETS: usize = RING * 2;
const TARGET_MASK: usize = TARGETS - 1;
pub const MAX_ATTACK_SECONDS: f32 = 0.010;
const MAX_ATTACK_FRAMES: usize = 1920;
pub const ISP_TAPS: usize = 12;
pub const ISP_DELAY: usize = ISP_TAPS / 2;
const ISP_PHASES: usize = 3;
const RMS_SECONDS: f32 = 0.005;
const RMS_CAPACITY: usize = 1024;
pub const DISPLAY_ENTRIES: usize = 64;
pub const DISPLAY_VALUES: usize = 4;
pub const DISPLAY_COUNTER_WRAP: u32 = 1 << 20;
const DISPLAY_SECONDS: f32 = 0.005;

pub const MODE_PEAK: i32 = 0;
pub const MODE_ISP: i32 = 1;
pub const MODE_RMS: i32 = 2;

pub fn shape_sidechain(level: f32, range: f32) -> f32 {
    let level = level.clamp(0.0, 1.0);
    if range <= 0.0 {
        0.0
    } else if range <= 1.0 {
        ((level - (1.0 - range)) / range).max(0.0)
    } else {
        1.0 - libm::powf(1.0 - level, range)
    }
}

pub fn target_gain(carrier: f32, sidechain: f32, threshold: f32, range: f32) -> f32 {
    let normalized = if threshold > 0.0 {sidechain / threshold} else {1.0};
    let allowed = threshold * (1.0 - shape_sidechain(normalized, range));
    if carrier <= allowed {1.0} else {allowed / carrier}
}

pub struct Detector {
    history: [f32; ISP_TAPS * 2],
    position: usize,
    segment: f32,
    squares: [f32; RMS_CAPACITY],
    rms_position: usize,
    rms_sum: f64
}

impl Detector {
    fn reset(&mut self) {
        self.history = [0.0; ISP_TAPS * 2];
        self.position = 0;
        self.segment = 0.0;
        self.squares = [0.0; RMS_CAPACITY];
        self.rms_position = 0;
        self.rms_sum = 0.0;
    }

    fn detect(&mut self, sample: f32, mode: i32, phases: &[[f32; ISP_TAPS]; ISP_PHASES], rms_size: usize) -> f32 {
        self.history[self.position] = sample;
        self.history[self.position + ISP_TAPS] = sample;
        self.position = (self.position + 1) % ISP_TAPS;
        let square = sample * sample;
        self.rms_sum += square as f64 - self.squares[self.rms_position] as f64;
        self.squares[self.rms_position] = square;
        self.rms_position += 1;
        if self.rms_position == rms_size {self.rms_position = 0;}
        if mode == MODE_RMS {
            libm::sqrtf((self.rms_sum.max(0.0) / rms_size as f64) as f32)
        } else if mode == MODE_ISP {
            let window = &self.history[self.position..self.position + ISP_TAPS];
            let mut segment = window[ISP_DELAY - 1].abs().max(window[ISP_DELAY].abs());
            for phase in phases {
                let mut sum = 0.0f32;
                for (tap, value) in phase.iter().zip(window) {sum += tap * value;}
                segment = segment.max(sum.abs());
            }
            let level = segment.max(self.segment);
            self.segment = segment;
            level
        } else {
            sample.abs()
        }
    }
}

pub struct GainPath {
    targets: [f32; TARGETS],
    window_values: [f32; RING],
    window_ages: [u32; RING],
    window_head: usize,
    window_length: usize,
    envelope: f32,
    hold_counter: u32,
    smoothed: [f32; RING],
    smoothed_sum: f64
}

impl GainPath {
    fn reset(&mut self) {
        self.targets = [1.0; TARGETS];
        self.smoothed = [1.0; RING];
        self.window_head = 0;
        self.window_length = 0;
        self.envelope = 1.0;
        self.hold_counter = 0;
        self.smoothed_sum = 0.0;
    }

    fn push_window(&mut self, value: f32, age: u32, attack: usize) {
        while self.window_length > 0 && age.wrapping_sub(self.window_ages[self.window_head]) > attack as u32 {
            self.window_head = (self.window_head + 1) & MASK;
            self.window_length -= 1;
        }
        while self.window_length > 0 && self.window_values[(self.window_head + self.window_length - 1) & MASK] >= value {
            self.window_length -= 1;
        }
        let tail = (self.window_head + self.window_length) & MASK;
        self.window_values[tail] = value;
        self.window_ages[tail] = age;
        self.window_length += 1;
    }

    fn target(&self, time: u32, offset: usize) -> f32 {
        self.targets[(time as usize).wrapping_sub(offset) & TARGET_MASK]
    }

    fn rebuild(&mut self, now: u32, offset: usize, attack: usize) {
        self.window_head = 0;
        self.window_length = 0;
        for back in (1..=attack * 2).rev() {
            let time = now.wrapping_sub(back as u32);
            self.push_window(self.target(time, offset), time, attack);
            if back <= attack {
                let minimum = self.window_values[self.window_head];
                let slot = time as usize & MASK;
                self.smoothed[slot] = self.smoothed[slot].min(minimum);
                self.envelope = self.envelope.min(minimum);
            }
        }
        self.smoothed_sum = 0.0;
        for back in 1..=attack + 1 {
            self.smoothed_sum += self.smoothed[(now as usize).wrapping_sub(back) & MASK] as f64;
        }
    }

    fn process(&mut self, now: u32, offset: usize, attack: usize, hold_frames: u32, release_coeff: f32) -> f32 {
        self.push_window(self.target(now, offset), now, attack);
        let minimum = self.window_values[self.window_head];
        if minimum <= self.envelope {
            self.envelope = minimum;
            self.hold_counter = hold_frames;
        } else if self.hold_counter > 0 {
            self.hold_counter -= 1;
        } else {
            self.envelope = minimum + (self.envelope - minimum) * release_coeff;
        }
        let index = now as usize & MASK;
        self.smoothed_sum += self.envelope as f64 - self.smoothed[(now as usize).wrapping_sub(attack + 1) & MASK] as f64;
        self.smoothed[index] = self.envelope;
        ((self.smoothed_sum / (attack + 1) as f64) as f32).min(1.0)
    }
}

pub struct Ducker {
    phases: [[f32; ISP_TAPS]; ISP_PHASES],
    carrier: [Detector; 2],
    sidechain: [Detector; 2],
    paths: [GainPath; 2],
    audio: [[f32; RING]; 2],
    sidechain_levels: [f32; RING],
    sample_rate: f32,
    rms_size: usize,
    max_attack: usize,
    latency: usize,
    now: u32,
    threshold: f32,
    range: f32,
    stereo: f32,
    mix: f32,
    mode: i32,
    attack: usize,
    hold_frames: u32,
    release_coeff: f32,
    applied_attack: usize,
    applied_mode: i32,
    display_frames: u32,
    display_count: u32,
    display_pending: [f32; DISPLAY_VALUES],
    pub display: [[f32; DISPLAY_VALUES]; DISPLAY_ENTRIES],
    pub display_written: u32
}

impl Ducker {
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.max_attack = (libm::roundf(MAX_ATTACK_SECONDS * sample_rate) as usize).clamp(1, MAX_ATTACK_FRAMES);
        self.latency = self.max_attack + ISP_DELAY;
        self.rms_size = (libm::roundf(RMS_SECONDS * sample_rate) as usize).clamp(1, RMS_CAPACITY);
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
        for detector in self.carrier.iter_mut().chain(self.sidechain.iter_mut()) {detector.reset();}
        for path in &mut self.paths {path.reset();}
        self.audio = [[0.0; RING]; 2];
        self.sidechain_levels = [0.0; RING];
        self.now = 0;
        self.applied_attack = usize::MAX;
        self.display_count = 0;
        self.display_pending = [0.0, 0.0, 0.0, 1.0];
    }

    pub fn latency(&self) -> usize {self.latency}
    pub fn set_threshold_db(&mut self, db: f32) {self.threshold = math::db_to_gain(db);}
    pub fn set_range(&mut self, range: f32) {self.range = range;}
    pub fn set_stereo(&mut self, stereo: f32) {self.stereo = stereo.clamp(0.0, 1.0);}
    pub fn set_mix(&mut self, mix: f32) {self.mix = mix.clamp(0.0, 1.0);}
    pub fn set_mode(&mut self, mode: i32) {self.mode = mode.clamp(MODE_PEAK, MODE_RMS);}

    pub fn set_attack_ms(&mut self, ms: f32) {
        self.attack = (libm::roundf(ms.max(0.0) * 0.001 * self.sample_rate) as usize).min(self.max_attack);
    }

    pub fn set_hold_ms(&mut self, ms: f32) {
        self.hold_frames = libm::roundf(ms.max(0.0) * 0.001 * self.sample_rate) as u32;
    }

    pub fn set_release_ms(&mut self, ms: f32) {
        let frames = ms * 0.001 * self.sample_rate;
        self.release_coeff = if frames < 1.0 {0.0} else {libm::expf(-1.0 / frames)};
    }

    fn detector_delay(&self) -> usize {if self.mode == MODE_ISP {ISP_DELAY} else {0}}

    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], side: Option<(&[f32], &[f32])>,
                   out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        let delay = self.detector_delay();
        let offset = self.latency - self.attack - delay;
        if self.applied_attack != self.attack || self.applied_mode != self.mode {
            for path in &mut self.paths {path.rebuild(self.now, offset, self.attack);}
            self.applied_attack = self.attack;
            self.applied_mode = self.mode;
        }
        for index in from..to {
            let inputs = [in_left[index], in_right[index]];
            let carrier = [
                self.carrier[0].detect(inputs[0], self.mode, &self.phases, self.rms_size),
                self.carrier[1].detect(inputs[1], self.mode, &self.phases, self.rms_size)
            ];
            let sidechain = match side {
                Some((left, right)) => [
                    self.sidechain[0].detect(left[index], self.mode, &self.phases, self.rms_size),
                    self.sidechain[1].detect(right[index], self.mode, &self.phases, self.rms_size)
                ],
                None => [0.0, 0.0]
            };
            let linked = target_gain(carrier[0].max(carrier[1]), sidechain[0].max(sidechain[1]), self.threshold, self.range);
            let slot = self.now as usize & MASK;
            self.sidechain_levels[slot] = sidechain[0].max(sidechain[1]);
            let mut outputs = [0.0f32; 2];
            let mut dry_peak = 0.0f32;
            let mut min_gain = 1.0f32;
            for channel in 0..2 {
                let own = target_gain(carrier[channel], sidechain[channel], self.threshold, self.range);
                self.paths[channel].targets[self.now as usize & TARGET_MASK] = linked + self.stereo * (own - linked);
                let gain = self.paths[channel].process(self.now, offset, self.attack, self.hold_frames, self.release_coeff);
                let dry = self.audio[channel][(self.now as usize).wrapping_sub(self.latency) & MASK];
                self.audio[channel][slot] = inputs[channel];
                outputs[channel] = dry + (dry * gain - dry) * self.mix;
                dry_peak = dry_peak.max(dry.abs());
                min_gain = min_gain.min(gain);
            }
            out_left[index] = outputs[0];
            out_right[index] = outputs[1];
            let side_level = self.sidechain_levels[(self.now as usize).wrapping_sub(self.latency - delay) & MASK];
            self.collect(dry_peak, outputs[0].abs().max(outputs[1].abs()), side_level, min_gain);
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

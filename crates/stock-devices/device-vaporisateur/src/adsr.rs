//! A local, faithful port of lib-dsp `adsr.ts`: a linear ADSR with a per-state rate model that RESCALES the
//! remaining ramp when the times change mid-flight (`update_rates`). `gate` is true while held (not Idle, not
//! Release); `complete` is Idle. `phase` (0..4 across the stages) mirrors the TS field for completeness. This
//! is kept LOCAL to the device (the shared `dsp::adsr` is a different, simpler envelope used by other devices).

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Idle,
    Attack,
    Decay,
    Sustain,
    Release
}

#[derive(Clone, Copy, Default)]
pub struct Adsr {
    inv_sample_rate: f64,
    state: State,
    value: f64,
    phase: f64,
    attack: f64,
    decay: f64,
    sustain: f64,
    release: f64,
    attack_inc: f64,
    decay_dec: f64,
    release_dec: f64
}

impl Adsr {
    pub fn new(sample_rate: f32) -> Self {
        Self {inv_sample_rate: 1.0 / sample_rate as f64, ..Self::default()}
    }

    pub fn gate(&self) -> bool {
        self.state != State::Idle && self.state != State::Release
    }

    pub fn is_complete(&self) -> bool {
        self.state == State::Idle
    }

    pub fn set(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        self.attack = attack as f64;
        self.decay = decay as f64;
        self.sustain = sustain as f64;
        self.release = release as f64;
        self.update_rates();
    }

    fn update_rates(&mut self) {
        match self.state {
            State::Attack => {
                let remain = 1.0 - self.value;
                self.attack_inc = remain * self.inv_sample_rate / self.attack.max(1.0e-6);
            }
            State::Decay => {
                let remain = self.value - self.sustain;
                self.decay_dec = remain * self.inv_sample_rate / self.decay.max(1.0e-6);
            }
            State::Release => {
                let remain = self.value;
                self.release_dec = remain * self.inv_sample_rate / self.release.max(1.0e-6);
            }
            State::Sustain | State::Idle => {
                self.attack_inc = self.inv_sample_rate / self.attack.max(1.0e-6);
                self.decay_dec = (1.0 - self.sustain) * self.inv_sample_rate / self.decay.max(1.0e-6);
                self.release_dec = self.sustain * self.inv_sample_rate / self.release.max(1.0e-6);
            }
        }
    }

    pub fn gate_on(&mut self) {
        self.state = State::Attack;
    }

    pub fn gate_off(&mut self) {
        if self.state != State::Idle {
            self.state = State::Release;
            self.update_rates();
        }
    }

    pub fn force_stop(&mut self) {
        self.state = State::Idle;
        self.value = 0.0;
    }

    pub fn process(&mut self, output: &mut [f32], from: usize, to: usize) {
        let mut index = from;
        while index < to {
            match self.state {
                State::Attack => {
                    while index < to {
                        self.value += self.attack_inc;
                        if self.value >= 1.0 {
                            self.value = 1.0;
                            self.phase = 1.0;
                            output[index] = self.value as f32;
                            index += 1;
                            self.state = State::Decay;
                            self.update_rates();
                            break;
                        }
                        self.phase = self.value;
                        output[index] = self.value as f32;
                        index += 1;
                    }
                }
                State::Decay => {
                    while index < to {
                        self.value -= self.decay_dec;
                        if self.value <= self.sustain {
                            self.value = self.sustain;
                            self.phase = 2.0;
                            output[index] = self.value as f32;
                            index += 1;
                            self.state = State::Sustain;
                            self.update_rates();
                            break;
                        }
                        self.phase = 1.0 + (1.0 - self.value) / (1.0 - self.sustain);
                        output[index] = self.value as f32;
                        index += 1;
                    }
                }
                State::Sustain => {
                    for sample in &mut output[index..to] {
                        *sample = self.sustain as f32;
                    }
                    return;
                }
                State::Release => {
                    while index < to {
                        self.value -= self.release_dec;
                        if self.value <= 0.0 {
                            self.value = 0.0;
                            self.phase = 0.0;
                            output[index] = self.value as f32;
                            index += 1;
                            self.state = State::Idle;
                            self.update_rates();
                            break;
                        }
                        self.phase = 3.0 + (1.0 - self.value / self.sustain);
                        output[index] = self.value as f32;
                        index += 1;
                    }
                }
                State::Idle => {
                    for sample in &mut output[index..to] {
                        *sample = 0.0;
                    }
                    return;
                }
            }
        }
    }
}

//! A linear ADSR envelope, mirroring lib-dsp `adsr.ts`. A per-sample state machine
//! (Idle → Attack → Decay → Sustain → Release → Idle) advanced one sample at a time by `next_value`.
//! Rates are derived from times in seconds; the release rate is computed from the value held when the
//! gate drops, so release always takes the configured time regardless of where it began.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release
}

pub struct Adsr {
    sample_rate: f32,
    attack: f32,  // seconds
    decay: f32,   // seconds
    sustain: f32, // level 0..=1
    release: f32, // seconds
    state: State,
    value: f32,
    attack_inc: f32,
    decay_dec: f32,
    release_dec: f32
}

/// Per-sample increment for a ramp over `seconds`; an instant step (huge increment) when `seconds<=0`.
fn rate(span: f32, seconds: f32, sample_rate: f32) -> f32 {
    if seconds > 0.0 {span / (seconds * sample_rate)} else {f32::INFINITY}
}

impl Adsr {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            attack: 0.0,
            decay: 0.0,
            sustain: 1.0,
            release: 0.0,
            state: State::Idle,
            value: 0.0,
            attack_inc: f32::INFINITY,
            decay_dec: f32::INFINITY,
            release_dec: f32::INFINITY
        }
    }

    pub fn set(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        self.attack = attack;
        self.decay = decay;
        self.sustain = sustain;
        self.release = release;
    }

    pub fn gate_on(&mut self) {
        self.state = State::Attack;
        self.attack_inc = rate(1.0, self.attack, self.sample_rate);
    }

    pub fn gate_off(&mut self) {
        if self.state != State::Idle {
            self.state = State::Release;
            self.release_dec = rate(self.value, self.release, self.sample_rate);
        }
    }

    /// Cut to silence immediately (voice stealing).
    pub fn force_stop(&mut self) {
        self.state = State::Idle;
        self.value = 0.0;
    }

    pub fn is_idle(&self) -> bool {
        self.state == State::Idle
    }

    /// Advance one sample and return the envelope value in `[0, 1]`.
    pub fn next_value(&mut self) -> f32 {
        match self.state {
            State::Idle => 0.0,
            State::Attack => {
                self.value += self.attack_inc;
                if self.value >= 1.0 {
                    self.value = 1.0;
                    self.state = State::Decay;
                    self.decay_dec = rate(1.0 - self.sustain, self.decay, self.sample_rate);
                }
                self.value
            }
            State::Decay => {
                self.value -= self.decay_dec;
                if self.value <= self.sustain {
                    self.value = self.sustain;
                    self.state = State::Sustain;
                }
                self.value
            }
            State::Sustain => self.sustain,
            State::Release => {
                self.value -= self.release_dec;
                if self.value <= 0.0 {
                    self.value = 0.0;
                    self.state = State::Idle;
                }
                self.value
            }
        }
    }
}

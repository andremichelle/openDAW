//! A linear parameter ramp (TS lib-dsp `Ramp.linear`): smooths a value toward a target over a short time
//! (default 5 ms) to de-click parameter jumps (volume, pan, mute). `set(target, smooth)` either ramps
//! (smooth) or jumps; `move_and_get` advances one sample. Stateful, single-value, f32 (the signal path).

/// Samples over which a smooth `set` interpolates, from a sample rate and a duration (default 5 ms).
fn ramp_length(sample_rate: f32, duration_seconds: f32) -> u32 {
    ((sample_rate * duration_seconds) as u32).max(1)
}

pub struct LinearRamp {
    length: u32,
    value: f32,
    target: f32,
    delta: f32,
    remaining: u32
}

impl LinearRamp {
    /// A ramp interpolating over `duration_seconds` at `sample_rate`.
    pub fn new(sample_rate: f32, duration_seconds: f32) -> Self {
        Self {length: ramp_length(sample_rate, duration_seconds), value: 0.0, target: 0.0, delta: 0.0, remaining: 0}
    }

    /// The default 5 ms ramp (TS `Ramp.linear(sampleRate)`).
    pub fn linear(sample_rate: f32) -> Self {
        Self::new(sample_rate, 0.005)
    }

    /// Aim at `target`. `smooth` ramps over `length` samples; otherwise jump immediately (the first block,
    /// before any ramp state exists). Idempotent for an UNCHANGED target: re-`set`ting the same target is a
    /// no-op, so a caller that calls `set` every block (reading a live parameter) lets an in-flight ramp
    /// finish instead of restarting it each block. (TS guards via an `updateGain` flag + a value check.)
    pub fn set(&mut self, target: f32, smooth: bool) {
        if self.target == target {
            return;
        }
        if smooth {
            self.target = target;
            self.delta = (target - self.value) / self.length as f32;
            self.remaining = self.length;
        } else {
            self.value = target;
            self.target = target;
            self.delta = 0.0;
            self.remaining = 0;
        }
    }

    pub fn get(&self) -> f32 {
        self.value
    }

    /// Advance one sample toward the target and return the new value.
    pub fn move_and_get(&mut self) -> f32 {
        if self.remaining > 0 {
            self.value += self.delta;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.delta = 0.0;
                self.value = self.target;
            }
        }
        self.value
    }

    pub fn is_interpolating(&self) -> bool {
        self.remaining > 0
    }
}

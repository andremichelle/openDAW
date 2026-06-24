//! A fractional delay line with smooth offset interpolation, a buffer-BORROWING port of lib-dsp `Delay` (the
//! pre-delay). The device owns the pow2-sized buffer in its rate-sized state and passes it in each call; this
//! struct holds only the read/write head state, so it is heap-free and valid when zeroed. Two paths: a plain
//! integer-offset read, and a fractional-interpolating read while the offset glides to a new target.

use math::clamp;

#[derive(Clone, Copy, Default)]
pub struct PreDelay {
    interpolation_length: i32,
    write_position: usize,
    current_offset: f64,
    target_offset: f64,
    delta_offset: f64,
    alpha_position: i32,
    processed: bool,
    interpolating: bool
}

impl PreDelay {
    pub fn new(interpolation_length: i32) -> Self {
        Self {interpolation_length, ..Self::default()}
    }

    /// Reset the read/write heads and clear the (provided) buffer if it has been written. Mirrors `clear`.
    pub fn clear(&mut self, buffer: &mut [f32]) {
        self.write_position = 0;
        if self.processed {
            buffer.fill(0.0);
            self.processed = false;
        }
        self.init_delay_time();
    }

    /// Set the delay offset in frames. The caller clamps to `[0, size)`. A change while running glides to it
    /// over `interpolation_length`; before the first process it jumps. Mirrors the `offset` setter.
    pub fn set_offset(&mut self, value: f64) {
        self.target_offset = value;
        if self.processed {
            self.update_delay_time();
        } else {
            self.init_delay_time();
        }
    }

    /// Write `source` into the delay line `buffer` and read the delayed signal into `target`, over `[from, to)`.
    pub fn process(&mut self, target: &mut [f32], source: &[f32], buffer: &mut [f32], from: usize, to: usize) {
        if self.interpolating {
            self.process_interpolate(target, source, buffer, from, to);
        } else {
            self.process_non_interpolate(target, source, buffer, from, to);
        }
        self.processed = true;
    }

    fn init_delay_time(&mut self) {
        self.current_offset = self.target_offset;
        self.alpha_position = 0;
        self.interpolating = false;
    }

    fn update_delay_time(&mut self) {
        if self.target_offset != self.current_offset {
            self.alpha_position = self.interpolation_length;
            self.delta_offset = (self.target_offset - self.current_offset) / self.alpha_position as f64;
            self.interpolating = true;
        }
    }

    fn process_non_interpolate(&mut self, target: &mut [f32], source: &[f32], buffer: &mut [f32], from: usize, to: usize) {
        let size = buffer.len();
        let mask = size - 1;
        let mut write_position = self.write_position;
        let mut read_position = (write_position as isize - libm::floor(self.current_offset) as isize).rem_euclid(size as isize) as usize;
        for index in from..to {
            buffer[write_position] = source[index];
            target[index] = buffer[read_position];
            read_position = (read_position + 1) & mask;
            write_position = (write_position + 1) & mask;
        }
        self.write_position = write_position;
    }

    fn process_interpolate(&mut self, target: &mut [f32], source: &[f32], buffer: &mut [f32], from: usize, to: usize) {
        let size = buffer.len();
        let mask = size - 1;
        let mut write_position = self.write_position;
        for index in from..to {
            if self.alpha_position > 0 {
                self.current_offset += self.delta_offset;
                self.alpha_position -= 1;
            } else {
                self.current_offset = self.target_offset;
                self.interpolating = false;
            }
            buffer[write_position] = source[index];
            let mut read_position = write_position as f64 - self.current_offset;
            if read_position < 0.0 {
                read_position += size as f64;
            }
            let read_int = libm::floor(read_position) as usize;
            let alpha = (read_position - read_int as f64) as f32;
            let read0 = buffer[read_int & mask];
            target[index] = read0 + alpha * (buffer[(read_int + 1) & mask] - read0);
            write_position = (write_position + 1) & mask;
        }
        self.write_position = write_position;
    }
}

/// Clamp a pre-delay offset to a valid frame range `[0, size - 1]`, mirroring the device's setter clamp.
pub fn clamp_offset(value: f64, size: usize) -> f64 {
    clamp(value, 0.0, (size - 1) as f64)
}

#[cfg(test)]
mod tests {
    use super::PreDelay;

    #[test]
    fn delays_an_impulse_by_the_integer_offset() {
        let mut delay = PreDelay::new(12_000);
        delay.set_offset(4.0); // before the first process -> jumps to 4
        let mut buffer = [0.0f32; 16];
        let mut source = [0.0f32; 8];
        source[0] = 1.0;
        let mut target = [0.0f32; 8];
        delay.process(&mut target, &source, &mut buffer, 0, 8);
        assert_eq!(target[4], 1.0, "the impulse comes out 4 frames later");
        assert!(target.iter().enumerate().all(|(index, value)| index == 4 || *value == 0.0), "and nowhere else");
    }

    #[test]
    fn a_zero_offset_passes_through() {
        let mut delay = PreDelay::new(12_000);
        delay.set_offset(0.0);
        let mut buffer = [0.0f32; 16];
        let source = [0.3f32; 8];
        let mut target = [0.0f32; 8];
        delay.process(&mut target, &source, &mut buffer, 0, 8);
        assert!(target.iter().all(|value| (*value - 0.3).abs() < 1.0e-6), "offset 0 is a pass-through");
    }
}

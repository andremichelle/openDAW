//! An oscillator for struck sounds: its phase is set on every hit (so every hit starts the same), a sine and a
//! triangle that a soft clipper bends from triangle (drive near 0) over sine (about 1.6) to square (high drive).
//! Valid when zeroed.

use crate::fast_math::fast_sin_tau;

#[derive(Clone, Copy, Default, Debug)]
pub struct DrumOscillator {
    phase: f64
}

impl DrumOscillator {
    /// `phase` in periods, 0 starts at the zero crossing going up.
    pub fn reset(&mut self, phase: f64) {self.phase = phase - libm::floor(phase);}

    #[inline]
    fn advance(&mut self, frequency: f32, sample_rate: f32) -> f64 {
        let phase = self.phase;
        self.phase += frequency as f64 / sample_rate as f64;
        self.phase -= libm::floor(self.phase);
        phase
    }

    #[inline]
    pub fn sine(&mut self, frequency: f32, sample_rate: f32) -> f32 {
        fast_sin_tau(self.advance(frequency, sample_rate)) as f32
    }

    #[inline]
    pub fn triangle(&mut self, frequency: f32, sample_rate: f32, drive: f32) -> f32 {
        clip(triangle_at(self.advance(frequency, sample_rate) as f32), drive)
    }

    /// One `shape` from 0 to 1: a sine (0) blending into a triangle (0.5), then clipped harder towards a square (1).
    #[inline]
    pub fn shaped(&mut self, frequency: f32, sample_rate: f32, shape: f32) -> f32 {
        let phase = self.advance(frequency, sample_rate);
        let triangle = triangle_at(phase as f32);
        if shape <= 0.5 {
            let sine = fast_sin_tau(phase) as f32;
            sine + (triangle - sine) * shape * 2.0
        } else {
            clip(triangle, (shape - 0.5) * 2.0 * SQUARE_DRIVE)
        }
    }
}

const SQUARE_DRIVE: f32 = 20.0;

#[inline]
fn triangle_at(phase: f32) -> f32 {
    if phase < 0.25 {4.0 * phase} else if phase < 0.75 {2.0 - 4.0 * phase} else {4.0 * phase - 4.0}
}

#[inline]
fn clip(triangle: f32, drive: f32) -> f32 {
    if drive < 0.01 {triangle} else {libm::tanhf(drive * triangle) / libm::tanhf(drive)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(mut source: impl FnMut() -> f32) -> [f32; 480] {core::array::from_fn(|_| source())}

    fn harmonic_level(wave: &[f32], harmonic: usize) -> f32 {
        let (mut re, mut im) = (0.0f32, 0.0f32);
        for (index, value) in wave.iter().enumerate() {
            let angle = 2.0 * core::f32::consts::PI * harmonic as f32 * index as f32 / wave.len() as f32;
            re += value * libm::cosf(angle);
            im += value * libm::sinf(angle);
        }
        libm::sqrtf(re * re + im * im) * 2.0 / wave.len() as f32
    }

    #[test]
    fn every_hit_starts_identically() {
        let mut oscillator = DrumOscillator::default();
        oscillator.reset(0.0);
        let first = render(|| oscillator.sine(100.0, RATE));
        oscillator.reset(0.0);
        let second = render(|| oscillator.sine(100.0, RATE));
        assert_eq!(first, second);
        assert!(first[0].abs() < 1e-6 && first[1] > 0.0, "starts at the rising zero crossing");
    }

    #[test]
    fn drive_bends_triangle_to_sine_to_square() {
        let mut oscillator = DrumOscillator::default();
        let mut third = |drive: f32| {
            oscillator.reset(0.0);
            let wave = render(|| oscillator.triangle(100.0, RATE, drive));
            harmonic_level(&wave, 3) / harmonic_level(&wave, 1)
        };
        let (triangle, sine, square) = (third(0.0), third(1.6), third(20.0));
        assert!((triangle - 1.0 / 9.0).abs() < 0.01, "triangle third harmonic is 1/9, {triangle}");
        assert!(sine < 0.03, "near sine, {sine}");
        assert!((square - 1.0 / 3.0).abs() < 0.03, "near square, {square}");
    }

    #[test]
    fn shape_runs_sine_triangle_square_without_jumps() {
        let mut oscillator = DrumOscillator::default();
        let mut third = |shape: f32| {
            oscillator.reset(0.0);
            let wave = render(|| oscillator.shaped(100.0, RATE, shape));
            harmonic_level(&wave, 3) / harmonic_level(&wave, 1)
        };
        assert!(third(0.0) < 0.001);
        assert!((third(0.5) - 1.0 / 9.0).abs() < 0.01);
        assert!((third(0.5001) - third(0.5)).abs() < 0.005, "continuous at the middle");
        assert!((third(1.0) - 1.0 / 3.0).abs() < 0.03);
    }

    #[test]
    fn pitch_is_exact() {
        let mut oscillator = DrumOscillator::default();
        let wave = render(|| oscillator.sine(100.0, RATE));
        let ups = wave.windows(2).filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0).count();
        assert_eq!(ups, 0, "one period in 480 samples has its rising crossing only at the start");
        assert!(harmonic_level(&wave, 1) > 0.99);
    }
}

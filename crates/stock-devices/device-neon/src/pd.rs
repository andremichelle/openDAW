//! Phase distortion: a cosine read through a bent phase map. `w` (0..1, the DCW amount) interpolates the
//! phase transfer linearly between identity (pure cosine) and the wave's full map — the CZ's "filter". The
//! resonance waves are windowed sync instead: a cosine swept to `k`× the fundamental, re-synced each cycle,
//! shaped by a falling window and pinned to +1 at the cycle edges (`win·(cos−1)+1`), the hardware's trick to
//! keep the wrap continuous. Knee positions and the `k` sweep range are calibration points (VirtualCZ A/B).

use core::f32::consts::TAU;

/// Panel wave indices (the adapter's `Neon.Waves` order).
// WASM CONTRACT: mirrors `Neon.Waves` in NeonDeviceBoxAdapter.ts.
pub const WAVE_SAW: i32 = 0;
pub const WAVE_SQUARE: i32 = 1;
pub const WAVE_PULSE: i32 = 2;
pub const WAVE_DOUBLE_SINE: i32 = 3;
pub const WAVE_SAW_PULSE: i32 = 4;
pub const WAVE_RES_SAW: i32 = 5;
pub const WAVE_RES_TRIANGLE: i32 = 6;
pub const WAVE_RES_TRAPEZOID: i32 = 7;

fn frac(value: f32) -> f32 {
    value - libm::floorf(value)
}

fn cosine(phase: f32) -> f32 {
    libm::cosf(TAU * phase)
}

// The DCW moves each wave's KNEE POSITION (the hardware behavior), not a crossfade toward the extreme
// map — a crossfaded map keeps a sharp slope corner at every amount and measures 10-25dB too hot in the
// high partials against VirtualCZ. At `w == 0` every knee sits where the map is the identity (pure cosine).
fn knee(w: f32, identity: f32, full: f32) -> f32 {
    identity + (full - identity) * w
}

fn m_saw(x: f32, w: f32, edge: f32) -> f32 {
    let d = knee(w, 0.5, 0.0).max(0.022 * edge);
    if x < d {0.5 * x / d} else {0.5 + 0.5 * (x - d) / (1.0 - d)}
}

fn m_square(x: f32, w: f32, edge: f32) -> f32 {
    let d = knee(w, 0.5, 0.0).max(0.03 * edge);
    if x < d {0.5 * x / d}
    else if x < 0.5 {0.5}
    else if x < 0.5 + d {0.5 + 0.5 * (x - 0.5) / d}
    else {1.0}
}

fn m_pulse(x: f32, w: f32, edge: f32) -> f32 {
    let d = (knee(w, 1.0, 0.0) * (1.0 + 1.0 * (w - 0.55).max(0.0) * edge.min(1.0))).max(0.033 * edge);
    if x < d {x / d} else {1.0}
}

// Measured on the VirtualCZ DCW sweep: double sine is ALWAYS two full cycles — EQUAL at DCW 0 (a pure
// octave sine) and squeezing the second cycle as DCW rises, until the fundamental dominates with a flat
// ≈ −24dB overtone shelf at DCW 99 (the impulse-like squeezed cycle). Matches the pete reference.
fn m_double_sine(x: f32, w: f32, edge: f32) -> f32 {
    let a = (0.5 + 0.5 * w).min(1.0 - 0.025 * edge);
    if x < a {x / a} else {1.0 + (x - a) / (1.0 - a)}
}

fn m_saw_pulse(x: f32, w: f32, edge: f32) -> f32 {
    let d = knee(w, 0.5, 0.0).max(0.022 * edge);
    if x < 0.5 {x}
    else if x < 0.5 + d {0.5 + 0.5 * (x - 0.5) / d}
    else {1.0}
}

fn bent(x: f32, w: f32, edge: f32, map: fn(f32, f32, f32) -> f32) -> f32 {
    cosine(map(x, w, edge))
}

fn window_saw(x: f32) -> f32 {
    1.0 - x
}

fn window_triangle(x: f32) -> f32 {
    1.0 - libm::fabsf(2.0 * x - 1.0)
}

fn window_trapezoid(x: f32) -> f32 {
    (2.0 * (1.0 - x)).min(1.0)
}

fn resonant(x: f32, w: f32, window: fn(f32) -> f32) -> f32 {
    let k = 1.0 + w * 15.0;
    window(x) * (cosine(frac(x * k)) - 1.0) + 1.0
}

/// The hardware orientation of each panel wave relative to these maps, measured via VirtualCZ wave-PAIR
/// probes (a pair's second cycle plays time-reversed exactly when the two orientations differ; solo
/// rendering is orientation-invariant). Cross-checked: square+pulse SAME, pulse+reso1 OPPOSITE.
pub fn orientation(wave: i32) -> bool {
    matches!(wave, WAVE_SQUARE | WAVE_PULSE | WAVE_DOUBLE_SINE)
}

/// One sample of panel wave `wave` at phase `x` (0..1) with distortion amount `w` (0..1).
/// The DCW laws live in PHASE domain (mid-amount knees are pitch-independent, preset battery p02/p04/
/// p07/p22), but the w→1 extreme is clamped at a constant-TIME floor: `edge` = frequency / 261.63 scales
/// only the FLOOR — low notes keep sharp edges (were 25-31dB dull on top), note-60 calibration exact.
pub fn render(wave: i32, x: f32, w: f32, edge: f32) -> f32 {
    let edge = edge.clamp(0.05, 10.0);
    match wave {
        WAVE_SAW => bent(x, w, edge, m_saw),
        WAVE_SQUARE => bent(x, w, edge, m_square),
        WAVE_PULSE => bent(x, w, edge, m_pulse),
        WAVE_DOUBLE_SINE => bent(x, w, edge, m_double_sine),
        WAVE_SAW_PULSE => bent(x, w, edge, m_saw_pulse),
        WAVE_RES_SAW => resonant(x, w, window_saw),
        WAVE_RES_TRIANGLE => resonant(x, w, window_triangle),
        WAVE_RES_TRAPEZOID => resonant(x, w, window_trapezoid),
        _ => resonant(x, w, window_trapezoid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: usize = 512;

    fn cycle(wave: i32, w: f32) -> [f32; N] {
        let mut out = [0.0f32; N];
        for (index, sample) in out.iter_mut().enumerate() {
            *sample = render(wave, index as f32 / N as f32, w, 1.0);
        }
        out
    }

    #[test]
    fn zero_distortion_is_a_pure_cosine_for_every_bent_wave() {
        // Double sine is exempt: VirtualCZ measures it as a pure OCTAVE (two equal cycles) at DCW 0.
        for wave in [WAVE_SAW, WAVE_SQUARE, WAVE_PULSE, WAVE_SAW_PULSE] {
            let out = cycle(wave, 0.0);
            for (index, sample) in out.iter().enumerate() {
                let expected = cosine(index as f32 / N as f32);
                assert!((sample - expected).abs() < 1.0e-5, "wave {wave} sample {index}: {sample} vs cosine {expected}");
            }
        }
    }

    #[test]
    fn full_saw_is_saw_shaped_not_cosine() {
        let out = cycle(WAVE_SAW, 1.0);
        let cos_error: f32 = out.iter().enumerate()
            .map(|(index, sample)| (sample - cosine(index as f32 / N as f32)).abs())
            .sum();
        assert!(cos_error / N as f32 > 0.1, "full distortion must leave the cosine shape behind");
        assert!((out[0] - 1.0).abs() < 1.0e-4, "every PD wave starts at +1 (cosine table)");
    }

    #[test]
    fn all_waves_stay_bounded() {
        for wave in 0..8 {
            for w in [0.0, 0.3, 0.7, 1.0] {
                for sample in cycle(wave, w) {
                    assert!(sample.abs() <= 1.0 + 1.0e-4, "wave {wave} w {w} exceeded ±1: {sample}");
                }
            }
        }
    }

    #[test]
    fn resonant_waves_are_continuous_at_the_wrap() {
        for wave in [WAVE_RES_SAW, WAVE_RES_TRIANGLE, WAVE_RES_TRAPEZOID] {
            for w in [0.25, 0.5, 1.0] {
                let head = render(wave, 0.0, w, 1.0);
                let tail = render(wave, 1.0 - 1.0e-4, w, 1.0);
                assert!((head - tail).abs() < 0.1, "wave {wave} w {w} wraps {tail} -> {head}");
            }
        }
    }
}

//! One transient marker plus everything measured about the segment it opens (to the next marker or
//! EOF). DRAFT: fields and their extraction algorithms are hypotheses the lab harness validates or
//! kills — nothing here is a stable contract yet. `bare()` wraps a plain position (today's
//! `TransientMarkerBox` data) with neutral descriptors so the legacy playback path needs no analysis.

use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransientDescriptor {
    /// Onset position in source SECONDS (same meaning as today's bare marker).
    pub position: f64,
    /// Attack sharpness in [0, 1]: ~1 = drum hit, ~0 = pad swell. Drives fade lengths.
    pub strength: f32,
    /// Fundamental period in source SAMPLES; 0.0 = aperiodic (no pitch-synchronous looping).
    pub period: f32,
    /// Tonality in [0, 1] from spectral flatness: 1 = clean harmonic, 0 = noise.
    pub harmonicity: f32,
    /// Segment RMS (linear), context for gating near-silent segments.
    pub rms: f32,
    /// Precomputed pitch-snapped, correlation-aligned loop region in source SAMPLES.
    /// `loop_end <= loop_start` means "no precomputed loop" (runtime falls back to margins).
    pub loop_start: f64,
    pub loop_end: f64,
    /// Normalized correlation of the loop splice (0 = unaligned/fallback). Picks the splice law:
    /// linear above ~0.35 (coherent sum), equal-power below (uncorrelated power fill).
    pub loop_score: f32,
    /// Intrinsic envelope (beat) period in SECONDS; 0 = no beating detected. Beating material
    /// cannot splice cleanly at any point — it prefers read-through over wrapping.
    pub beat_seconds: f32,
    /// RMS of the loop window itself — continuation across boundaries requires the sustained
    /// window to be level-representative of the segment (a decaying texture's loop is not).
    pub loop_rms: f32
}

impl TransientDescriptor {
    /// A position-only marker with neutral descriptors: full strength (legacy fades), aperiodic,
    /// no precomputed loop — the exact behavior of today's bare `Vec<f64>` transients.
    pub fn bare(position: f64) -> Self {
        Self {position, strength: 1.0, period: 0.0, harmonicity: 0.0, rms: 0.0, loop_start: 0.0, loop_end: -1.0, loop_score: 0.0, beat_seconds: 0.0, loop_rms: 0.0}
    }

    pub fn bare_all(positions: &[f64]) -> Vec<Self> {
        positions.iter().map(|&position| Self::bare(position)).collect()
    }

    pub fn has_loop(&self) -> bool {
        self.loop_end > self.loop_start
    }
}

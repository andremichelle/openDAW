//! Every magic number of the analyzer and the playback runtime, as plain data so the lab harness can
//! sweep them programmatically. `legacy()` reproduces the shipped engine's constants exactly (the
//! parity anchor); `adaptive()` enables the descriptor-driven behavior under development. Nothing in
//! here is final — each value must earn its place by moving a metric in `stretch-lab`.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tuning {
    /// Descriptor-driven playback on/off. Off = the exact legacy code paths.
    pub adaptive: bool,
    /// Equal-power (cos/sin) voice + loop crossfades instead of linear.
    pub equal_power_fades: bool,
    /// Base voice fade in/out length (legacy: the fixed VOICE_FADE_DURATION).
    pub voice_fade_seconds: f64,
    /// Adaptive voice-fade range, chosen by onset strength: strong -> min (punch), weak -> max (soft).
    pub voice_fade_min_seconds: f64,
    pub voice_fade_max_seconds: f64,
    /// A voice fade never exceeds this fraction of the segment's output duration.
    pub voice_fade_segment_cap: f64,
    /// Base loop crossfade length (legacy: the fixed LOOP_FADE_DURATION).
    pub loop_fade_seconds: f64,
    /// Adaptive loop-fade range, chosen by harmonicity: noisy -> min, tonal -> max.
    pub loop_fade_min_seconds: f64,
    pub loop_fade_max_seconds: f64,
    /// Loop region margins inside a segment (legacy LOOP_MARGIN_START/END).
    pub loop_margin_start_seconds: f64,
    pub loop_margin_end_seconds: f64,
    /// How far past the block end the sequencer looks for the next transient boundary
    /// (legacy: coupled to VOICE_FADE_DURATION; decoupled here so adaptive fades cannot
    /// silently change boundary timing).
    pub transient_shift_seconds: f64,
    /// Drift-continuation threshold at a boundary (legacy: coupled to VOICE_FADE_DURATION).
    pub drift_threshold_seconds: f64,
    /// Voice read-position projection when testing continuation (legacy: coupled).
    pub boundary_lookahead_seconds: f64,
    /// Pre-roll read-back before a segment start on a fresh boundary spawn (legacy: coupled).
    pub preroll_seconds: f64
}

impl Tuning {
    /// The shipped engine's exact constants: linear fades, everything 20/10 ms, margins 10/20 ms.
    pub fn legacy() -> Self {
        Self {
            adaptive: false,
            equal_power_fades: false,
            voice_fade_seconds: 0.020,
            voice_fade_min_seconds: 0.005,
            voice_fade_max_seconds: 0.060,
            voice_fade_segment_cap: 0.4,
            loop_fade_seconds: 0.010,
            loop_fade_min_seconds: 0.005,
            loop_fade_max_seconds: 0.040,
            loop_margin_start_seconds: 0.010,
            loop_margin_end_seconds: 0.020,
            transient_shift_seconds: 0.020,
            drift_threshold_seconds: 0.020,
            boundary_lookahead_seconds: 0.020,
            preroll_seconds: 0.020
        }
    }

    /// The descriptor-driven mode under development (Phase 4). Starts from legacy values with the
    /// adaptive machinery enabled; the harness tunes from here.
    pub fn adaptive() -> Self {
        Self {adaptive: true, equal_power_fades: true, ..Self::legacy()}
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self::legacy()
    }
}

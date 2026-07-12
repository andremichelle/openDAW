//! Every gate constant of the judge, one place, all TUNABLE — initial values from the plan
//! (`plans/stretch/README.md`), revisable when the numbers teach us otherwise.

/// A target metric must improve by more than this (in its own unit) to count as an improvement.
pub const TARGET_SLACK: f64 = 1.0;
/// A guard metric may drift by this much (in its own unit) versus the reference before it trips.
pub const GUARD_SLACK: f64 = 0.15;

/// Absolute guard bands (hold regardless of history). The attack guards are SMEAR guards: slow
/// rise or collapsed crest fails; a faster-than-source rise or a punchier crest does not (sparse
/// impulsive material legitimately reads punchier when loops repeat quiet tails).
pub const ATTACK_RISE_MIN: f64 = 0.5;
pub const ATTACK_RISE_MAX: f64 = 1.4;
pub const ATTACK_CREST_MIN: f64 = 0.7;
/// Independent-analyzer attack floor: calibrated to flag catastrophic smear, not 5% shades.
pub const SA_ATTACK_MIN: f64 = 0.6;
pub const SPECTRAL_DELTA_MAX_DB: f64 = 2.5;
pub const LEVEL_DELTA_MAX_DB: f64 = 2.0;
pub const TRAILING_SILENCE_MAX: f64 = 0.15;

/// Phase 0 pain gate: the BASELINE must show the pad symptom this loudly (or the metric is wrong).
pub const BASELINE_PAD_MOD_MIN_DB: f64 = -20.0;
pub const BASELINE_SINE_SIDEBAND_MIN_DB: f64 = -25.0;

/// Phase 4 exit gate.
pub const PAD_MOD_IMPROVEMENT_DB: f64 = 12.0;
pub const PAD_MOD_ABSOLUTE_DB: f64 = -40.0;
pub const SINE_SIDEBAND_ABSOLUTE_DB: f64 = -40.0;

/// Below these values a target metric is inaudible; moves that stay under the floor neither count
/// as improvements nor block as regressions.
pub fn audibility_floor(name: &str) -> Option<f64> {
    match name {
        "sine_thd_db" => Some(-55.0),
        "sine_sideband_db" => Some(-50.0),
        "mod_band_peak_db" | "mod_expected_db" => Some(5.0),
        "mod_acf_peak" => Some(0.1),
        _ => None
    }
}

/// Metrics whose improvement counts toward an `Improved` verdict. `mod_expected_db` is reported
/// but NOT gated: its expectation assumes the baseline's loop length, and the band-peak sweep is
/// the engine-agnostic (ungameable) version of the same question.
pub const TARGETS: &[&str] = &["spurious_attacks_per_s", "mod_band_peak_db", "mod_acf_peak", "sine_sideband_db", "sine_thd_db", "attack_extra_peaks"];
/// Metrics that must hold (vs reference + absolute bands) for ANY verdict better than Mixed.
pub const GUARDS: &[&str] = &["attack_rise_ratio", "attack_crest_ratio", "sa_attack_ratio", "spectral_delta_db", "level_delta_db", "trailing_silence"];

//! The judge's verdict and report: per-case delta table (baseline / best / current / ideal), the
//! paired-gating verdict — a run is Improved only when a target metric moved AND every guard held
//! simultaneously — and the listening playlist of worst-delta triples.

use std::fmt::Write as FmtWrite;
use crate::metrics::{badness, ideal_value, Direction, MetricValue};
use crate::scores::{lookup, CaseScore, ScoreMap, Scores};
use crate::thresholds;

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Improved,
    Mixed {regressions: Vec<String>},
    Regressed
}

pub struct Judgement {
    pub verdict: Verdict,
    pub improvements: Vec<String>,
    pub regressions: Vec<String>,
    pub guard_violations: Vec<String>,
    pub report: String
}

fn guard_absolute_violation(metric: &MetricValue) -> bool {
    match metric.name {
        "attack_rise_ratio" => metric.value < thresholds::ATTACK_RISE_MIN || metric.value > thresholds::ATTACK_RISE_MAX,
        "attack_crest_ratio" => metric.value < thresholds::ATTACK_CREST_MIN,
        "spectral_delta_db" => metric.value > thresholds::SPECTRAL_DELTA_MAX_DB,
        "level_delta_db" => metric.value > thresholds::LEVEL_DELTA_MAX_DB,
        "trailing_silence" => metric.value > thresholds::TRAILING_SILENCE_MAX,
        _ => false
    }
}

pub fn judge(current: &Scores, baseline: &ScoreMap, best: Option<&ScoreMap>) -> Judgement {
    let reference = best.unwrap_or(baseline);
    let mut improvements = Vec::new();
    let mut regressions = Vec::new();
    let mut guard_violations = Vec::new();
    let mut report = String::new();
    let _ = writeln!(report, "case                              metric               baseline      best   current     ideal");
    for case in &current.cases {
        let case_label = format!("{} x{} {}", case.entry, case.ratio, case.mode);
        for metric in &case.metrics {
            let baseline_value = lookup(baseline, &case.entry, case.ratio, &case.mode, metric.name);
            let best_value = best.and_then(|map| lookup(map, &case.entry, case.ratio, &case.mode, metric.name));
            let reference_value = lookup(reference, &case.entry, case.ratio, &case.mode, metric.name);
            let _ = writeln!(
                report, "{:<33} {:<20} {:>9} {:>9} {:>9.3} {:>9.1}",
                case_label, metric.name,
                baseline_value.map(|value| format!("{value:.3}")).unwrap_or_else(|| "-".into()),
                best_value.map(|value| format!("{value:.3}")).unwrap_or_else(|| "-".into()),
                metric.value, ideal_value(metric.name)
            );
            let identifier = format!("{case_label} {}", metric.name);
            let is_target = thresholds::TARGETS.contains(&metric.name);
            let is_guard = thresholds::GUARDS.contains(&metric.name);
            if is_guard && guard_absolute_violation(metric) {
                // A violation the reference ALREADY had (and the change did not worsen) is
                // pre-existing pain, not this change's fault — the delta check below still
                // catches any worsening.
                let pre_existing = reference_value.map(|value| {
                    let reference_metric = MetricValue {name: metric.name, value, better: metric.better};
                    guard_absolute_violation(&reference_metric)
                }).unwrap_or(false);
                if !pre_existing {
                    guard_violations.push(format!("{identifier} = {:.3} (absolute band)", metric.value));
                }
            }
            if let Some(reference_value) = reference_value {
                let reference_metric = MetricValue {name: metric.name, value: reference_value, better: metric.better};
                let delta_badness = badness(metric) - badness(&reference_metric);
                if is_target {
                    // Below the audibility floor, dB differences are noise — a THD move from -85
                    // to -70 blocks nothing.
                    let floor = thresholds::audibility_floor(metric.name);
                    let both_inaudible = floor.map(|floor| metric.value <= floor && reference_value <= floor).unwrap_or(false);
                    if delta_badness < -thresholds::TARGET_SLACK && !both_inaudible {
                        improvements.push(format!("{identifier}: {reference_value:.3} -> {:.3}", metric.value));
                    } else if delta_badness > thresholds::TARGET_SLACK && !both_inaudible {
                        regressions.push(format!("{identifier}: {reference_value:.3} -> {:.3}", metric.value));
                    }
                }
                if is_guard && delta_badness > guard_slack_for(metric.better) {
                    guard_violations.push(format!("{identifier}: {reference_value:.3} -> {:.3} (vs reference)", metric.value));
                }
            }
        }
    }
    let verdict = if !guard_violations.is_empty() || (!regressions.is_empty() && improvements.is_empty()) {
        if improvements.is_empty() {
            Verdict::Regressed
        } else {
            Verdict::Mixed {regressions: guard_violations.iter().chain(regressions.iter()).cloned().collect()}
        }
    } else if !regressions.is_empty() {
        Verdict::Mixed {regressions: regressions.clone()}
    } else if !improvements.is_empty() {
        Verdict::Improved
    } else {
        Verdict::Mixed {regressions: vec!["no target metric moved".into()]}
    };
    Judgement {verdict, improvements, regressions, guard_violations, report}
}

fn guard_slack_for(direction: Direction) -> f64 {
    match direction {
        Direction::TargetOne => thresholds::GUARD_SLACK,
        _ => thresholds::GUARD_SLACK * 4.0
    }
}

/// The worst current cases (by summed target badness), for the listening playlist.
pub fn worst_cases(current: &Scores, count: usize) -> Vec<&CaseScore> {
    let mut ranked: Vec<(&CaseScore, f64)> = current.cases.iter().map(|case| {
        let total: f64 = case.metrics.iter()
            .filter(|metric| thresholds::TARGETS.contains(&metric.name))
            .map(badness)
            .sum();
        (case, total)
    }).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    ranked.into_iter().take(count).map(|(case, _)| case).collect()
}

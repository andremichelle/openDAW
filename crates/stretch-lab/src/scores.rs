//! Score records and their serialization: a flat TSV for snapshots (line-diffable in git, parsed
//! with `split`, no dependencies) and JSON for human/Claude consumption. `snapshots/baseline.tsv`
//! is written once by `judge baseline`; `snapshots/best.tsv` only ever advances via `judge accept`.

use std::collections::HashMap;
use std::fmt::Write as FmtWrite;
use std::path::Path;
use crate::metrics::{Direction, MetricValue};

#[derive(Clone, Debug)]
pub struct CaseScore {
    pub entry: String,
    pub ratio: f64,
    pub mode: String,
    pub metrics: Vec<MetricValue>
}

pub struct Scores {
    pub engine: String,
    pub cases: Vec<CaseScore>
}

pub type ScoreMap = HashMap<(String, String, String, String), f64>;

fn key(entry: &str, ratio: f64, mode: &str, metric: &str) -> (String, String, String, String) {
    (entry.into(), format!("{ratio}"), mode.into(), metric.into())
}

impl Scores {
    pub fn to_tsv(&self) -> String {
        let mut text = String::from("# engine\tentry\tratio\tmode\tmetric\tvalue\n");
        for case in &self.cases {
            for metric in &case.metrics {
                let _ = writeln!(text, "{}\t{}\t{}\t{}\t{}\t{:.6}", self.engine, case.entry, case.ratio, case.mode, metric.name, metric.value);
            }
        }
        text
    }

    pub fn to_json(&self) -> String {
        let mut text = String::from("{\n");
        let _ = writeln!(text, "  \"engine\": \"{}\",", self.engine);
        let _ = writeln!(text, "  \"cases\": [");
        for (case_index, case) in self.cases.iter().enumerate() {
            let _ = writeln!(text, "    {{\"entry\": \"{}\", \"ratio\": {}, \"mode\": \"{}\", \"metrics\": {{", case.entry, case.ratio, case.mode);
            for (metric_index, metric) in case.metrics.iter().enumerate() {
                let comma = if metric_index + 1 < case.metrics.len() { "," } else { "" };
                let _ = writeln!(text, "      \"{}\": {:.6}{comma}", metric.name, metric.value);
            }
            let comma = if case_index + 1 < self.cases.len() { "," } else { "" };
            let _ = writeln!(text, "    }}}}{comma}");
        }
        text.push_str("  ]\n}\n");
        text
    }

    pub fn as_map(&self) -> ScoreMap {
        let mut map = ScoreMap::new();
        for case in &self.cases {
            for metric in &case.metrics {
                map.insert(key(&case.entry, case.ratio, &case.mode, metric.name), metric.value);
            }
        }
        map
    }
}

pub fn read_tsv(path: &Path) -> Option<ScoreMap> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut map = ScoreMap::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 6 {
            continue;
        }
        let ratio: f64 = fields[2].parse().ok()?;
        let value: f64 = fields[5].parse().ok()?;
        map.insert(key(fields[1], ratio, fields[3], fields[4]), value);
    }
    Some(map)
}

pub fn lookup(map: &ScoreMap, entry: &str, ratio: f64, mode: &str, metric: &str) -> Option<f64> {
    map.get(&key(entry, ratio, mode, metric)).copied()
}

/// The direction registry for values read back from snapshots (TSV carries no direction).
pub fn direction_of(name: &str) -> Direction {
    match name {
        "attack_rise_ratio" | "attack_crest_ratio" => Direction::TargetOne,
        _ => Direction::LowerBetter
    }
}

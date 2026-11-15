//! Fits the openDrum Snare to reference hits by name and prints the parameters and the remaining misses.
//! Run: cargo run -p opendrum-lab --release --bin fit_snare -- SD5050 ST3T3S3
//! `all` fits every snare reference and writes `measured/snare_fits.tsv`.

use opendrum::common::Play;
use opendrum::snare::{Snare, SnareParams};
use opendrum_lab::engine_fit::{run, Axis, Engine};
use opendrum_lab::fit::Card;
use opendrum_lab::measure::Measures;
use std::process::ExitCode;

// Drive is left at 0: it distorts both bodies and the wires together, the inharmonic products sounded ugly next to
// the references (his ears, 2026-11-13), the machines shape each oscillator on its own (that is Shape)
const AXES: [Axis; 15] = [
    Axis {name: "tune", min: 80.0, max: 600.0, log: true},
    Axis {name: "ratio", min: 1.0, max: 3.0, log: false},
    Axis {name: "balance", min: 0.0, max: 1.0, log: false},
    Axis {name: "pitch", min: 0.0, max: 24.0, log: false},
    Axis {name: "sweep", min: 0.001, max: 0.1, log: true},
    Axis {name: "decay", min: 0.02, max: 2.0, log: true},
    Axis {name: "punch", min: -1.0, max: 1.0, log: false},
    Axis {name: "shape", min: 0.0, max: 1.0, log: false},
    Axis {name: "level", min: -48.0, max: -3.0, log: false},
    Axis {name: "wire_decay", min: 0.02, max: 2.0, log: true},
    Axis {name: "width", min: 0.0, max: 1.0, log: false},
    Axis {name: "curve", min: -1.0, max: 1.0, log: false},
    Axis {name: "click", min: 0.0, max: 1.0, log: false},
    Axis {name: "tone", min: 200.0, max: 16000.0, log: true},
    Axis {name: "skin", min: 0.0, max: 1.0, log: false}
];

struct SnareEngine;

impl Engine for SnareEngine {
    fn voice(&self) -> &'static str {"snare"}

    fn card(&self) -> Card {Card::TwoBodies}

    fn axes(&self) -> &[Axis] {&AXES}

    fn render(&self, values: &[f64], sample_rate: f64, seconds: f64) -> Vec<f64> {
        let get = |index: usize| values[index] as f32;
        let params = SnareParams {
            tune: get(0), ratio: get(1), balance: get(2), pitch: get(3), sweep: get(4), decay: get(5), punch: get(6),
            shape: get(7), level: get(8), wire_decay: get(9), width: get(10), curve: get(11),
            click: get(12), tone: get(13), skin: get(14), drive: 0.0, volume: 0.0, velocity: 0.0, play: Play::Mono
        };
        let mut snare = Snare::new(sample_rate as f32);
        snare.note_on(0, 1.0, 0.0, &params);
        let mut output = vec![0.0f32; (seconds * sample_rate) as usize];
        snare.process(&params, &mut output);
        output.into_iter().map(|sample| sample as f64).collect()
    }

    fn starts(&self, reference: &Measures) -> Vec<Vec<f64>> {
        let body = reference.partials.iter().map(|(hz, _)| *hz).filter(|hz| *hz > 80.0 && *hz < 600.0)
            .fold(f64::MAX, f64::min);
        let tune = if body < f64::MAX {body} else {180.0};
        let upper = reference.partials.iter().map(|(hz, _)| hz / tune).find(|ratio| *ratio > 1.2 && *ratio < 3.0).unwrap_or(1.6);
        let decay = (reference.decay40_ms * 1.5 / 1000.0).clamp(0.05, 1.5);
        let noisy = reference.noise_early_db > -30.0;
        let level = if noisy {-4.4} else {-26.0};
        let fall = match (reference.tones_early.first(), reference.tones_late.first()) {
            (Some(early), Some(late)) if late.0 > 0.0 => (12.0 * (early.0 / late.0).log2()).max(0.0),
            _ => 0.0
        };
        let tune = reference.tones_late.first().map(|(hz, _)| *hz).filter(|hz| *hz > 80.0).unwrap_or(tune);
        let bend = (fall * 3.0).clamp(2.0, 20.0);
        vec![
            vec![tune, upper, 0.4, bend, 0.01, decay, 0.0, 0.3, level, decay, 0.5, 0.0, 0.1, 4000.0, 0.0],
            vec![tune, upper, 0.4, bend, 0.02, decay, 0.0, 0.3, level, decay, 0.5, 0.0, 0.1, 4000.0, 0.0],
            vec![tune, upper, 0.4, bend, 0.01, decay, 0.0, 0.3, level, decay, 0.5, 0.7, 0.1, 4000.0, 0.0],
            vec![tune, upper, 0.4, bend, 0.005, decay, 0.0, 0.1, level, decay, 0.5, -0.5, 0.1, 4000.0, 0.0],
            vec![tune, upper, 0.6, bend, 0.01, decay, 0.0, 0.8, level - 10.5, decay * 0.6, 0.5, 1.0, 0.0, 3000.0, 0.0],
            vec![tune, upper, 0.6, bend, 0.02, decay, 0.0, 0.5, level - 10.5, decay * 0.6, 0.5, 1.0, 0.0, 3000.0, 0.0],
            vec![tune, upper, 0.3, 2.0, 0.005, decay, 0.0, 0.0, level, decay, 0.5, 0.0, 0.1, 3000.0, 0.0],
            vec![tune, upper, 0.5, 8.0, 0.015, decay * 0.7, 0.3, 0.3, level, decay, 0.5, 0.3, 0.3, 5000.0, 0.0],
            vec![tune, 1.97, 0.2, 0.0, 0.002, decay, 0.0, 0.0, level, decay * 0.6, 0.5, 0.0, 0.0, 2000.0, 0.0],
            vec![tune, 1.46, 0.4, 7.0, 0.01, decay, 0.0, 0.35, level, decay * 1.2, 0.5, 0.0, 0.2, 4000.0, 0.0]
        ]
    }
}

fn main() -> ExitCode {run(&SnareEngine, "snare_fits.tsv")}

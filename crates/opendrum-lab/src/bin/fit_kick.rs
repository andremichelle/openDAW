//! Fits the openDrum Kick to reference hits by name and prints the parameters and the remaining misses.
//! Run: cargo run -p opendrum-lab --release --bin fit_kick -- BD5050 BT3AADA
//! `all` fits every kick reference and writes `measured/kick_fits.tsv`.

use opendrum::common::Play;
use opendrum::kick::{Kick, KickParams};
use opendrum_lab::engine_fit::{run, Axis, Engine};
use opendrum_lab::measure::Measures;
use std::process::ExitCode;

const AXES: [Axis; 12] = [
    Axis {name: "tune", min: 30.0, max: 120.0, log: true},
    Axis {name: "pitch", min: 0.0, max: 48.0, log: false},
    Axis {name: "sweep", min: 0.001, max: 0.2, log: true},
    Axis {name: "drift", min: 0.0, max: 12.0, log: false},
    Axis {name: "decay", min: 0.02, max: 6.0, log: true},
    Axis {name: "punch", min: -1.0, max: 1.0, log: false},
    Axis {name: "shape", min: 0.0, max: 1.0, log: false},
    Axis {name: "click", min: 0.0, max: 1.0, log: false},
    Axis {name: "tone", min: 200.0, max: 16000.0, log: true},
    Axis {name: "skin", min: 0.0, max: 1.0, log: false},
    Axis {name: "drive", min: 0.0, max: 36.0, log: false},
    Axis {name: "noise", min: 0.0, max: 1.0, log: false}
];

struct KickEngine;

impl Engine for KickEngine {
    fn voice(&self) -> &'static str {"kick"}

    fn axes(&self) -> &[Axis] {&AXES}

    fn render(&self, values: &[f64], sample_rate: f64, seconds: f64) -> Vec<f64> {
        let get = |index: usize| values[index] as f32;
        let params = KickParams {
            tune: get(0), pitch: get(1), sweep: get(2), drift: get(3), decay: get(4), punch: get(5), shape: get(6),
            click: get(7), tone: get(8), skin: get(9), rumble: 0.0, length: 0.25, duck: 1.0, drive: get(10), velocity: 0.0,
            bright: 0.25, volume: 0.0, noise: get(11), glide: 0.0, play: Play::Mono
        };
        let mut kick = Kick::new(sample_rate as f32);
        kick.note_on(0, 1.0, 0.0, &params);
        let mut output = vec![0.0f32; (seconds * sample_rate) as usize];
        kick.process(&params, 120.0, &mut output);
        output.into_iter().map(|sample| sample as f64).collect()
    }

    fn starts(&self, reference: &Measures) -> Vec<Vec<f64>> {
        let last_pitch = reference.pitch_hz.iter().rev().find(|hz| hz.is_finite()).copied().unwrap_or(50.0);
        let slope = (reference.decay40_ms - reference.decay20_ms).max(1.0);
        let punchy = slope < reference.decay20_ms * 0.5;
        let decay = if punchy {reference.decay40_ms / 1000.0} else {(slope * 3.0 / 1000.0).clamp(0.03, 5.0)};
        let punch = if punchy {0.9} else {0.0};
        vec![
            vec![last_pitch, 30.0, 0.0045, 5.0, decay, punch, 0.0, 0.05, 2000.0, 0.0, 0.0, 0.5],
            vec![last_pitch, 26.0, 0.015, 0.5, decay, punch, 0.3, 0.6, 4000.0, 0.0, 0.0, 0.5],
            vec![last_pitch, 28.0, 0.01, 1.0, (reference.decay40_ms * 1.5 / 1000.0).clamp(0.05, 5.0), 0.0, 0.3, 0.6, 2500.0, 0.0, 0.0, 0.5],
            vec![50.0, 14.0, 0.006, 2.0, 0.6, 0.0, 0.0, 0.1, 1000.0, 0.0, 0.0, 0.5],
            vec![50.0, 22.0, 0.02, 0.0, 0.4, 0.03, 0.3, 0.6, 6000.0, 0.0, 0.0, 0.5],
            vec![55.0, 18.0, 0.012, 1.0, 1.0, 0.01, 0.15, 0.3, 3000.0, 0.1, 6.0, 0.5]
        ]
    }
}

fn main() -> ExitCode {run(&KickEngine, "kick_fits.tsv")}

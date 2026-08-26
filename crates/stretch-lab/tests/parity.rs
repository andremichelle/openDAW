//! Phase 1 gate: with `Tuning::legacy()` the ported `stretch::Stretcher` must reproduce the FROZEN
//! baseline sample-for-sample across the synthetic corpus and every ratio/mode — the one-time
//! measurement anchor proving the port is faithful, never a sound-preservation goal.

use stretch::{TransientDescriptor, Tuning};
use stretch_lab::corpus;
use stretch_lab::render::{render_baseline, render_stretch, PlayMode, RenderSpec};

#[test]
fn legacy_tuning_matches_the_frozen_baseline_bit_exact() {
    let entries = corpus::synthetic_entries();
    let mut compared = 0usize;
    for entry in &entries {
        for &ratio in &[0.5, 1.5, 2.0, 4.0] {
            for mode in [PlayMode::Once, PlayMode::Repeat, PlayMode::Pingpong] {
                let spec = RenderSpec {
                    left: &entry.left, right: &entry.right, file_rate: entry.file_rate,
                    transients: &entry.transients, ratio, mode
                };
                let (base_left, base_right) = render_baseline(&spec);
                let markers = TransientDescriptor::bare_all(&entry.transients);
                let (new_left, new_right) = render_stretch(&spec, &markers, Tuning::legacy());
                assert_eq!(base_left.len(), new_left.len());
                for index in 0..base_left.len() {
                    assert!(
                        base_left[index] == new_left[index] && base_right[index] == new_right[index],
                        "{} x{ratio} {:?}: first divergence at sample {index}: baseline ({}, {}) vs stretch ({}, {})",
                        entry.id, mode, base_left[index], base_right[index], new_left[index], new_right[index]
                    );
                }
                compared += 1;
            }
        }
    }
    assert!(compared >= 84, "compared {compared} case renders");
}

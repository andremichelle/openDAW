//! A simple energy-rise onset annotator for bootstrapping fixture ground truth (`judge annotate`).
//! Output files are marked machine-generated and MUST be reviewed by ear before they count as
//! ground truth. Replaced by the `stretch` detector once Phase 2 lands.

use super::envelope::{fast_envelope, ENVELOPE_RATE};

const MIN_SEPARATION_MS: usize = 120;
const RISE_THRESHOLD: f32 = 0.12;

/// Onset positions in seconds: local peaks of the fast-envelope derivative above a fraction of the
/// global peak, minimum separation, each backtracked to the start of its rise.
pub fn annotate(mono: &[f32], sample_rate: f32) -> Vec<f64> {
    let envelope = fast_envelope(mono, sample_rate);
    if envelope.len() < 10 {
        return vec![0.0];
    }
    let peak = envelope.iter().fold(0.0f32, |max, value| max.max(*value));
    if peak <= 0.0 {
        return vec![0.0];
    }
    let mut derivative: Vec<f32> = vec![0.0; envelope.len()];
    for index in 3..envelope.len() {
        derivative[index] = (envelope[index] - envelope[index - 3]).max(0.0);
    }
    let threshold = peak * RISE_THRESHOLD;
    let mut onsets: Vec<usize> = Vec::new();
    for index in 1..derivative.len() - 1 {
        if derivative[index] > threshold && derivative[index] >= derivative[index - 1] && derivative[index] > derivative[index + 1] {
            if onsets.last().map(|last| index - last < MIN_SEPARATION_MS).unwrap_or(false) {
                continue;
            }
            let mut start = index;
            while start > 0 && envelope[start - 1] < envelope[start] && envelope[start - 1] > 0.05 * peak {
                start -= 1;
            }
            while start > 0 && envelope[start - 1] > 0.05 * peak && envelope[start] > envelope[start - 1] {
                start -= 1;
            }
            onsets.push(start.min(index));
        }
    }
    let mut positions: Vec<f64> = onsets.iter().map(|&index| index as f64 / ENVELOPE_RATE).collect();
    if positions.first().map(|&first| first > 0.05).unwrap_or(true) {
        positions.insert(0, 0.0);
    }
    positions.dedup_by(|next, previous| *next - *previous < 0.05);
    positions
}

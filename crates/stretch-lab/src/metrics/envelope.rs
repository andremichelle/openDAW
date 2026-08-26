//! Envelope extractors, both emitting a 1 kHz envelope: `fast` (per-hop peak of |x|, for attack
//! timing) and `smooth` (rectified through two one-pole lowpasses, for modulation analysis).

pub const ENVELOPE_RATE: f64 = 1000.0;

pub fn mono(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter().zip(right.iter()).map(|(l, r)| 0.5 * (l + r)).collect()
}

pub fn fast_envelope(samples: &[f32], sample_rate: f32) -> Vec<f32> {
    let hop = (sample_rate as f64 / ENVELOPE_RATE).round() as usize;
    let hop = hop.max(1);
    let mut envelope = Vec::with_capacity(samples.len() / hop + 1);
    for chunk in samples.chunks(hop) {
        envelope.push(chunk.iter().fold(0.0f32, |peak, value| peak.max(value.abs())));
    }
    envelope
}

pub fn smooth_envelope(samples: &[f32], sample_rate: f32) -> Vec<f32> {
    let cutoff_hz = 50.0f64;
    let alpha = (1.0 - (-2.0 * std::f64::consts::PI * cutoff_hz / sample_rate as f64).exp()) as f32;
    let hop = (sample_rate as f64 / ENVELOPE_RATE).round().max(1.0) as usize;
    let mut stage1 = 0.0f32;
    let mut stage2 = 0.0f32;
    let mut envelope = Vec::with_capacity(samples.len() / hop + 1);
    for (index, sample) in samples.iter().enumerate() {
        let rectified = sample.abs();
        stage1 += alpha * (rectified - stage1);
        stage2 += alpha * (stage1 - stage2);
        if index % hop == 0 {
            envelope.push(stage2);
        }
    }
    envelope
}

/// Subtract a centered moving average (the region-fade / material-envelope trend), returning the
/// residual whose periodicity is the grain artifact.
pub fn detrend(envelope: &[f32], window_ms: f64) -> Vec<f32> {
    let window = ((window_ms / 1000.0 * ENVELOPE_RATE).round() as usize).max(1);
    let half = window / 2;
    let mut prefix = vec![0.0f64; envelope.len() + 1];
    for (index, value) in envelope.iter().enumerate() {
        prefix[index + 1] = prefix[index] + *value as f64;
    }
    envelope.iter().enumerate().map(|(index, value)| {
        let from = index.saturating_sub(half);
        let to = (index + half + 1).min(envelope.len());
        let mean = (prefix[to] - prefix[from]) / (to - from) as f64;
        (*value as f64 - mean) as f32
    }).collect()
}

pub fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|value| (*value as f64) * (*value as f64)).sum::<f64>() / samples.len() as f64).sqrt()
}

pub fn mean(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.iter().map(|value| *value as f64).sum::<f64>() / samples.len() as f64
}

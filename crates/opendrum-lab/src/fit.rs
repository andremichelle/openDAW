//! Fits engine parameters to a reference hit: the distance between two report cards and a Nelder-Mead search
//! over normalised parameters. Every dimension has its own tolerance, the distance sums the squared misses in
//! tolerance units, so a value of about the number of dimensions means "within tolerance everywhere".

use crate::measure::{Measures, CENTROID_TIMES_MS, GRID_EDGES, GRID_FRAMES_MS, PITCH_TIMES_MS};

#[derive(Clone, Debug)]
pub struct Miss {
    pub name: String,
    pub reference: f64,
    pub candidate: f64,
    pub units: f64
}

fn semitones(a: f64, b: f64) -> f64 {12.0 * (a / b).log2()}

fn floor_db(value: f64) -> f64 {if value.is_finite() {value.max(-60.0)} else {-60.0}}

/// Which pitch measures a voice is judged by: one body (the zero crossing pitch track) or two bodies sounding at
/// once (the two strongest tones, early and late, each with its pitch and level).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Card {
    OneBody,
    TwoBodies
}

/// Every compared dimension of two report cards, in tolerance units (1.0 = at the tolerance).
pub fn misses(reference: &Measures, candidate: &Measures, card: Card) -> Vec<Miss> {
    let mut result = Vec::new();
    let mut push = |name: String, reference: f64, candidate: f64, units: f64| {
        if reference.is_finite() && candidate.is_finite() {result.push(Miss {name, reference, candidate, units});}
    };
    if card == Card::OneBody {
        push("first period Hz".into(), reference.first_period.1, candidate.first_period.1,
             semitones(candidate.first_period.1, reference.first_period.1) / 1.0);
        for (index, ms) in PITCH_TIMES_MS.iter().enumerate() {
            let (a, b) = (reference.pitch_hz[index], candidate.pitch_hz[index]);
            if a.is_finite() && !b.is_finite() {push(format!("pitch {ms} ms"), a, 0.0, 10.0); continue;}
            push(format!("pitch {ms} ms"), a, b, semitones(b, a) / 0.5);
        }
    } else {
        for (label, a, b) in [("early", &reference.tones_early, &candidate.tones_early), ("late", &reference.tones_late, &candidate.tones_late)] {
            for (index, name) in ["low", "high"].iter().enumerate() {
                match (a.get(index), b.get(index)) {
                    (Some(want), Some(have)) => {
                        push(format!("{label} {name} tone Hz"), want.0, have.0, semitones(have.0, want.0) / 0.5);
                        push(format!("{label} {name} tone dB"), want.1, have.1, (have.1 - want.1) / 3.0);
                    }
                    (Some(want), None) => push(format!("{label} {name} tone Hz"), want.0, 0.0, 10.0),
                    _ => {}
                }
            }
        }
    }
    push("decay -3 dB ms".into(), reference.decay3_ms, candidate.decay3_ms, (candidate.decay3_ms - reference.decay3_ms) / 5.0);
    push("decay -20 dB ms".into(), reference.decay20_ms, candidate.decay20_ms, (candidate.decay20_ms / reference.decay20_ms).log2() / 0.1);
    push("decay -40 dB ms".into(), reference.decay40_ms, candidate.decay40_ms, (candidate.decay40_ms / reference.decay40_ms).log2() / 0.1);
    push("attack centroid".into(), reference.attack_centroid_hz, candidate.attack_centroid_hz,
         (candidate.attack_centroid_hz / reference.attack_centroid_hz).log2() / 0.3);
    for (index, ms) in CENTROID_TIMES_MS.iter().enumerate().skip(1) {
        let (a, b) = (reference.centroid_hz[index], candidate.centroid_hz[index]);
        push(format!("centroid {ms} ms"), a, b, (b / a).log2() / 0.3);
    }
    if card == Card::OneBody {
        for (index, (a, b)) in reference.bands_early_db.iter().zip(candidate.bands_early_db.iter()).enumerate().take(9) {
            push(format!("early band {index}"), floor_db(*a), floor_db(*b), (floor_db(*b) - floor_db(*a)) / 3.0);
        }
        for (index, (a, b)) in reference.bands_late_db.iter().zip(candidate.bands_late_db.iter()).enumerate().take(9) {
            push(format!("late band {index}"), floor_db(*a), floor_db(*b), (floor_db(*b) - floor_db(*a)) / 3.0);
        }
    } else {
        for (frame, ms) in GRID_FRAMES_MS.iter().enumerate() {
            for (band, edge) in GRID_EDGES.windows(2).enumerate() {
                let (a, b) = (floor_db(reference.grid[frame][band]), floor_db(candidate.grid[frame][band]));
                push(format!("{ms} ms {}-{} Hz", edge[0] as i32, edge[1] as i32), a, b, (b - a) / 4.0);
            }
        }
    }
    push("noise early dB".into(), floor_db(reference.noise_early_db), floor_db(candidate.noise_early_db),
         (floor_db(candidate.noise_early_db) - floor_db(reference.noise_early_db)) / 6.0);
    push("noise late dB".into(), floor_db(reference.noise_late_db), floor_db(candidate.noise_late_db),
         (floor_db(candidate.noise_late_db) - floor_db(reference.noise_late_db)) / 6.0);
    if card == Card::OneBody {
        if let (Some(a), Some(b)) = (reference.partials.first(), candidate.partials.first()) {
            push("body partial Hz".into(), a.0, b.0, semitones(b.0, a.0) / 0.5);
        }
    }
    result
}

pub fn distance(reference: &Measures, candidate: &Measures, card: Card) -> f64 {
    misses(reference, candidate, card).iter().map(|miss| miss.units * miss.units).sum()
}

/// Nelder-Mead over points in [0, 1]^n (clamped), from `start` with an initial step of `step`.
pub fn nelder_mead(start: &[f64], step: f64, evaluations: usize, mut cost: impl FnMut(&[f64]) -> f64) -> (Vec<f64>, f64) {
    let clamp = |point: Vec<f64>| -> Vec<f64> {point.into_iter().map(|value| value.clamp(0.0, 1.0)).collect()};
    let dimensions = start.len();
    let mut simplex: Vec<(Vec<f64>, f64)> = Vec::with_capacity(dimensions + 1);
    let first = clamp(start.to_vec());
    let first_cost = cost(&first);
    simplex.push((first, first_cost));
    for index in 0..dimensions {
        let mut point = start.to_vec();
        point[index] += if point[index] + step <= 1.0 {step} else {-step};
        let point = clamp(point);
        let value = cost(&point);
        simplex.push((point, value));
    }
    let mut used = dimensions + 1;
    while used < evaluations {
        simplex.sort_by(|a, b| a.1.total_cmp(&b.1));
        let centroid: Vec<f64> = (0..dimensions)
            .map(|axis| simplex[..dimensions].iter().map(|(point, _)| point[axis]).sum::<f64>() / dimensions as f64).collect();
        let worst = simplex[dimensions].clone();
        let toward = |factor: f64| clamp((0..dimensions).map(|axis| centroid[axis] + factor * (worst.0[axis] - centroid[axis])).collect());
        let reflected = toward(-1.0);
        let reflected_cost = cost(&reflected);
        used += 1;
        if reflected_cost < simplex[0].1 {
            let expanded = toward(-2.0);
            let expanded_cost = cost(&expanded);
            used += 1;
            simplex[dimensions] = if expanded_cost < reflected_cost {(expanded, expanded_cost)} else {(reflected, reflected_cost)};
        } else if reflected_cost < simplex[dimensions - 1].1 {
            simplex[dimensions] = (reflected, reflected_cost);
        } else {
            let contracted = toward(0.5);
            let contracted_cost = cost(&contracted);
            used += 1;
            if contracted_cost < worst.1 {
                simplex[dimensions] = (contracted, contracted_cost);
            } else {
                let best = simplex[0].0.clone();
                for entry in simplex.iter_mut().skip(1) {
                    entry.0 = clamp((0..dimensions).map(|axis| best[axis] + 0.5 * (entry.0[axis] - best[axis])).collect());
                    entry.1 = cost(&entry.0);
                    used += 1;
                }
            }
        }
    }
    simplex.sort_by(|a, b| a.1.total_cmp(&b.1));
    simplex.swap_remove(0)
}

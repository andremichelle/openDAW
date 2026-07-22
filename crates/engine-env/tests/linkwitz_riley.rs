use engine_env::linkwitz_riley::LinkwitzRiley;
use std::f64::consts::PI;

const SR: f64 = 48_000.0;
const CHUNK: usize = 128;
const SAMPLES: usize = 16_384;
const SETTLE: usize = SAMPLES / 2;

struct Sine {
    phase: f64,
    step: f64
}

impl Sine {
    fn new(freq: f64) -> Self {Self {phase: 0.0, step: 2.0 * PI * freq / SR}}

    fn fill(&mut self, left: &mut [f32], right: &mut [f32]) {
        for index in 0..left.len() {
            let value = self.phase.sin() as f32;
            left[index] = value;
            right[index] = value;
            self.phase += self.step;
        }
    }
}

// The steady-state magnitude of the lowpass at `freq`, relative to a unity sine, for a crossover at `fc`.
fn lowpass_magnitude(fc: f64, freq: f64) -> f64 {
    let mut lp = LinkwitzRiley::lowpass();
    lp.set(fc, SR);
    let mut sine = Sine::new(freq);
    let (mut energy, mut count) = (0.0f64, 0.0f64);
    let mut processed = 0usize;
    while processed < SAMPLES {
        let (mut in_l, mut in_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        sine.fill(&mut in_l, &mut in_r);
        let (mut lo_l, mut lo_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        lp.process(&in_l, &in_r, &mut lo_l, &mut lo_r);
        for index in 0..CHUNK {
            if processed + index >= SETTLE {
                energy += (lo_l[index] as f64).powi(2);
                count += 1.0;
            }
        }
        processed += CHUNK;
    }
    (energy / count).sqrt() * 2.0f64.sqrt() // rms -> amplitude relative to the unity sine
}

#[test]
fn the_lowpass_is_a_fourth_order_butterworth() {
    // Unity in the passband, -6 dB at the crossover (Linkwitz-Riley alignment), 24 dB/oct in the stopband.
    assert!((lowpass_magnitude(1_000.0, 100.0) - 1.0).abs() < 0.02, "flat well below the crossover");
    let at_fc = 20.0 * lowpass_magnitude(1_000.0, 1_000.0).log10();
    assert!((at_fc + 6.0).abs() < 0.5, "-6 dB at the crossover (got {at_fc} dB)");
    let octave_a = 20.0 * lowpass_magnitude(1_000.0, 4_000.0).log10();
    let octave_b = 20.0 * lowpass_magnitude(1_000.0, 8_000.0).log10();
    let per_octave = octave_a - octave_b;
    assert!((22.0..30.0).contains(&per_octave), "4th-order rolloff, ~24 dB/oct (got {per_octave} dB)");
}

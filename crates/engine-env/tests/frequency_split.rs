use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::frequency_split::FrequencySplitter;
use engine_env::RENDER_QUANTUM;
use std::f64::consts::PI;

const SR: f64 = 48_000.0;
const SAMPLES: usize = 16_384;
const SETTLE: usize = SAMPLES / 2;

fn fill_sine(buffer: &SharedAudioBuffer, phase: &mut f64, freq: f64) {
    let step = 2.0 * PI * freq / SR;
    let mut inner = buffer.borrow_mut();
    for index in 0..RENDER_QUANTUM {
        let value = phase.sin() as f32;
        inner.left[index] = value;
        inner.right[index] = value;
        *phase += step;
    }
}

fn reconstruction_ratio(band_count: usize, crossovers: &[f64], freq: f64) -> f64 {
    let mut splitter = FrequencySplitter::new(SR, band_count, crossovers);
    let input = shared_audio_buffer();
    let mut phase = 0.0;
    let (mut energy_in, mut energy_out) = (0.0f64, 0.0f64);
    let mut processed = 0usize;
    while processed < SAMPLES {
        fill_sine(&input, &mut phase, freq);
        splitter.process(&input);
        let input_ref = input.borrow();
        let bands: Vec<_> = (0..band_count).map(|index| splitter.band(index)).collect();
        for index in 0..RENDER_QUANTUM {
            if processed + index >= SETTLE {
                let inp = input_ref.left[index] as f64;
                let sum: f64 = bands.iter().map(|band| band.borrow().left[index] as f64).sum();
                energy_in += inp * inp;
                energy_out += sum * sum;
            }
        }
        processed += RENDER_QUANTUM;
    }
    (energy_out / energy_in).sqrt()
}

#[test]
fn two_bands_reconstruct_flat() {
    for &freq in &[60.0, 250.0, 1_000.0, 4_000.0, 12_000.0] {
        let ratio = reconstruction_ratio(2, &[1_000.0], freq);
        assert!((ratio - 1.0).abs() < 0.02, "2-band sum flat at {freq}Hz (ratio {ratio})");
    }
}

#[test]
fn four_bands_reconstruct_flat_across_all_crossovers() {
    for &freq in &[60.0, 200.0, 450.0, 1_000.0, 2_500.0, 5_000.0, 9_000.0, 15_000.0] {
        let ratio = reconstruction_ratio(4, &[200.0, 1_000.0, 5_000.0], freq);
        assert!((ratio - 1.0).abs() < 0.03, "4-band sum flat at {freq}Hz (ratio {ratio})");
    }
}

#[test]
fn out_of_range_band_is_silent() {
    let splitter = FrequencySplitter::new(SR, 3, &[300.0, 3_000.0]);
    let extra = splitter.band(3);
    let buffer = extra.borrow();
    for index in 0..RENDER_QUANTUM {
        assert_eq!(buffer.left[index], 0.0);
        assert_eq!(buffer.right[index], 0.0);
    }
}

#[test]
fn changing_band_count_reconfigures() {
    let mut splitter = FrequencySplitter::new(SR, 2, &[1_000.0]);
    assert_eq!(splitter.band_count(), 2);
    splitter.set_band_count(4);
    assert_eq!(splitter.band_count(), 4);
    let input = shared_audio_buffer();
    let mut phase = 0.0;
    for _ in 0..64 {
        fill_sine(&input, &mut phase, 800.0);
        splitter.process(&input);
    }
    let energy: f64 = (0..4)
        .map(|index| splitter.band(index).borrow().left.iter().map(|&sample| (sample as f64).powi(2)).sum::<f64>())
        .sum();
    assert!(energy > 0.0, "all four bands active after growing the count");
}

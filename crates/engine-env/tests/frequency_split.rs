use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::frequency_split::FrequencySplitter;
use engine_env::RENDER_QUANTUM;
use std::f64::consts::PI;

const SR: f64 = 48_000.0;

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

fn fill_noise(buffer: &SharedAudioBuffer, seed: &mut u32) {
    let mut inner = buffer.borrow_mut();
    for index in 0..RENDER_QUANTUM {
        *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let value = (*seed >> 8) as f32 / 8_388_608.0 - 1.0;
        inner.left[index] = value;
        inner.right[index] = value;
    }
}

fn max_reconstruction_error(splitter: &FrequencySplitter, input: &SharedAudioBuffer, band_count: usize) -> f32 {
    let inp = input.borrow();
    let bands: Vec<_> = (0..band_count).map(|index| splitter.band(index)).collect();
    let mut error = 0.0f32;
    for index in 0..RENDER_QUANTUM {
        let sum: f32 = bands.iter().map(|band| band.borrow().left[index]).sum();
        assert!(sum.is_finite(), "the summed output is non-finite");
        error = error.max((sum - inp.left[index]).abs());
    }
    error
}

#[test]
fn bands_sum_back_to_the_exact_input() {
    // The subtractive crossover reconstructs the input sample-for-sample (not merely flat magnitude like a
    // Linkwitz-Riley allpass sum), so an unprocessed split is a true pass-through: identical waveform and peak.
    for &count in &[2usize, 3, 4] {
        let mut splitter = FrequencySplitter::new(SR, count, &[200.0, 1_000.0, 5_000.0]);
        let input = shared_audio_buffer();
        let mut seed = 0x1234_5678u32;
        let mut error = 0.0f32;
        for round in 0..1_000 {
            fill_noise(&input, &mut seed);
            splitter.process(&input);
            if round > 50 {
                error = error.max(max_reconstruction_error(&splitter, &input, count));
            }
        }
        assert!(error < 1.0e-4, "{count}-band sum must equal the input sample-for-sample (max error {error})");
    }
}

#[test]
fn dragging_a_low_crossover_under_noise_keeps_the_output_identical() {
    // The failing case: broadband material while a low crossover is dragged. The direct-form Linkwitz-Riley went
    // unstable (tens of dB) here; the subtractive TPT split keeps the summed output equal to the input at every
    // sample, so there is neither a blow-up nor any peak change while dragging.
    let mut splitter = FrequencySplitter::new(SR, 4, &[200.0, 1_000.0, 5_000.0]);
    let input = shared_audio_buffer();
    let mut seed = 0x9e37_79b9u32;
    let mut error = 0.0f32;
    for round in 0..2_000 {
        fill_noise(&input, &mut seed);
        let phase01 = (round % 300) as f64 / 300.0;
        splitter.set_crossover(0, 30.0 * (200.0f64 / 30.0).powf((phase01 - 0.5).abs() * 2.0));
        splitter.process(&input);
        error = error.max(max_reconstruction_error(&splitter, &input, 4));
    }
    assert!(error < 1.0e-4, "the output stays identical to the input while dragging (max error {error})");
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

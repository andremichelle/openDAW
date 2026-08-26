
//! Calibration of the spurious-attack metric on the EXACT files the user condemned by ear:
//! the condemned renders must score high, the source and Signalsmith renders low — or the
//! metric is wrong again.

use audio_visualizer_rs::analysis::percussive::{hpss, percussive_features};
use audio_visualizer_rs::analysis::spectral::stft;
use stretch_lab::metrics::envelope::fast_envelope;
use stretch_lab::metrics::spurious::roughness_excess_db;
use stretch_lab::wav;
use std::path::Path;

fn mono(path: &str) -> (Vec<f32>, f32) {
    let data = wav::read(Path::new(path)).expect("wav");
    let (l, r) = data.stereo();
    (l.iter().zip(r.iter()).map(|(a, b)| 0.5 * (a + b)).collect(), data.sample_rate)
}

fn main() {
    let cases = [
        ("worst-cases/1-derelict-SOURCE.wav", "worst-cases/1-derelict-x1.25-OURS-worst.wav", 1.25, "derelict OURS (clicky)"),
        ("worst-cases/1-derelict-SOURCE.wav", "worst-cases/1-derelict-x1.25-SIGNALSMITH.wav", 1.25, "derelict SIGNALSMITH (ok)"),
        ("worst-cases/2-guitar-SOURCE.wav", "worst-cases/2-guitar-x1.1-OURS.wav", 1.1, "guitar OURS (ghosts)"),
        ("worst-cases/3-padchord-SOURCE.wav", "worst-cases/3-padchord-x1.25-OURS.wav", 1.25, "padchord OURS (random attacks)"),
        ("worst-cases/3-padchord-SOURCE.wav", "worst-cases/3-padchord-x1.25-SIGNALSMITH.wav", 1.25, "padchord SIGNALSMITH"),
    ];
    let base = concat!(env!("CARGO_MANIFEST_DIR"), "/out/");
    for (src, out, ratio, label) in cases {
        let (source, source_rate) = mono(&format!("{base}{src}"));
        let (output, output_rate) = mono(&format!("{base}{out}"));
        let _ = ratio;
        let rate = roughness_excess_db(&fast_envelope(&source, source_rate), &fast_envelope(&output, output_rate));
        let spectrogram = stft(&output, 2048, 256);
        let hp = hpss(&spectrogram, None);
        let feats = percussive_features(&hp, output_rate as u32, 256);
        let mut sharp = feats.attack_sharpness.clone();
        sharp.sort_by(|a, b| b.partial_cmp(a).unwrap());
        let top = sharp.len().div_ceil(20).max(1);
        let sharp_top = sharp[..top].iter().sum::<f32>() / top as f32;
        let dens = feats.onset_density.iter().sum::<f32>() / feats.onset_density.len().max(1) as f32;
        let perc = feats.percussive_ratio.iter().sum::<f32>() / feats.percussive_ratio.len().max(1) as f32;
        println!("{label:<36} rough {rate:+.1} dB  sharp5% {sharp_top:.4}  onset_dens {dens:.3}  perc_ratio {perc:.4}");
    }
}

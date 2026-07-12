//! Foundation tests: the port must round-trip and preserve energy before parity matters.
use signalsmith::SignalsmithStretch;

fn sine(freq: f64, rate: f64, n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5*(2.0*std::f64::consts::PI*freq*i as f64/rate).sin()) as f32).collect()
}
fn rms(x: &[f32]) -> f64 { (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()/x.len().max(1) as f64).sqrt() }

#[test]
fn unity_ratio_preserves_energy() {
    // ratio 1.0: output length == input; a phase vocoder at unity should reconstruct ~losslessly.
    let rate = 48000.0; let input = sine(440.0, rate, 24000);
    let mut s = SignalsmithStretch::preset_default(1, rate as f32);
    let mut out = vec![0.0f32; input.len()];
    s.process_mono(&input, &mut out);
    let (ri, ro) = (rms(&input), rms(&out));
    // steady-state region (skip edges = one block)
    let b = s.block_samples();
    let ri_mid = rms(&input[b..input.len()-b]);
    let ro_mid = rms(&out[b..out.len()-b]);
    assert!((ro_mid/ri_mid.max(1e-9) - 1.0).abs() < 0.15, "unity RMS ratio {:.3} (in {ri:.3} out {ro:.3})", ro_mid/ri_mid);
}

#[test]
fn stretch_lengthens_and_stays_audible() {
    let rate = 48000.0; let input = sine(440.0, rate, 24000);
    let mut s = SignalsmithStretch::preset_default(1, rate as f32);
    let mut out = vec![0.0f32; 36000];
    s.process_mono(&input, &mut out);
    assert!(rms(&out) > 0.1, "1.5x output audible: rms {:.3}", rms(&out));
}

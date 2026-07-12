//! The Signalsmith parity oracle: run the native C++ (via the FFI crate) on a test signal, report
//! its output stats, and — once the port implements process() — diff the Rust port against it.
//! This is the golden reference the port is verified against, stage by stage.

use signalsmith_stretch::Stretch;
use stretch::signalsmith::SignalsmithStretch as PortStretch;

fn test_sine(freq: f64, rate: f64, n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5 * (2.0*std::f64::consts::PI*freq*i as f64/rate).sin()) as f32).collect()
}

fn rms(x: &[f32]) -> f64 { (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt() }

fn main() {
    let rate = 48000.0f64;
    let input = test_sine(440.0, rate, 24000); // 0.5s
    let ratio = 1.5;
    let out_len = (input.len() as f64 * ratio) as usize;

    // --- native oracle ---
    let mut native = Stretch::preset_default(1, rate as u32);
    let mut nout = vec![0.0f32; out_len];
    native.exact(&input[..], &mut nout[..]);
    println!("native   : in_rms {:.4}  out_rms {:.4}  in_lat {}  out_lat {}", rms(&input), rms(&nout), native.input_latency(), native.output_latency());

    // --- our port (config only so far) ---
    let port = PortStretch::preset_default(1, rate as f32);
    println!("port cfg : block {}  interval {}  (process() not yet implemented)", port.block_samples(), port.interval_samples());

    // stash native reference for diffing
    println!("oracle ready: {} samples of reference output at 1.5x", nout.len());
}

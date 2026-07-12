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

    // --- our port ---
    let mut port = PortStretch::preset_default(1, rate as f32);
    let mut pout = vec![0.0f32; out_len];
    port.process_mono(&input, &mut pout);
    println!("port     : out_rms {:.4}  block {}  interval {}", rms(&pout), port.block_samples(), port.interval_samples());
    // spectral purity: a pure sine stretched should stay a pure sine. Measure THD-ish: energy at
    // 440 vs total, for both, on the steady middle.
    let mid = |x: &[f32]| -> f64 {
        let n = 8192; let s = out_len/2 - n/2;
        let seg = &x[s..s+n];
        let mut re=0.0; let mut im=0.0;
        for (i,v) in seg.iter().enumerate() {
            let w = 0.5-0.5*(2.0*std::f64::consts::PI*i as f64/n as f64).cos();
            let a = 2.0*std::f64::consts::PI*440.0*(s+i) as f64/rate;
            re += *v as f64*w*a.cos(); im += *v as f64*w*a.sin();
        }
        let carrier = (re*re+im*im).sqrt();
        let total: f64 = seg.iter().enumerate().map(|(i,v)|{let w=0.5-0.5*(2.0*std::f64::consts::PI*i as f64/n as f64).cos(); (*v as f64*w).powi(2)}).sum::<f64>().sqrt();
        20.0*((carrier/total.max(1e-9)).min(1.0)).log10()
    };
    println!("carrier/total dB (higher=purer): native {:.1}  port {:.1}", mid(&nout), mid(&pout));
}

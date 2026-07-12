//! Parity against the native C++ Signalsmith (dev-dependency oracle). The port is "close enough"
//! when a stretched sine's spectral purity and RMS track the reference within tolerance. Bit-exact
//! is not the target (our radix-2 pow2 block vs native's 5760); epsilon/perceptual parity is.
use signalsmith::SignalsmithStretch as Port;
use signalsmith_stretch::Stretch as Native;

fn sine(freq: f64, rate: f64, n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5*(2.0*std::f64::consts::PI*freq*i as f64/rate).sin()) as f32).collect()
}
fn rms(x: &[f32]) -> f64 { (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()/x.len().max(1) as f64).sqrt() }
// out-of-band energy (everything not near f0) as a purity proxy on a pure-sine stretch
fn dirtiness_db(x: &[f32], rate: f64, f0: f64) -> f64 {
    let n = 8192.min(x.len()); let s = x.len()/2 - n/2;
    let (mut cre, mut cim, mut total) = (0.0f64,0.0f64,0.0f64);
    for i in 0..n {
        let w = 0.5-0.5*(2.0*std::f64::consts::PI*i as f64/n as f64).cos();
        let v = x[s+i] as f64 * w;
        let a = 2.0*std::f64::consts::PI*f0*(s+i) as f64/rate;
        cre += v*a.cos(); cim += v*a.sin(); total += v*v;
    }
    let carrier = (cre*cre+cim*cim).sqrt()*2.0/n as f64;
    let carrier_pow = carrier*carrier*n as f64/2.0;
    let dirt = (total - carrier_pow).max(0.0);
    10.0*(dirt/total.max(1e-12)).log10()
}

#[test]
fn matches_native_rms_within_3db() {
    let rate = 48000.0; let input = sine(440.0, rate, 24000); let out_len = 36000;
    let mut native = Native::preset_default(1, rate as u32);
    let mut nout = vec![0.0f32; out_len]; native.exact(&input[..], &mut nout[..]);
    let mut port = Port::preset_default(1, rate as f32);
    let mut pout = vec![0.0f32; out_len]; port.process_mono(&input, &mut pout);
    let ratio_db = 20.0*(rms(&pout)/rms(&nout).max(1e-9)).log10();
    println!("RMS: native {:.4} port {:.4} ({:+.1} dB)", rms(&nout), rms(&pout), ratio_db);
    println!("dirtiness: native {:.1} dB  port {:.1} dB", dirtiness_db(&nout, rate, 440.0), dirtiness_db(&pout, rate, 440.0));
    assert!(ratio_db.abs() < 3.0, "port RMS within 3 dB of native (got {ratio_db:+.1})");
}

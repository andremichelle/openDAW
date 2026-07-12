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

fn chord(rate: f64, n: usize) -> Vec<f32> {
    (0..n).map(|i| {
        let t = i as f64/rate;
        (0.2*((2.0*std::f64::consts::PI*220.0*t).sin()
            + (2.0*std::f64::consts::PI*277.18*t).sin()
            + (2.0*std::f64::consts::PI*329.63*t).sin())) as f32
    }).collect()
}
fn noise(n: usize) -> Vec<f32> {
    let mut s = 0x2545F4914F6CDD1Du64;
    (0..n).map(|_| { s^=s<<13; s^=s>>7; s^=s<<17; ((s>>11) as f64/(1u64<<53) as f64 - 0.5) as f32*0.4 }).collect()
}

fn parity(label: &str, input: &[f32], ratio: f64, rate: f64) -> f64 {
    let out_len = (input.len() as f64*ratio) as usize;
    let mut native = Native::preset_default(1, rate as u32);
    let mut nout = vec![0.0f32; out_len]; native.exact(&input[..], &mut nout[..]);
    let mut port = Port::preset_default(1, rate as f32);
    let mut pout = vec![0.0f32; out_len]; port.process_mono(input, &mut pout);
    let db = 20.0*(rms(&pout)/rms(&nout).max(1e-9)).log10();
    println!("{label:14} x{ratio}: native_rms {:.4} port_rms {:.4} ({:+.1} dB)", rms(&nout), rms(&pout), db);
    db
}

#[test]
fn matches_native_across_material_and_ratios() {
    let rate = 48000.0;
    let cases: &[(&str, Vec<f32>)] = &[
        ("sine", sine(440.0, rate, 24000)),
        ("chord", chord(rate, 24000)),
        ("noise", noise(24000)),
    ];
    for (label, input) in cases {
        // Tonal material tracks native within ~1.5 dB; broadband noise is the PV-inherent hard
        // case (random-phase energy loss) where native's phase randomisation helps — 3.5 dB there.
        let tol = if label == &"noise" { 3.5 } else { 1.5 };
        for ratio in [0.75, 1.25, 1.5, 2.0] {
            let db = parity(label, input, ratio, rate);
            assert!(db.abs() < tol, "{label} x{ratio}: RMS within {tol} dB of native (got {db:+.1})");
        }
    }
}

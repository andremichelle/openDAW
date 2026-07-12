
//! Feature battery over the ear-verdict calibration set: for each condemned/accepted render vs its
//! source, dump every candidate discriminator so we can SEE which one orders the user's verdicts
//! (instead of guessing a formula). Output: verdict, then features. Ratio-aware.

use stretch_lab::metrics::envelope::{fast_envelope, smooth_envelope, ENVELOPE_RATE};
use stretch_lab::metrics::modulation::{modulation_excess_rated};
use stretch_lab::wav;
use stretch::fft::Fft;
use std::path::Path;

fn mono(path: &str) -> (Vec<f32>, f32) {
    let data = wav::read(Path::new(path)).expect(path);
    let (l, r) = data.stereo();
    (l.iter().zip(r.iter()).map(|(a, b)| 0.5 * (a + b)).collect(), data.sample_rate)
}

// Envelope crest: peak-to-mean of the fast envelope (spiky loudness = grainy).
fn crest(env: &[f32]) -> f64 {
    let mean = env.iter().map(|v| *v as f64).sum::<f64>() / env.len().max(1) as f64;
    let peak = env.iter().fold(0.0f32, |m, v| m.max(*v)) as f64;
    if mean < 1e-6 { 0.0 } else { peak / mean }
}
// Flux: mean absolute derivative of fast envelope over mean (how much loudness moves per ms).
fn env_flux(env: &[f32]) -> f64 {
    let mean = env.iter().map(|v| *v as f64).sum::<f64>() / env.len().max(1) as f64;
    if mean < 1e-6 { return 0.0; }
    let f: f64 = env.windows(2).map(|w| (w[1]-w[0]).abs() as f64).sum::<f64>() / (env.len()-1) as f64;
    f / mean
}
// Onset count/sec: sharp rises over a local baseline.
fn onset_rate(env: &[f32]) -> f64 {
    let peak = env.iter().fold(0.0f32, |m, v| m.max(*v));
    if peak <= 0.0 { return 0.0; }
    let mut n = 0; let mut last = -100i64;
    for i in 5..env.len() {
        let rise = env[i] - env[i-5];
        let base = env[i-5].max(0.02*peak);
        if rise > 0.5*base && rise > 0.04*peak && (i as i64 - last) > 25 { n += 1; last = i as i64; }
    }
    n as f64 / (env.len() as f64 / ENVELOPE_RATE)
}


// Spectral-flux spikiness: STFT, per-frame L2 magnitude-increase flux, then 99th-pct/median.
// Grain-splice clicks are sharp broadband flux spikes -> high crest; smooth stretch -> low.
// Envelope periodicity: normalized autocorrelation peak of the detrended fast envelope over
// 40-200ms lags. A metronomic grain/wrap pulse -> high; irregular natural texture -> low.
fn env_periodicity(env: &[f32]) -> f64 {
    let mean = env.iter().map(|v| *v as f64).sum::<f64>() / env.len().max(1) as f64;
    let res: Vec<f64> = env.iter().map(|v| *v as f64 - mean).collect();
    let energy: f64 = res.iter().map(|x| x*x).sum();
    if energy < 1e-9 { return 0.0; }
    let (lo, hi) = (40usize, 200usize.min(res.len()/2));
    let mut peak = 0.0f64;
    for lag in lo..hi {
        let mut s = 0.0; for i in 0..res.len()-lag { s += res[i]*res[i+lag]; }
        peak = peak.max(s / energy);
    }
    peak
}
fn spectral_flux_crest(mono: &[f32]) -> f64 {
    let n = 1024usize; let hop = 256usize;
    if mono.len() < n * 4 { return 0.0; }
    let fft = Fft::new(n);
    let window: Vec<f32> = (0..n).map(|i| (0.5 - 0.5*(2.0*std::f64::consts::PI*i as f64/n as f64).cos()) as f32).collect();
    let mut prev = vec![0.0f32; n/2];
    let mut flux = Vec::new();
    let mut off = 0;
    while off + n <= mono.len() {
        let mut re: Vec<f32> = (0..n).map(|i| mono[off+i]*window[i]).collect();
        let mut im = vec![0.0f32; n];
        fft.forward(&mut re, &mut im);
        let mut f = 0.0f64;
        let mut mag = vec![0.0f32; n/2];
        for k in 0..n/2 {
            mag[k] = (re[k]*re[k]+im[k]*im[k]).sqrt();
            let d = mag[k] - prev[k];
            if d > 0.0 { f += (d*d) as f64; }
        }
        flux.push(f.sqrt());
        prev = mag;
        off += hop;
    }
    flux.sort_by(|a,b| a.partial_cmp(b).unwrap());
    let median = flux[flux.len()/2].max(1e-9);
    let p99 = flux[flux.len()*99/100];
    p99 / median
}

fn main() {
    // (render, source, ratio, verdict, label)
    let cases: &[(&str,&str,f64,u32,&str)] = &[
        ("out/worst-cases/1-derelict-x1.25-OURS-worst.wav","out/worst-cases/1-derelict-SOURCE.wav",1.25,3,"derelict-OURS"),
        ("out/worst-cases/1-derelict-x1.25-SIGNALSMITH.wav","out/worst-cases/1-derelict-SOURCE.wav",1.25,1,"derelict-SS"),
        ("out/worst-cases/2-guitar-x1.1-OURS.wav","out/worst-cases/2-guitar-SOURCE.wav",1.1,3,"guitar-OURS"),
        ("out/worst-cases/3-padchord-x1.25-OURS.wav","out/worst-cases/3-padchord-SOURCE.wav",1.25,3,"padchord-OURS"),
        ("out/worst-cases/3-padchord-x1.25-SIGNALSMITH.wav","out/worst-cases/3-padchord-SOURCE.wav",1.25,1,"padchord-SS"),
        ("out/bisect/pad-derelict-D-C-plus-annotation-markers.wav","out/bisect/pad-derelict.wav",1.25,2,"derelict-D"),
        ("out/bisect/padchord-D-C-plus-annotation-markers.wav","out/bisect/padchord.wav",1.25,2,"padchord-D"),
        ("out/bisect/padchord-F-D-plus-tiny-tail-loops.wav","out/bisect/padchord.wav",1.25,3,"padchord-F-broken"),
    ];
    let base = concat!(env!("CARGO_MANIFEST_DIR"), "/");
    println!("{:<20} {:>3} {:>9} {:>9} {:>9}", "label","V","periodOUT","periodSRC","period_xs");
    for (rf, sf, ratio, v, label) in cases {
        let (src, sr) = mono(&format!("{base}{sf}"));
        let (out, or) = mono(&format!("{base}{rf}"));
        let se = fast_envelope(&src, sr); let oe = fast_envelope(&out, or);
        let crest_x = crest(&oe) / crest(&se).max(1e-6);
        let flux_x = env_flux(&oe) / env_flux(&se).max(1e-9);
        let onset_x = onset_rate(&oe) - onset_rate(&se) * ratio;
        let _ = (crest_x, flux_x, onset_x);
        let _ = spectral_flux_crest;
        let po = env_periodicity(&oe); let ps = env_periodicity(&se);
        println!("{:<20} {:>3} {:>9.3} {:>9.3} {:>9.3}", label, v, po, ps, po - ps);
    }
}

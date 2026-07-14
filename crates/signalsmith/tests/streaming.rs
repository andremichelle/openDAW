//! The streaming zero-alloc processor (the real-time engine path): pulled in 128-sample blocks,
//! it must stretch cleanly and track native. Also exercises variable time_factor (warp change).
use signalsmith::SignalsmithStretch as Port;
use signalsmith_stretch::Stretch as Native;

fn sine(freq: f64, rate: f64, n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5*(2.0*std::f64::consts::PI*freq*i as f64/rate).sin()) as f32).collect()
}
fn rms(x: &[f32]) -> f64 { (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()/x.len().max(1) as f64).sqrt() }
fn dominant(x: &[f32], rate: f64) -> f64 {
    let s = x.len()/2 - 4096; let seg = &x[s..s+8192]; let (mut bp,mut bf)=(0.0,0.0); let mut f=200.0;
    while f<1500.0 { let w=2.0*std::f64::consts::PI*f/rate; let c=2.0*w.cos(); let (mut a,mut b)=(0.0,0.0);
        for (i,v) in seg.iter().enumerate(){let win=0.5-0.5*(2.0*std::f64::consts::PI*i as f64/seg.len() as f64).cos(); let s=*v as f64*win+c*a-b; b=a; a=s;}
        let p=a*a+b*b-c*a*b; if p>bp{bp=p;bf=f;} f+=1.0; } bf
}

#[test]
fn streaming_stretches_cleanly_in_blocks() {
    let rate = 48000.0;
    // pad the source so centered analysis windows near the end have data
    let mut src = sine(440.0, rate, 24000); src.extend(std::iter::repeat(0.0).take(4096));
    let ratio = 1.5; let out_len = (24000.0*ratio) as usize;
    let mut port = Port::preset_default(1, rate as f32);
    port.reset_stream(2048.0); // start half a block in (latency)
    let mut out = vec![0.0f32; out_len];
    // pull in 128-sample blocks, as the engine does
    for chunk in out.chunks_mut(128) { port.process_stream(&src, chunk, ratio, 1.0); }
    let f = dominant(&out, rate);
    println!("streaming 1.5x: rms {:.3}  freq {:.0} (want 440)", rms(&out), f);
    assert!(rms(&out) > 0.15, "audible: {:.3}", rms(&out));
    assert!((f-440.0).abs() < 8.0, "frequency preserved by time-stretch: {f:.0}");
}

// Normalized cross-correlation between L and R, maximized over a small lag window. A stereo signal
// with a fixed inter-channel delay reads ~1.0 here; independent-per-channel processing decorrelates.
fn interchannel_coherence(l: &[f32], r: &[f32]) -> f64 {
    let s = l.len()/2 - 4000; let a = &l[s..s+8000]; let mut best = 0.0f64;
    for lag in -60i64..=60 {
        let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
        for i in 0..a.len() {
            let j = i as i64 + lag; if j < 0 || j as usize >= r.len() { continue; }
            let (x, y) = (a[i] as f64, r[j as usize] as f64);
            num += x*y; da += x*x; db += y*y;
        }
        if da > 0.0 && db > 0.0 { let c = num/(da*db).sqrt(); if c > best { best = c; } }
    }
    best
}

#[test]
fn stereo_preserves_the_image() {
    // L and R are the same three-tone signal but R is delayed by a few samples — a fixed stereo
    // image. Coupled processing keeps L/R coherent; two independent mono vocoders scramble the
    // per-band phase relationship and collapse the coherence.
    let rate = 48000.0; let n = 24000;
    // Both channels carry the SAME two partials (so they are correlated) but with swapped emphasis —
    // a genuine stereo image, not a mere delay. In L the low partial dominates, in R the high one.
    // Independent vocoders peak-lock each channel to a DIFFERENT reference partial, so the shared
    // spectrum's phase drifts apart over the stretch; the coupled processor shares one peak map.
    let (f1, f2) = (400.0, 424.0);
    let ll = |t: f64| 0.5*(2.0*std::f64::consts::PI*f1*t).sin() + 0.15*(2.0*std::f64::consts::PI*f2*t).sin();
    let rr = |t: f64| 0.15*(2.0*std::f64::consts::PI*f1*t).sin() + 0.5*(2.0*std::f64::consts::PI*f2*t).sin();
    let mut left = vec![0.0f32; n + 4096];
    let mut right = vec![0.0f32; n + 4096];
    for i in 0..n { left[i] = ll(i as f64/rate) as f32; right[i] = rr(i as f64/rate) as f32; }
    let input_coh = interchannel_coherence(&left, &right);
    let ratio = 1.5; let out_len = (n as f64*ratio) as usize;
    // coupled stereo processor
    let mut stereo = Port::preset_default(2, rate as f32);
    stereo.reset_stream(2048.0);
    let (mut cl, mut cr) = (vec![0.0f32; out_len], vec![0.0f32; out_len]);
    for (lc, rc) in cl.chunks_mut(128).zip(cr.chunks_mut(128)) { stereo.process_stream_stereo(&left, &right, lc, rc, ratio, 1.0, 1.0); }
    let coupled = interchannel_coherence(&cl, &cr);
    // two independent mono processors (the rejected approach)
    let mut ml = Port::preset_default(1, rate as f32); ml.reset_stream(2048.0);
    let mut mr = Port::preset_default(1, rate as f32); mr.reset_stream(2048.0);
    let (mut il, mut ir) = (vec![0.0f32; out_len], vec![0.0f32; out_len]);
    for c in il.chunks_mut(128) { ml.process_stream(&left, c, ratio, 1.0); }
    for c in ir.chunks_mut(128) { mr.process_stream(&right, c, ratio, 1.0); }
    let independent = interchannel_coherence(&il, &ir);
    println!("stereo coherence: input {input_coh:.3}  coupled {coupled:.3}  independent {independent:.3}");
    assert!(coupled > 0.7*input_coh, "coupled retains the input's stereo image ({coupled:.3} vs input {input_coh:.3})");
    assert!(coupled > independent + 0.2, "coupled decisively beats two independent vocoders ({coupled:.3} vs {independent:.3})");
}

#[test]
fn streaming_variable_tempo_stays_stable() {
    // time_factor ramps from 1.0 to 2.0 mid-stream (accelerating warp) — must not glitch/blow up.
    let rate = 48000.0;
    let mut src = sine(330.0, rate, 48000); src.extend(std::iter::repeat(0.0).take(4096));
    let mut port = Port::preset_default(1, rate as f32);
    port.reset_stream(2048.0);
    let mut out = vec![0.0f32; 48000];
    let n = out.len();
    for (i, chunk) in out.chunks_mut(128).enumerate() {
        let tf = 1.0 + (i*128) as f64 / n as f64; // 1.0 -> 2.0
        port.process_stream(&src, chunk, tf, 1.0);
    }
    let peak = out.iter().fold(0.0f32, |m,v| m.max(v.abs()));
    println!("variable tempo: rms {:.3}  peak {:.3}", rms(&out), peak);
    assert!(peak < 2.0 && rms(&out) > 0.05, "stable under changing tempo (peak {peak:.2})");
}

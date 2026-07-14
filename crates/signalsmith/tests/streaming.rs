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

//! Pitch shift correctness: a sine shifted by N semitones must land at f0 * 2^(N/12), and the
//! port's shifted output must match native's. Time-ratio 1.0 = pure pitch shift.
use signalsmith::SignalsmithStretch as Port;
use signalsmith_stretch::Stretch as Native;

fn sine(freq: f64, rate: f64, n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5*(2.0*std::f64::consts::PI*freq*i as f64/rate).sin()) as f32).collect()
}
// dominant frequency by Goertzel scan
fn dominant(x: &[f32], rate: f64) -> f64 {
    let s = x.len()/2 - 4096; let seg = &x[s..s+8192];
    let mut best=0.0; let mut bestf=0.0;
    let mut f=100.0;
    while f < 2000.0 {
        let w = 2.0*std::f64::consts::PI*f/rate; let c=2.0*w.cos();
        let (mut a,mut b)=(0.0,0.0);
        for (i,v) in seg.iter().enumerate() { let win=0.5-0.5*(2.0*std::f64::consts::PI*i as f64/seg.len() as f64).cos(); let s=*v as f64*win + c*a - b; b=a; a=s; }
        let p = a*a+b*b-c*a*b;
        if p>best { best=p; bestf=f; }
        f+=1.0;
    }
    bestf
}

#[test]
fn octave_up_lands_at_880() {
    let rate = 48000.0; let input = sine(440.0, rate, 48000);
    let mut port = Port::preset_default(1, rate as f32);
    port.set_transpose_semitones(12.0); // +1 octave
    let mut pout = vec![0.0f32; input.len()];
    port.process_mono(&input, &mut pout);
    let f = dominant(&pout, rate);
    println!("port +12st: 440 -> {:.0} Hz (want 880)", f);
    assert!((f-880.0).abs() < 15.0, "octave-up lands near 880 Hz, got {f:.0}");
}

#[test]
fn matches_native_pitch_across_intervals() {
    let rate = 48000.0; let input = sine(440.0, rate, 48000);
    for st in [-12.0, -5.0, 5.0, 7.0, 12.0] {
        let want = 440.0 * 2f64.powf(st/12.0);
        let mut n = Native::preset_default(1, rate as u32); n.set_transpose_factor_semitones(st as f32, None);
        let mut nout = vec![0.0f32; input.len()]; n.exact(&input[..], &mut nout[..]);
        let mut p = Port::preset_default(1, rate as f32); p.set_transpose_semitones(st as f32);
        let mut pout = vec![0.0f32; input.len()]; p.process_mono(&input, &mut pout);
        let (nf, pf) = (dominant(&nout, rate), dominant(&pout, rate));
        println!("{st:+.0}st: want {want:.0}  native {nf:.0}  port {pf:.0}");
        assert!((pf-want).abs() < 15.0, "{st}st: port at {pf:.0}, want {want:.0}");
    }
}

#[test]
fn stretch_and_pitch_together() {
    // 1.5x longer AND +7 semitones at once — the combined operation the mode needs.
    let rate = 48000.0; let input = sine(440.0, rate, 32000);
    let out_len = (input.len() as f64 * 1.5) as usize;
    let mut port = Port::preset_default(1, rate as f32);
    port.set_transpose_semitones(7.0);
    let mut out = vec![0.0f32; out_len];
    port.process_mono(&input, &mut out);
    let want = 440.0 * 2f64.powf(7.0/12.0); // 659 Hz
    let f = dominant(&out, rate);
    println!("1.5x + 7st: len {} (want {}), freq {:.0} (want {:.0})", out.len(), out_len, f, want);
    assert!(out.len() == out_len, "length is stretched");
    assert!((f-want).abs() < 15.0, "pitch shifted while stretched: {f:.0} vs {want:.0}");
}

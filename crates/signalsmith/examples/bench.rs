//! Real-time cost of the streaming stereo processor: render N seconds of stereo output in 128-sample blocks
//! (the engine's quantum) and report ms-per-second-of-audio and the real-time fraction (native ~= a single
//! engine voice's CPU share). Native build (has SIMD); the wasm engine is slower, so treat the fraction as a
//! lower bound and the RELATIVE change across optimizations as the signal.
use signalsmith::SignalsmithStretch as Port;
use std::time::Instant;

fn main() {
    let rate = 48000.0f32;
    let seconds = 10.0;
    let n = (rate as f64 * seconds) as usize;
    // a dense-ish stereo signal (many partials) so band gating can't cheat — worst case for the phase loops
    let mut left = vec![0.0f32; n + 8192];
    let mut right = vec![0.0f32; n + 8192];
    for i in 0..n {
        let t = i as f64 / rate as f64;
        let mut sl = 0.0f64; let mut sr = 0.0f64;
        for k in 1..=24 { // 24 partials
            let f = 110.0 * k as f64;
            sl += (2.0*std::f64::consts::PI*f*t).sin() / k as f64;
            sr += (2.0*std::f64::consts::PI*f*t + 0.4).sin() / k as f64;
        }
        left[i] = (sl * 0.1) as f32; right[i] = (sr * 0.1) as f32;
    }
    let mut port = Port::preset_default(2, rate);
    port.reset_stream(2048.0);
    let (mut ol, mut or) = (vec![0.0f32; 128], vec![0.0f32; 128]);
    // warm up one block (reset burst) then time the steady state
    port.process_stream_stereo(&left, &right, &mut ol, &mut or, 1.0, 1.0, 1.0);
    let blocks = n / 128;
    let start = Instant::now();
    let mut pos = 0usize;
    for _ in 0..blocks {
        port.process_stream_stereo(&left[pos..], &right[pos..], &mut ol, &mut or, 1.0, 1.0, 1.0);
        pos += 128;
    }
    let elapsed = start.elapsed().as_secs_f64();
    let audio = blocks as f64 * 128.0 / rate as f64;
    println!("dense 24-partial 1.0x: {:.1} ms / {:.1}s  ->  {:.2}x realtime  ({:.1}% of one core)",
             elapsed*1000.0, audio, audio/elapsed, elapsed/audio*100.0);
    // Real-world case: a 44.1k sample on a 48k engine (resample), at native tempo.
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/app/wasm/public/loops/endeavour-140.wav");
    if let Ok(bytes) = std::fs::read(path) {
        let (rl, rr) = read_stereo(&bytes);
        let resample = 44100.0 / 48000.0;
        let mut p = Port::preset_default(2, 48000.0); p.reset_stream(2048.0);
        let src = rl.len();
        let mut ll = rl.clone(); let mut rrr = rr.clone();
        ll.extend(std::iter::repeat(0.0).take(8192)); rrr.extend(std::iter::repeat(0.0).take(8192));
        p.process_stream_stereo(&ll, &rrr, &mut ol, &mut or, 1.0, 1.0, resample);
        let out_blocks = (src as f64 / resample) as usize / 128;
        let t = Instant::now();
        for _ in 0..out_blocks { p.process_stream_stereo(&ll, &rrr, &mut ol, &mut or, 1.0, 1.0, resample); }
        let el = t.elapsed().as_secs_f64();
        let au = out_blocks as f64 * 128.0 / 48000.0;
        println!("real 44.1k->48k drum 1.0x: {:.1} ms / {:.1}s  ->  {:.2}x realtime  ({:.1}% of one core)",
                 el*1000.0, au, au/el, el/au*100.0);
    }
}

fn read_stereo(b: &[u8]) -> (Vec<f32>, Vec<f32>) {
    let (mut data, mut ch, mut fmt, mut bits) = (&b[0..0], 2usize, 3u16, 16u16);
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i+4]; let sz = u32::from_le_bytes([b[i+4],b[i+5],b[i+6],b[i+7]]) as usize;
        let body = &b[i+8..(i+8+sz).min(b.len())];
        if id == b"fmt " { fmt=u16::from_le_bytes([body[0],body[1]]); ch=u16::from_le_bytes([body[2],body[3]]) as usize; bits=u16::from_le_bytes([body[14],body[15]]); }
        else if id == b"data" { data = body; }
        i += 8 + sz + (sz&1);
    }
    let bps = bits as usize/8; let frame = bps*ch;
    let sample = |c: &[u8]| -> f32 { match (fmt, bits) {
        (3,32) => f32::from_le_bytes([c[0],c[1],c[2],c[3]]),
        (1,16) => i16::from_le_bytes([c[0],c[1]]) as f32/32768.0,
        (1,24) => (((c[2] as i32)<<24 | (c[1] as i32)<<16 | (c[0] as i32)<<8) >> 8) as f32/8388608.0,
        _ => 0.0,
    }};
    let (mut l, mut r) = (Vec::new(), Vec::new());
    for c in data.chunks(frame).filter(|c| c.len()==frame) { l.push(sample(&c[0..bps])); r.push(if ch>=2 {sample(&c[bps..2*bps])} else {sample(&c[0..bps])}); }
    (l, r)
}

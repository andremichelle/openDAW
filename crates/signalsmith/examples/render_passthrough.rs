//! Diagnose the drum phasing: render endeavour (a 44.1k drum loop) through the streaming stereo processor
//! at (a) pure UNITY (time_factor 1.0, pitch 1.0 — is the PV transparent at all?) and (b) the engine's
//! native-tempo settings on a 48k engine (time_factor 48/44.1, pitch 44.1/48 — the spectral rate-shift).
//! Correlate each against the source to see which introduces the phasing.
use signalsmith::SignalsmithStretch as Port;
use signalsmith_stretch::Stretch as Native;
use std::path::Path;

fn read_stereo(path: &str) -> (Vec<f32>, Vec<f32>, f32) {
    let b = std::fs::read(path).unwrap();
    let (mut data, mut ch, mut rate, mut fmt, mut bits) = (Vec::new(), 2usize, 48000u32, 3u16, 16u16);
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i+4]; let sz = u32::from_le_bytes([b[i+4],b[i+5],b[i+6],b[i+7]]) as usize;
        let body = &b[i+8..(i+8+sz).min(b.len())];
        if id == b"fmt " { fmt=u16::from_le_bytes([body[0],body[1]]); ch=u16::from_le_bytes([body[2],body[3]]) as usize;
            rate=u32::from_le_bytes([body[4],body[5],body[6],body[7]]); bits=u16::from_le_bytes([body[14],body[15]]); }
        else if id == b"data" { data = body.to_vec(); }
        i += 8 + sz + (sz&1);
    }
    let bps = bits as usize/8; let frame = bps*ch;
    let sample = |c: &[u8]| -> f32 { match (fmt, bits) {
        (3,32) => f32::from_le_bytes([c[0],c[1],c[2],c[3]]),
        (1,16) => i16::from_le_bytes([c[0],c[1]]) as f32/32768.0,
        (1,24) => (((c[2] as i32)<<24 | (c[1] as i32)<<16 | (c[0] as i32)<<8) >> 8) as f32/8388608.0,
        (1,32) => i32::from_le_bytes([c[0],c[1],c[2],c[3]]) as f32/2147483648.0,
        _ => 0.0,
    }};
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for c in data.chunks(frame).filter(|c| c.len()==frame) {
        left.push(sample(&c[0..bps])); right.push(if ch >= 2 { sample(&c[bps..2*bps]) } else { sample(&c[0..bps]) });
    }
    (left, right, rate as f32)
}
fn write_stereo(path: &str, left: &[f32], right: &[f32], rate: f32) {
    let n = left.len().min(right.len()); let ds = (n*8) as u32;
    let mut o = Vec::new();
    o.extend_from_slice(b"RIFF"); o.extend_from_slice(&(36+ds).to_le_bytes()); o.extend_from_slice(b"WAVE");
    o.extend_from_slice(b"fmt "); o.extend_from_slice(&16u32.to_le_bytes()); o.extend_from_slice(&3u16.to_le_bytes());
    o.extend_from_slice(&2u16.to_le_bytes()); o.extend_from_slice(&(rate as u32).to_le_bytes());
    o.extend_from_slice(&((rate as u32)*8).to_le_bytes()); o.extend_from_slice(&8u16.to_le_bytes()); o.extend_from_slice(&32u16.to_le_bytes());
    o.extend_from_slice(b"data"); o.extend_from_slice(&ds.to_le_bytes());
    for i in 0..n { o.extend_from_slice(&left[i].to_le_bytes()); o.extend_from_slice(&right[i].to_le_bytes()); }
    let _ = std::fs::create_dir_all(Path::new(path).parent().unwrap()); std::fs::write(path, o).unwrap();
}
// best normalized correlation of `out` against `src` over a small latency search (out is delayed by ~block/2)
fn cleanliness(src: &[f32], out: &[f32]) -> f64 {
    let n = 40000.min(src.len()/2); let s = src.len()/2 - n/2;
    let mut best = 0.0f64;
    for lag in -4096..4096i64 {
        let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
        for i in 0..n {
            let j = s as i64 + i as i64 + lag; if j < 0 || j as usize >= out.len() { continue; }
            let (x, y) = (src[s+i] as f64, out[j as usize] as f64);
            num += x*y; da += x*x; db += y*y;
        }
        if da > 0.0 && db > 0.0 { let c = num/(da*db).sqrt(); if c > best { best = c; } }
    }
    best
}

fn main() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/app/wasm/public/loops/");
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/out/");
    let (mut left, mut right, rate) = read_stereo(&format!("{dir}endeavour-140.wav"));
    let src_len = left.len();
    left.extend(std::iter::repeat(0.0).take(8192)); right.extend(std::iter::repeat(0.0).take(8192));
    // (a) pure UNITY passthrough — is the PV transparent at 1.0x / no shift?
    let mut p1 = Port::preset_default(2, rate); p1.reset_stream(2048.0);
    let (mut ul, mut ur) = (vec![0.0f32; src_len], vec![0.0f32; src_len]);
    for (lc, rc) in ul.chunks_mut(128).zip(ur.chunks_mut(128)) { p1.process_stream_stereo(&left, &right, lc, rc, 1.0, 1.0, 1.0); }
    // (a2) port MONO passthrough (left only) — isolate whether the stereo coupling is what scrambles phase
    let mut pm = Port::preset_default(1, rate); pm.reset_stream(2048.0);
    let mut ml_out = vec![0.0f32; src_len];
    for c in ml_out.chunks_mut(128) { pm.process_stream(&left, c, 1.0, 1.0); }
    // (b) engine native-tempo on a 48k engine, NEW path: time_factor 1.0, pitch 1.0, and the sample-rate
    //     conversion done as a transparent time-domain resample read (resample = 44.1/48). No spectral shift.
    let resample = 44100.0/48000.0;                    // source samples per engine sample
    let n48 = (src_len as f64 / resample) as usize;    // engine-rate length
    let mut p2 = Port::preset_default(2, rate); p2.reset_stream(2048.0);
    let (mut rl, mut rr) = (vec![0.0f32; n48], vec![0.0f32; n48]);
    for (lc, rc) in rl.chunks_mut(128).zip(rr.chunks_mut(128)) { p2.process_stream_stereo(&left, &right, lc, rc, 1.0, 1.0, resample); }
    // reference: the source linearly resampled to 48k — what transparent native playback SHOULD produce
    let mut ref48 = vec![0.0f32; n48];
    for i in 0..n48 { let pos = i as f64 * resample; let i0 = pos as usize; let f = (pos - i0 as f64) as f32;
        ref48[i] = if i0+1 < src_len { left[i0]*(1.0-f) + left[i0+1]*f } else if i0 < src_len { left[i0] } else { 0.0 }; }
    // (c) NATIVE Signalsmith at unity (left channel, mono) — reconstructs the input, or decorrelation inherent?
    let mut nl = vec![0.0f32; src_len];
    Native::preset_default(1, rate as u32).exact(&left[..src_len], &mut nl[..]);
    write_stereo(&format!("{out}endeavour_NATIVE_UNITY.wav"), &nl, &nl, rate);
    write_stereo(&format!("{out}endeavour_SOURCE.wav"), &left[..src_len], &right[..src_len], rate);
    write_stereo(&format!("{out}endeavour_UNITY.wav"), &ul, &ur, rate);
    write_stereo(&format!("{out}endeavour_RATESHIFT.wav"), &rl, &rr, 48000.0);
    println!("endeavour cleanliness vs source (1.0 = identical):");
    println!("  UNITY stereo (tf 1.0, pitch 1.0): {:.3}", cleanliness(&left[..src_len], &ul));
    println!("  UNITY mono (left only):           {:.3}", cleanliness(&left[..src_len], &ml_out));
    println!("  RATE 48k engine (NEW resample):   {:.3}  (vs source linearly resampled to 48k)", cleanliness(&ref48, &rl));
    println!("  NATIVE Signalsmith at unity:       {:.3}", cleanliness(&left[..src_len], &nl));
    println!("wrote SOURCE / UNITY / RATESHIFT to {out}");
}

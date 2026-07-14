//! Stereo render for listening: pad + drums stretched x1.5 through the REAL streaming engine path
//! (`process_stream_stereo`, pulled in 128-sample blocks). Also renders the rejected two-independent-
//! mono-vocoders approach so the stereo-image difference is audible A/B.
use signalsmith::SignalsmithStretch as Port;
use std::path::Path;

/// Read a WAV as separate L/R planes (duplicates mono to both). Handles 16/24/32-int and 32-float.
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
        let l = sample(&c[0..bps]);
        let r = if ch >= 2 { sample(&c[bps..2*bps]) } else { l };
        left.push(l); right.push(r);
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

fn main() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-files/samples/");
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/out/");
    let ratio = 1.5f64;
    for (name, file) in [("pad-derelict","332740__mseq__derelict-pad-125.wav"),
                         ("drums","RK_Techno_Top_Loop1_05_128bpm.wav")] {
        let (mut left, mut right, rate) = read_stereo(&format!("{dir}{file}"));
        let src_len = left.len();
        left.extend(std::iter::repeat(0.0).take(4096)); right.extend(std::iter::repeat(0.0).take(4096));
        let out_len = (src_len as f64 * ratio) as usize;
        // COUPLED — the real engine path (one stereo processor, 128-sample blocks)
        let mut stereo = Port::preset_default(2, rate); stereo.reset_stream(2048.0);
        let (mut cl, mut cr) = (vec![0.0f32; out_len], vec![0.0f32; out_len]);
        for (lc, rc) in cl.chunks_mut(128).zip(cr.chunks_mut(128)) { stereo.process_stream_stereo(&left, &right, lc, rc, ratio, 1.0); }
        // INDEPENDENT — the rejected approach (two mono vocoders), for A/B
        let mut ml = Port::preset_default(1, rate); ml.reset_stream(2048.0);
        let mut mr = Port::preset_default(1, rate); mr.reset_stream(2048.0);
        let (mut il, mut ir) = (vec![0.0f32; out_len], vec![0.0f32; out_len]);
        for c in il.chunks_mut(128) { ml.process_stream(&left, c, ratio, 1.0); }
        for c in ir.chunks_mut(128) { mr.process_stream(&right, c, ratio, 1.0); }
        write_stereo(&format!("{out}{name}_SOURCE_stereo.wav"), &left[..src_len], &right[..src_len], rate);
        write_stereo(&format!("{out}{name}_x1.5_COUPLED.wav"), &cl, &cr, rate);
        write_stereo(&format!("{out}{name}_x1.5_INDEPENDENT.wav"), &il, &ir, rate);
        println!("{name}: source {src_len} -> {out_len} frames @ {rate} Hz  (COUPLED + INDEPENDENT written)");
    }
    println!("\nlisten in {out}");
}

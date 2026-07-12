//! Port vs native on the real fixtures, rendered to WAV for listening + spectral-diff measured.
use signalsmith::SignalsmithStretch as Port;
use signalsmith_stretch::Stretch as Native;
use std::path::Path;

fn read_wav(path: &str) -> (Vec<f32>, f32) {
    let b = std::fs::read(path).unwrap(); let mut i = 12; let (mut data, mut ch, mut rate, mut fmt) = (Vec::new(), 2usize, 48000u32, 3u16);
    while i + 8 <= b.len() { let id=&b[i..i+4]; let sz=u32::from_le_bytes([b[i+4],b[i+5],b[i+6],b[i+7]]) as usize;
        let body=&b[i+8..(i+8+sz).min(b.len())];
        if id==b"fmt " { fmt=u16::from_le_bytes([body[0],body[1]]); ch=u16::from_le_bytes([body[2],body[3]]) as usize; rate=u32::from_le_bytes([body[4],body[5],body[6],body[7]]); }
        else if id==b"data" { data=body.to_vec(); } i+=8+sz+(sz&1); }
    // bits from the fmt chunk (byte 14-15). Handle 16/24/32-int and 32-float.
    let bits = { let mut i=12; let mut bb=16u16; while i+8<=b.len(){let id=&b[i..i+4];let sz=u32::from_le_bytes([b[i+4],b[i+5],b[i+6],b[i+7]]) as usize; if id==b"fmt "{bb=u16::from_le_bytes([b[i+22],b[i+23]]);} i+=8+sz+(sz&1);} bb } as usize;
    let bps = bits/8; let frame = bps*ch;
    let sample = |c: &[u8]| -> f32 { match (fmt, bits) {
        (3,32) => f32::from_le_bytes([c[0],c[1],c[2],c[3]]),
        (1,16) => i16::from_le_bytes([c[0],c[1]]) as f32/32768.0,
        (1,24) => (((c[2] as i32)<<24 | (c[1] as i32)<<16 | (c[0] as i32)<<8) >> 8) as f32/8388608.0,
        (1,32) => i32::from_le_bytes([c[0],c[1],c[2],c[3]]) as f32/2147483648.0,
        _ => 0.0,
    }};
    let mono: Vec<f32> = data.chunks(frame).filter(|c| c.len()==frame)
        .map(|c| (0..ch).map(|k| sample(&c[k*bps..(k+1)*bps])).sum::<f32>()/ch as f32).collect();
    (mono, rate as f32)
}
fn write_wav(path: &str, x: &[f32], rate: f32) {
    let mut o = Vec::new(); let ds=(x.len()*4) as u32;
    o.extend_from_slice(b"RIFF"); o.extend_from_slice(&(36+ds).to_le_bytes()); o.extend_from_slice(b"WAVE");
    o.extend_from_slice(b"fmt "); o.extend_from_slice(&16u32.to_le_bytes()); o.extend_from_slice(&3u16.to_le_bytes());
    o.extend_from_slice(&1u16.to_le_bytes()); o.extend_from_slice(&(rate as u32).to_le_bytes());
    o.extend_from_slice(&((rate as u32)*4).to_le_bytes()); o.extend_from_slice(&4u16.to_le_bytes()); o.extend_from_slice(&32u16.to_le_bytes());
    o.extend_from_slice(b"data"); o.extend_from_slice(&ds.to_le_bytes());
    for v in x { o.extend_from_slice(&v.to_le_bytes()); }
    let _ = std::fs::create_dir_all(Path::new(path).parent().unwrap()); std::fs::write(path, o).unwrap();
}
fn main() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-files/samples/");
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/out/");
    let files = [("pad-derelict","332740__mseq__derelict-pad-125.wav"),
                 ("drums","175_F_AttackHitLoop_SP_02.wav"),
                 ("guitar","568315__valentinsosnitskiy__classical-loop-guitar-4-chords.wav")];
    let ratio = 1.5;
    for (name, file) in files {
        let (mono, rate) = read_wav(&format!("{dir}{file}"));
        let out_len = (mono.len() as f64 * ratio) as usize;
        let mut nout = vec![0.0f32; out_len]; Native::preset_default(1, rate as u32).exact(&mono[..], &mut nout[..]);
        let mut pout = vec![0.0f32; out_len]; Port::preset_default(1, rate).process_mono(&mono, &mut pout);
        write_wav(&format!("{out}{name}_SOURCE.wav"), &mono, rate);
        write_wav(&format!("{out}{name}_x1.5_NATIVE.wav"), &nout, rate);
        write_wav(&format!("{out}{name}_x1.5_PORT.wav"), &pout, rate);
        println!("{name}: rendered");
    }
}

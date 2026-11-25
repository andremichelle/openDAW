// A/B tool, openDAW side: runs our analysis and limiter on the same two 44.1 kHz WAV files as tools/compare.py and
// compares with Matchering's output in the same folder. Writes ours_raw.wav, ours_limited.wav (exact Matchering
// curves) and ours_studio.wav (the studio: curves clamped to ±12 dB, limited).
// Usage: cargo run --release -p device-mastering --example compare -- target.wav reference.wav out-folder

use std::fs;
use std::path::Path;
use device_mastering::hyrax::Hyrax;
use matchering::analysis::{analyse_reference, apply, match_target, MatchResult};
use matchering::config::{BINS, CURVE_LIMIT_DB, SAMPLE_RATE, THRESHOLD};

struct Stereo {left: Vec<f64>, right: Vec<f64>}

fn chunk<'a>(bytes: &'a [u8], id: &[u8]) -> Option<&'a [u8]> {
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body = &bytes[offset + 8..(offset + 8 + size).min(bytes.len())];
        if &bytes[offset..offset + 4] == id {return Some(body);}
        offset += 8 + size + (size & 1);
    }
    None
}

fn read_wav(path: &Path) -> Stereo {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert!(&bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "{} is not a WAV file", path.display());
    let format = chunk(&bytes, b"fmt ").expect("no fmt chunk");
    let tag = u16::from_le_bytes([format[0], format[1]]);
    let channels = u16::from_le_bytes([format[2], format[3]]) as usize;
    let rate = u32::from_le_bytes(format[4..8].try_into().unwrap()) as usize;
    let bits = u16::from_le_bytes([format[14], format[15]]) as usize;
    let tag = if tag == 0xFFFE {u16::from_le_bytes([format[24], format[25]])} else {tag};
    assert_eq!(rate, SAMPLE_RATE, "{} is not 44.1 kHz", path.display());
    let data = chunk(&bytes, b"data").expect("no data chunk");
    let width = bits / 8;
    let sample = |frame: &[u8]| -> f64 {
        match (tag, bits) {
            (1, 16) => i16::from_le_bytes([frame[0], frame[1]]) as f64 / 32768.0,
            (1, 24) => (i32::from_le_bytes([0, frame[0], frame[1], frame[2]]) >> 8) as f64 / 8388608.0,
            (1, 32) => i32::from_le_bytes(frame[..4].try_into().unwrap()) as f64 / 2147483648.0,
            (3, 32) => f32::from_le_bytes(frame[..4].try_into().unwrap()) as f64,
            (3, 64) => f64::from_le_bytes(frame[..8].try_into().unwrap()),
            _ => panic!("{}: unsupported WAV format {tag} with {bits} bits", path.display())
        }
    };
    let frames: Vec<&[u8]> = data.chunks_exact(width * channels).collect();
    let left = frames.iter().map(|frame| sample(&frame[..width])).collect();
    let right = frames.iter().map(|frame| sample(&frame[(channels.min(2) - 1) * width..])).collect();
    Stereo {left, right}
}

fn write_wav(path: &Path, left: &[f64], right: &[f64]) {
    let data: Vec<u8> = left.iter().zip(right)
        .flat_map(|(left, right)| [(*left as f32).to_le_bytes(), (*right as f32).to_le_bytes()]).flatten().collect();
    let mut bytes = Vec::with_capacity(44 + data.len());
    bytes.extend(b"RIFF");
    bytes.extend((36 + data.len() as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(3u16.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend((SAMPLE_RATE as u32).to_le_bytes());
    bytes.extend((SAMPLE_RATE as u32 * 8).to_le_bytes());
    bytes.extend(8u16.to_le_bytes());
    bytes.extend(32u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((data.len() as u32).to_le_bytes());
    bytes.extend(data);
    fs::write(path, bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
}

/// Our realtime limiter over the whole file, the lookahead delay removed, then the final amplitude.
fn limit(left: &[f64], right: &[f64], final_amplitude: f64) -> (Vec<f64>, Vec<f64>) {
    let mut hyrax: Box<Hyrax> = unsafe {Box::new_zeroed().assume_init()};
    hyrax.init(SAMPLE_RATE as f32, THRESHOLD);
    let latency = hyrax.latency();
    let total = left.len() + latency;
    let (mut out_left, mut out_right) = (Vec::with_capacity(total), Vec::with_capacity(total));
    for start in (0..total).step_by(128) {
        let end = (start + 128).min(total);
        let mut block_left: Vec<f32> = (start..end).map(|index| *left.get(index).unwrap_or(&0.0) as f32).collect();
        let mut block_right: Vec<f32> = (start..end).map(|index| *right.get(index).unwrap_or(&0.0) as f32).collect();
        hyrax.process(&mut block_left, &mut block_right, true);
        out_left.extend(block_left.iter().map(|value| *value as f64 * final_amplitude));
        out_right.extend(block_right.iter().map(|value| *value as f64 * final_amplitude));
    }
    (out_left[latency..].to_vec(), out_right[latency..].to_vec())
}

fn db(value: f64) -> f64 {20.0 * value.max(1e-12).log10()}

/// Peak and RMS of the difference in dBFS, skipping `edge` samples at both ends.
fn null_test(ours: &Stereo, theirs: &Stereo, edge: usize) -> (f64, f64) {
    let length = ours.left.len().min(theirs.left.len());
    let (mut peak, mut sum, mut count) = (0.0f64, 0.0, 0usize);
    for index in edge..length.saturating_sub(edge) {
        for (a, b) in [(ours.left[index], theirs.left[index]), (ours.right[index], theirs.right[index])] {
            peak = peak.max((a - b).abs());
            sum += (a - b) * (a - b);
            count += 1;
        }
    }
    (db(peak), db((sum / count.max(1) as f64).sqrt()))
}

fn report(label: &str, ours: &Stereo, theirs_path: &Path, edge: usize) {
    if !theirs_path.exists() {
        println!("{label}: {} missing, run tools/compare.py first", theirs_path.display());
        return;
    }
    let theirs = read_wav(theirs_path);
    let (peak, rms) = null_test(ours, &theirs, edge);
    println!("{label}: difference peak {peak:.1} dBFS, rms {rms:.1} dBFS{}",
             if edge > 0 {format!(" (first and last {:.1} s skipped)", edge as f64 / SAMPLE_RATE as f64)} else {String::new()});
}

fn curve_report(result: &MatchResult, path: &Path) {
    let Ok(bytes) = fs::read(path) else {return println!("curves: {} missing", path.display())};
    let theirs: Vec<f64> = bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap())).collect();
    let worst = |ours: &[f64], theirs: &[f64]| ours[2..].iter().zip(&theirs[2..])
        .fold(0.0f64, |worst, (a, b)| worst.max((db(*a) - db(*b)).abs()));
    println!("curves: mid deviates up to {:.4} dB, side up to {:.4} dB",
             worst(&result.mid_curve, &theirs[..BINS]), worst(&result.side_curve, &theirs[BINS..]));
    let range = |curve: &[f64]| curve[1..].iter().fold((f64::MAX, f64::MIN), |(low, high), value| (low.min(db(*value)), high.max(db(*value))));
    let ((mid_low, mid_high), (side_low, side_high)) = (range(&result.mid_curve), range(&result.side_curve));
    println!("curves: mid {mid_low:.1} to {mid_high:.1} dB, side {side_low:.1} to {side_high:.1} dB (the studio clamps to ±{CURVE_LIMIT_DB} dB)");
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    assert!(arguments.len() == 4, "usage: compare target.wav reference.wav out-folder");
    let (target, reference, out) = (read_wav(Path::new(&arguments[1])), read_wav(Path::new(&arguments[2])), Path::new(&arguments[3]));
    fs::create_dir_all(out).unwrap();
    let profile = analyse_reference(&reference.left, &reference.right).expect("reference");
    let exact = match_target(&target.left, &target.right, &profile, None, &mut |_| {}).expect("target");
    let studio = match_target(&target.left, &target.right, &profile, Some(CURVE_LIMIT_DB), &mut |_| {}).expect("target");
    println!("match gain {:.2} dB, final amplitude {:.2} dB (studio match gain {:.2} dB)",
             db(exact.gain), db(exact.final_amplitude), db(studio.gain));
    curve_report(&exact, &out.join("matchering_curves.bin"));
    let (raw_left, raw_right) = apply(&target.left, &target.right, &exact);
    let raw = Stereo {left: raw_left, right: raw_right};
    write_wav(&out.join("ours_raw.wav"), &raw.left, &raw.right);
    report("raw (no limiter)", &raw, &out.join("matchering_raw.wav"), 0);
    let (limited_left, limited_right) = limit(&raw.left, &raw.right, exact.final_amplitude);
    let limited = Stereo {left: limited_left, right: limited_right};
    write_wav(&out.join("ours_limited.wav"), &limited.left, &limited.right);
    report("limited", &limited, &out.join("matchering_limited.wav"), SAMPLE_RATE / 2);
    let (studio_left, studio_right) = apply(&target.left, &target.right, &studio);
    let (studio_left, studio_right) = limit(&studio_left, &studio_right, studio.final_amplitude);
    write_wav(&out.join("ours_studio.wav"), &studio_left, &studio_right);
    println!("wrote {}", out.display());
}

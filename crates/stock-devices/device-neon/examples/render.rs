//! Offline calibration render: reads a flat tone description + note list (written by
//! `scripts/neon-dump.ts` style tooling or by hand) and writes a 16-bit stereo WAV, so a Neon
//! rendering can be A/B'd against a VirtualCZ reference of the same `.syx`.
//!
//! Usage: cargo run -p device-neon --example render -- tone.txt notes.txt out.wav [seconds]
//!
//! tone.txt lines: `lineSelect N`, `modulation N`, `octave N`, `detuneNote N`, `detuneFine N`,
//! `env <0-5> <rate*8> <level*8> <sustain> <end>`, `wave <line> <wave1> <wave2>`, `keyFollow <line> <dcw> <dca>`.
//! notes.txt lines: `<midi-key> <start-seconds> <duration-seconds>`

use std::fs;
use device_neon::calibration::{render_tone, ToneDescription};

fn main() {
    let mut arguments = std::env::args().skip(1);
    let tone_path = arguments.next().expect("tone.txt");
    let notes_path = arguments.next().expect("notes.txt");
    let out_path = arguments.next().expect("out.wav");
    let seconds: f32 = arguments.next().map(|value| value.parse().expect("seconds")).unwrap_or(4.0);
    let tone = ToneDescription::parse(&fs::read_to_string(&tone_path).expect("read tone"));
    let notes: Vec<(u32, f32, f32)> = fs::read_to_string(&notes_path).expect("read notes").lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.split_whitespace();
            let key: u32 = parts.next().expect("key").parse().expect("key");
            let start: f32 = parts.next().expect("start").parse().expect("start");
            let duration: f32 = parts.next().expect("duration").parse().expect("duration");
            (key, start, duration)
        })
        .collect();
    const SAMPLE_RATE: f32 = 48_000.0;
    let samples = render_tone(&tone, &notes, seconds, SAMPLE_RATE);
    let mut bytes: Vec<u8> = Vec::with_capacity(44 + samples.len() * 2);
    let data_len = (samples.len() * 2) as u32;
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    bytes.extend_from_slice(&((SAMPLE_RATE as u32) * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    fs::write(&out_path, bytes).expect("write wav");
    println!("wrote {out_path}");
}

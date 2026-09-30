//! Offline render of a cartridge voice (the CLI the parity fixtures were generated with):
//!
//!   render tables <sr>                              -> sin, exp2, freq tables as raw i32 on stdout
//!   render render <syx> <voice> <sr> <frames> <out> [k=v ...] notes...
//!       notes: pitch,velocity,onFrame,offFrame (frames on the 64-sample grid)
//!       k=v: mono=1 cutoff=<0-1> reso=<0-1> gain=<f> tune=<masterTune Q24> patch<i>=<v>

use std::fs;
use std::io::Write;
use device_tubular::create_state;
use device_tubular::harness::{parse_note, render_case};

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("tables") => {
            let sample_rate: f32 = arguments[1].parse().expect("sr");
            let state = create_state(sample_rate);
            let tables = state.synth.tables();
            let mut out = std::io::stdout().lock();
            for value in tables.sin.iter().chain(tables.exp2.iter()).chain(tables.freq.iter()) {
                out.write_all(&value.to_le_bytes()).expect("write");
            }
        }
        Some("render") => {
            let bank = fs::read(&arguments[1]).expect("syx");
            let voice: usize = arguments[2].parse().expect("voice");
            let sample_rate: f32 = arguments[3].parse().expect("sr");
            let frames: usize = arguments[4].parse().expect("frames");
            let settings: Vec<(&str, &str)> = arguments[6..].iter().filter_map(|argument| argument.split_once('=')).collect();
            let notes = arguments[6..].iter().filter(|argument| !argument.contains('=')).map(|text| parse_note(text)).collect::<Vec<_>>();
            let out = render_case(&bank, voice, sample_rate, frames, &settings, &notes);
            let bytes: Vec<u8> = out.iter().flat_map(|value| value.to_le_bytes()).collect();
            fs::write(&arguments[5], bytes).expect("write out");
        }
        _ => eprintln!("usage: render tables <sr> | render render <syx> <voice> <sr> <frames> <out> [k=v ...] notes...")
    }
}

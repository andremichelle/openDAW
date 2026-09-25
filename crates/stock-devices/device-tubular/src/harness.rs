//! Offline render for tests and the `render` example, with the parity fixtures' case vocabulary: a cartridge voice,
//! `key=value` settings and `pitch,velocity,on,off` notes on the 64-sample grid.

use abi::{EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use crate::{create_state, patch, render, N};

pub struct Note {
    pub pitch: u32,
    pub velocity: u32,
    pub on: usize,
    pub off: usize
}

pub fn parse_note(text: &str) -> Note {
    let parts: Vec<usize> = text.split(',').map(|part| part.parse().expect("note")).collect();
    Note {pitch: parts[0] as u32, velocity: parts[1] as u32, on: parts[2], off: parts[3]}
}

pub fn render_case(bank: &[u8], voice: usize, sample_rate: f32, frames: usize, settings: &[(&str, &str)], notes: &[Note]) -> Vec<f32> {
    let body = patch::bank_body(bank).expect("not a DX7 bank");
    let mut voice_data = patch::unpack(&body[voice * 128..voice * 128 + 128]);
    for (key, value) in settings {
        if let Some(index) = key.strip_prefix("patch") {
            voice_data[index.parse::<usize>().expect("patch index")] = value.parse().expect("patch value");
        }
    }
    let mut state = create_state(sample_rate);
    state.synth.load_patch(&voice_data);
    for (key, value) in settings {
        match *key {
            "mono" => state.synth.set_mono_mode(*value != "0"),
            "cutoff" => state.synth.fx.ui_cutoff = value.parse().expect("cutoff"),
            "reso" => state.synth.fx.ui_reso = value.parse().expect("reso"),
            "gain" => state.synth.fx.ui_gain = value.parse().expect("gain"),
            "tune" => state.synth.controllers.master_tune = value.parse().expect("tune"),
            key if key.starts_with("patch") => {}
            other => panic!("unknown setting {other}")
        }
    }
    let mut out: Vec<f32> = Vec::with_capacity(frames);
    let (mut left, mut right) = (vec![0.0f32; N], vec![0.0f32; N]);
    let mut at = 0;
    while at < frames {
        let mut events: Vec<EventRecord> = Vec::new();
        for note in notes {
            if note.on == at {
                events.push(EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id: note.pitch, pitch: note.pitch,
                    velocity: note.velocity as f32 / 127.0, cent: 0.0, duration: 0.0});
            }
            if note.off == at {
                events.push(EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_OFF, id: note.pitch, pitch: note.pitch,
                    velocity: 0.0, cent: 0.0, duration: 0.0});
            }
        }
        render(&mut state, &events, &mut left, &mut right);
        let count = (frames - at).min(N);
        out.extend_from_slice(&left[..count]);
        at += N;
    }
    out
}

pub fn fnv1a64(samples: &[f32]) -> u64 {
    let mut value: u64 = 0xcbf29ce484222325;
    for sample in samples {
        for byte in sample.to_le_bytes() {
            value = (value ^ byte as u64).wrapping_mul(0x100000001b3);
        }
    }
    value
}

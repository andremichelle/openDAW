//! Native-only calibration support (the `render` example): parse a flat tone description and render a note
//! sequence offline, so Neon output can be measured against a VirtualCZ reference of the same tone.

use crate::envelope::EnvelopeSpec;
use crate::{render, vibrato_delay_seconds, vibrato_depth_cents, vibrato_rate_hz, NeonState};
use abi::{EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};

pub struct ToneDescription {
    line_select: i32,
    modulation: i32,
    octave: i32,
    detune_note: i32,
    detune_fine: i32,
    vibrato: [i32; 4], // wave, delay, rate, depth (raw)
    waves: [[i32; 2]; 2],
    key_follow: [[i32; 2]; 2], // per line: dcw, dca
    envelopes: [EnvelopeSpec; 6]
}

impl ToneDescription {
    pub fn parse(text: &str) -> Self {
        let mut tone = Self {
            line_select: 0, modulation: 0, octave: 0, detune_note: 0, detune_fine: 0,
            vibrato: [0; 4], waves: [[0; 2]; 2], key_follow: [[0; 2]; 2],
            envelopes: [EnvelopeSpec::flat(); 6]
        };
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let Some(keyword) = parts.next() else {continue};
            let mut next = || parts.next().expect("value").parse::<i32>().expect("number");
            match keyword {
                "lineSelect" => tone.line_select = next(),
                "modulation" => tone.modulation = next(),
                "octave" => tone.octave = next(),
                "detuneNote" => tone.detune_note = next(),
                "detuneFine" => tone.detune_fine = next(),
                "vibrato" => tone.vibrato = [next(), next(), next(), next()],
                "wave" => {
                    let line_index = next() as usize;
                    tone.waves[line_index] = [next(), next()];
                }
                "keyFollow" => {
                    let line_index = next() as usize;
                    tone.key_follow[line_index] = [next(), next()];
                }
                "env" => {
                    let envelope_index = next() as usize;
                    let mut spec = EnvelopeSpec::flat();
                    for slot in 0..8 {spec.rates[slot] = next() as f32}
                    for slot in 0..8 {spec.levels[slot] = next() as f32}
                    spec.sustain = next();
                    spec.end = next();
                    tone.envelopes[envelope_index] = spec;
                }
                _ => {}
            }
        }
        tone
    }
}

/// Render `notes` (midi key, start seconds, duration seconds) for `seconds`, returning interleaved stereo.
pub fn render_tone(tone: &ToneDescription, notes: &[(u32, f32, f32)], seconds: f32, sample_rate: f32) -> Vec<f32> {
    let mut state: NeonState = unsafe { core::mem::zeroed() };
    state.sample_rate = sample_rate;
    state.params.sample_rate = sample_rate;
    state.params.line_select = tone.line_select;
    state.params.modulation = tone.modulation;
    state.params.octave_multiplier = libm::exp2f(tone.octave as f32);
    state.params.detune_ratio = libm::exp2f((tone.detune_note as f32 + tone.detune_fine as f32 / 60.0) / 12.0);
    state.params.vibrato.wave = tone.vibrato[0];
    state.params.vibrato.delay_seconds = vibrato_delay_seconds(tone.vibrato[1] as f32);
    state.params.vibrato.rate_hz = vibrato_rate_hz(tone.vibrato[2] as f32);
    state.params.vibrato.depth_cents = vibrato_depth_cents(tone.vibrato[3] as f32);
    for line_index in 0..2 {
        let config = &mut state.params.lines[line_index];
        config.wave1 = tone.waves[line_index][0];
        config.wave2 = tone.waves[line_index][1];
        config.dcw_key_follow = tone.key_follow[line_index][0] as f32;
        config.dca_key_follow = tone.key_follow[line_index][1] as f32;
        config.pitch_env = tone.envelopes[line_index * 3];
        config.dcw_env = tone.envelopes[line_index * 3 + 1];
        config.dca_env = tone.envelopes[line_index * 3 + 2];
    }
    const CHUNK: usize = 128;
    let total = (seconds * sample_rate) as usize;
    let mut output = Vec::with_capacity(total * 2);
    let mut events: Vec<(usize, EventRecord)> = Vec::new();
    for (index, (key, start, duration)) in notes.iter().enumerate() {
        let id = index as u32 + 1;
        events.push(((start * sample_rate) as usize, EventRecord {
            position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch: *key, velocity: 1.0, cent: 0.0, duration: 0.0
        }));
        events.push((((start + duration) * sample_rate) as usize, EventRecord {
            position: 0.0, offset: 0, kind: EVENT_NOTE_OFF, id, pitch: *key, velocity: 0.0, cent: 0.0, duration: 0.0
        }));
    }
    let (mut left, mut right) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
    let mut cursor = 0;
    while cursor < total {
        let chunk_events: Vec<EventRecord> = events.iter()
            .filter(|(at, _)| *at >= cursor && *at < cursor + CHUNK)
            .map(|(_, event)| *event)
            .collect();
        render(&mut state, &chunk_events, &mut left, &mut right, sample_rate);
        for index in 0..CHUNK.min(total - cursor) {
            output.push(left[index]);
            output.push(right[index]);
        }
        cursor += CHUNK;
    }
    output
}

//! A minimal polyphonic sine instrument: one `SineVoice` (sine oscillator + ADSR) per sounding note.
//! It consumes the `TimedNote` lifecycle from the sequencer, fragmenting the block at each event's
//! sample offset so a note begins / releases sample-accurately, and mixes its voices into the output.
//!
//! `process` expects the events sorted by offset (note-offs before note-ons at the same offset, which
//! is how the sequencer emits them). Idle voices are reclaimed after the block.

use alloc::vec::Vec;
use dsp::adsr::Adsr;
use dsp::{fast_sin, midi_to_hz, PI};
use crate::buffer::AudioBuffer;
use crate::sequencer::{NoteLifecycle, TimedNote};

const TAU: f32 = 2.0 * PI;
const VOICE_GAIN: f32 = 0.25; // headroom for polyphony

struct SineVoice {
    id: u64,
    phase: f32,
    phase_inc: f32,
    gain: f32,
    env: Adsr
}

impl SineVoice {
    fn start(id: u64, pitch: u8, cent: f32, velocity: f32, sample_rate: f32) -> Self {
        let frequency = midi_to_hz(pitch as f32 + cent / 100.0);
        let mut env = Adsr::new(sample_rate);
        env.set(0.005, 0.100, 0.7, 0.200); // gentle default: 5ms attack, 100ms decay, 0.7 sustain, 200ms release
        env.gate_on();
        Self {id, phase: 0.0, phase_inc: TAU * frequency / sample_rate, gain: velocity * VOICE_GAIN, env}
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32], from: usize, to: usize) {
        for index in from..to {
            let sample = fast_sin(self.phase) * self.env.next_value() * self.gain;
            left[index] += sample;
            right[index] += sample;
            self.phase += self.phase_inc;
            if self.phase > PI {
                self.phase -= TAU;
            }
        }
    }

    fn gate_off(&mut self) {
        self.env.gate_off();
    }

    fn is_idle(&self) -> bool {
        self.env.is_idle()
    }
}

pub struct SineInstrument {
    voices: Vec<SineVoice>,
    sample_rate: f32
}

impl SineInstrument {
    pub fn new(sample_rate: f32) -> Self {
        Self {voices: Vec::new(), sample_rate}
    }

    pub fn voice_count(&self) -> usize {
        self.voices.len()
    }

    pub fn reset(&mut self) {
        self.voices.clear();
    }

    /// Render `[s0, s1)` of `out`, applying each timed note at its offset. Events must be sorted by
    /// offset. Reclaims voices that fell idle.
    pub fn process(&mut self, events: &[TimedNote], out: &mut AudioBuffer, s0: usize, s1: usize) {
        let mut cursor = s0;
        for timed in events {
            let offset = if timed.offset < s0 {s0} else if timed.offset > s1 {s1} else {timed.offset};
            if offset > cursor {
                self.render_segment(out, cursor, offset);
                cursor = offset;
            }
            self.apply(&timed.lifecycle);
        }
        if cursor < s1 {
            self.render_segment(out, cursor, s1);
        }
        self.voices.retain(|voice| !voice.is_idle());
    }

    fn render_segment(&mut self, out: &mut AudioBuffer, from: usize, to: usize) {
        for voice in &mut self.voices {
            voice.render(&mut out.left, &mut out.right, from, to);
        }
    }

    fn apply(&mut self, lifecycle: &NoteLifecycle) {
        match *lifecycle {
            NoteLifecycle::Start {id, pitch, cent, velocity} => {
                self.voices.push(SineVoice::start(id, pitch, cent, velocity, self.sample_rate))
            }
            NoteLifecycle::Stop {id} => {
                for voice in &mut self.voices {
                    if voice.id == id {
                        voice.gate_off()
                    }
                }
            }
        }
    }
}

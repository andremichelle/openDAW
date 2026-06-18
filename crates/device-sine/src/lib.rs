//! The sine instrument as a device: a polyphonic sine + ADSR synth, the first device built on the
//! `engine-env` contract. It is a `Processor` (graph node) and an `AudioGenerator` (owns its output
//! buffer), driven by the `AudioProcessor` template: `handle_event` turns note-on / note-off into
//! voices and `process_audio` renders them into the output. Statically composed for now; the binary
//! device ABI (its own `.wasm`) is Phase 4. Pure (`no_std` + alloc).

#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use dsp::adsr::Adsr;
use dsp::{fast_sin, midi_to_hz, PI};
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_processor::AudioProcessor;
use engine_env::block::Block;
use engine_env::event::Event;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::note_event_instrument::{NoteEventInstrument, SharedNoteEventSource};
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;

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
        env.set(0.005, 0.100, 0.7, 0.200); // 5ms attack, 100ms decay, 0.7 sustain, 200ms release
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

pub struct SineDevice {
    sample_rate: f32,
    voices: Vec<SineVoice>,
    output: SharedAudioBuffer,
    events: EventBuffer,
    note_input: NoteEventInstrument
}

impl SineDevice {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            voices: Vec::new(),
            output: shared_audio_buffer(),
            events: EventBuffer::new(),
            note_input: NoteEventInstrument::new()
        }
    }

    pub fn voice_count(&self) -> usize {
        self.voices.len()
    }

    /// Wire the note source whose events this instrument plays (TS `setNoteEventSource`).
    pub fn set_note_event_source(&mut self, source: SharedNoteEventSource) {
        self.note_input.set_note_event_source(source);
    }
}

impl EventReceiver for SineDevice {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioGenerator for SineDevice {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl AudioProcessor for SineDevice {
    fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    fn introduce_block(&mut self, block: &Block) {
        self.note_input.fill(block, &mut self.events); // pull the note source into this block's events
    }

    fn process_audio(&mut self, chunk: &Block) {
        let mut guard = self.output.borrow_mut();
        let output = &mut *guard; // deref once: disjoint &mut left / &mut right below
        output.clear_range(chunk.s0, chunk.s1);
        for voice in &mut self.voices {
            voice.render(&mut output.left, &mut output.right, chunk.s0, chunk.s1);
        }
    }

    fn handle_event(&mut self, event: &Event) {
        match *event {
            Event::NoteStart {id, pitch, cent, velocity, ..} => {
                self.voices.push(SineVoice::start(id, pitch, cent, velocity, self.sample_rate))
            }
            Event::NoteComplete {id, ..} => {
                for voice in &mut self.voices {
                    if voice.id == id {
                        voice.gate_off()
                    }
                }
            }
            Event::Update {..} => {}
        }
    }

    fn finish_process(&mut self) {
        self.voices.retain(|voice| !voice.is_idle());
    }
}

impl Processor for SineDevice {
    fn reset(&mut self) {
        self.voices.clear();
        self.events.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        AudioProcessor::process(self, info);
    }
}

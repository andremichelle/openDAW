//! The sawtooth instrument as a runtime-loadable PIC device plugin: its own `.wasm`, a position-
//! independent side module the engine loads at a host-assigned base and calls via the shared function
//! table (`process(desc_ptr)`). Identical to `device-sine` except the oscillator is a naive sawtooth
//! (`phase / PI`, phase in `[-PI, PI]`). Heap-free; per-voice state lives in the engine-assigned state
//! block. Used (with `device-sine`) to prove two distinct device modules coexist in one shared memory.
//!
//! Exports: `init(sample_rate)`, `state_size()`, `process(desc_ptr)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, Ports, EVENT_NOTE_ON};
use dsp::adsr::Adsr;
use dsp::{midi_to_hz, PI};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const MAX_VOICES: usize = 64;
const TAU: f32 = 2.0 * PI;
const VOICE_GAIN: f32 = 0.25; // headroom for polyphony

struct Voice {
    active: u32,
    id: u32,
    phase: f32,
    phase_inc: f32,
    gain: f32,
    env: Adsr
}

impl Voice {
    fn start(&mut self, event: &EventRecord, sample_rate: f32) {
        let frequency = midi_to_hz(event.pitch as f32 + event.cent / 100.0);
        let mut env = Adsr::new(sample_rate);
        env.set(0.005, 0.100, 0.7, 0.200);
        env.gate_on();
        self.active = 1;
        self.id = event.id;
        self.phase = 0.0;
        self.phase_inc = TAU * frequency / sample_rate;
        self.gain = event.velocity * VOICE_GAIN;
        self.env = env;
    }

    fn render(&mut self, output: &mut [f32]) {
        for sample in output.iter_mut() {
            // The only difference from device-sine: a naive sawtooth ramp instead of a sine.
            *sample += (self.phase * (1.0 / PI)) * self.env.next_value() * self.gain;
            self.phase += self.phase_inc;
            if self.phase > PI {
                self.phase -= TAU;
            }
        }
    }
}

pub struct SynthState {
    voices: [Voice; MAX_VOICES]
}

pub fn render(state: &mut SynthState, events: &[EventRecord], output: &mut [f32], sample_rate: f32) {
    let frames = output.len();
    for sample in output.iter_mut() {
        *sample = 0.0;
    }
    let mut cursor = 0;
    for event in events {
        let offset = (event.offset as usize).min(frames);
        if offset > cursor {
            render_segment(state, &mut output[cursor..offset], sample_rate);
            cursor = offset;
        }
        apply(state, event, sample_rate);
    }
    if cursor < frames {
        render_segment(state, &mut output[cursor..frames], sample_rate);
    }
    for voice in state.voices.iter_mut() {
        if voice.active != 0 && voice.env.is_idle() {
            voice.active = 0;
        }
    }
}

fn render_segment(state: &mut SynthState, output: &mut [f32], _sample_rate: f32) {
    for voice in state.voices.iter_mut() {
        if voice.active != 0 {
            voice.render(output);
        }
    }
}

fn apply(state: &mut SynthState, event: &EventRecord, sample_rate: f32) {
    if event.kind == EVENT_NOTE_ON {
        if let Some(slot) = state.voices.iter_mut().find(|voice| voice.active == 0) {
            slot.start(event, sample_rate);
        }
    } else {
        for voice in state.voices.iter_mut() {
            if voice.active != 0 && voice.id == event.id {
                voice.env.gate_off();
            }
        }
    }
}

static mut SAMPLE_RATE: f32 = 48_000.0;

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe { SAMPLE_RATE = sample_rate }
}

#[no_mangle]
pub extern "C" fn state_size() -> u32 {
    core::mem::size_of::<SynthState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<SynthState>::from_descriptor(desc_ptr) };
    let sample_rate = unsafe { SAMPLE_RATE };
    render(ports.state, ports.events, ports.output, sample_rate);
}

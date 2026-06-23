//! The sawtooth instrument as a runtime-loadable PIC device plugin: its own `.wasm`, a position-
//! independent side module the engine loads at a host-assigned base and calls via the shared function
//! table (`process(desc_ptr)`). Like `device-sine` but a naive sawtooth oscillator (`phase / PI`, phase
//! in `[-PI, PI]`) PLUS a 3/16-note feedback delay. Heap-free; ALL its state, the voices AND a delay ring
//! buffer sized EXACTLY for a 3/16 note at the actual sample rate (`state_size` reserves it from the rate
//! `init` was given), lives in the engine-assigned state block. This tests that the descriptor's
//! state-block allocation holds a real, sample-rate-sized working buffer. Used (with `device-sine`) to
//! prove two distinct device modules coexist in one shared memory.
//!
//! Exports: `init(sample_rate)`, `state_size()`, `process(desc_ptr)`.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{Block, EventRecord, Ports, EVENT_NOTE_ON};
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
// A 3/16-note feedback delay. The delay buffer lives in the engine-allocated state block, sized EXACTLY
// to the delay length from the ACTUAL sample rate (see `state_size`), so there is no fixed worst-case
// array. The buffer is not a struct field (an array would have to be a compile-time constant); it trails
// the voice header in the same block, and the device carves it at render. The device has no transport
// yet, so it assumes the project's default tempo.
const DELAY_BPM: f32 = 120.0; // assumed project tempo until the device reads transport from the descriptor
const DELAY_SIXTEENTHS: usize = 3; // 3/16 delay
const DELAY_FEEDBACK: f32 = 0.5;

// The 3/16 delay length in samples at `sample_rate` (a sixteenth note = 60/(bpm*4) seconds). `state_size`
// reserves exactly this many f32s after the voice header, using the sample rate the host passes to `init`
// before it asks for the state size, so the delay buffer is sized for the real rate with no waste.
fn delay_samples(sample_rate: f32) -> usize {
    ((DELAY_SIXTEENTHS as f32 * sample_rate * 60.0 / (DELAY_BPM * 4.0)) as usize).max(1)
}

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

    fn render(&mut self, out_left: &mut [f32], out_right: &mut [f32]) {
        for index in 0..out_left.len() {
            // The only difference from device-sine: a naive sawtooth ramp instead of a sine.
            let sample = (self.phase * (1.0 / PI)) * self.env.next_value() * self.gain;
            out_left[index] += sample;
            out_right[index] += sample; // a mono voice, written to both channels
            self.phase += self.phase_inc;
            if self.phase > PI {
                self.phase -= TAU;
            }
        }
    }
}

// The voice header. The delay ring buffer is NOT a field (a fixed array would force a compile-time size);
// it trails this header in the same state block, sized by `state_size` from the sample rate, and is
// carved at render. `delay_pos` (the write head) persists across quanta.
pub struct SynthState {
    voices: [Voice; MAX_VOICES],
    delay_pos: u32,
    sample_rate: f32 // the device's own rate, stashed from `Ports::sample_rate` each `process`
}

/// The device's DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]), which
/// owns the event pull, block timing, and dispatch. Same as `device-sine` but a sawtooth oscillator and a
/// 3/16 feedback delay run once per quantum in `finish`.
pub struct Synth;

impl abi::Instrument for Synth {
    type State = SynthState;

    fn init(state: &mut SynthState, sample_rate: f32) {
        state.sample_rate = sample_rate; // stable for the device's life (voices + the delay length read it)
    }

    fn process_audio(state: &mut SynthState, output: [&mut [f32]; 2], _block: &Block) {
        let [out_left, out_right] = output;
        for voice in state.voices.iter_mut() {
            if voice.active != 0 {
                voice.render(out_left, out_right);
            }
        }
    }

    fn handle_event(state: &mut SynthState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let sample_rate = state.sample_rate;
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

    fn finish(state: &mut SynthState, output: [&mut [f32]; 2]) {
        let [out_left, out_right] = output;
        for voice in state.voices.iter_mut() {
            if voice.active != 0 && voice.env.is_idle() {
                voice.active = 0;
            }
        }
        // 3/16-note feedback delay over the (dual-mono) output. The buffer is exactly `length` samples
        // (state_size reserved it from the sample rate) and trails the voice header in the same state
        // block, so the ring's length IS the delay. Run it on the left channel and mirror to the right (the
        // voices are dual-mono). SAFETY: the buffer follows `SynthState` in the block and does not overlap it.
        let length = delay_samples(state.sample_rate);
        unsafe {
            let header = state as *mut SynthState;
            let delay = core::slice::from_raw_parts_mut(header.add(1) as *mut f32, length);
            let mut pos = (*header).delay_pos as usize % length;
            for index in 0..out_left.len() {
                let echo = out_left[index] + delay[pos];
                delay[pos] = echo * DELAY_FEEDBACK;
                pos = if pos + 1 >= length { 0 } else { pos + 1 };
                out_left[index] = echo;
                out_right[index] = echo;
            }
            (*header).delay_pos = pos as u32;
        }
    }
}

/// Bytes the engine must allocate (zeroed) for one instrument's state block: the voice header plus an
/// EXACT 3/16-note delay buffer sized from `sample_rate`. The host passes the rate at creation, so the
/// device holds no global sample rate. No fixed worst-case array, no wasted memory.
#[no_mangle]
pub extern "C" fn state_size(sample_rate: f32) -> u32 {
    let header = core::mem::size_of::<SynthState>();
    let delay = delay_samples(sample_rate) * core::mem::size_of::<f32>();
    (header + delay) as u32
}

/// What the host wires this device as (read at load): an instrument that voices notes into audio.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<SynthState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Synth>(ports);
}

/// Boot hook: the engine calls this once when the device is wired, handing it the (stable) sample rate.
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Synth as abi::Instrument>::init(state, sample_rate)) }
}

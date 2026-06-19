//! The sine instrument as a runtime-loadable device plugin: its own `.wasm`, sharing the engine's
//! linear memory, called wasm-to-wasm via the `abi` descriptor (`process(desc_ptr)`). Heap-free — its
//! per-voice state lives in the engine-assigned state block (a fixed voice array), so the engine owns
//! all memory. Mono output (the engine fans it to stereo). DSP is safe Rust over the `abi` shim.
//!
//! Exports: `init(sample_rate)`, `state_size()` (bytes the engine must allocate, zeroed, for the state
//! block), `process(desc_ptr)`. The note events arrive in the descriptor already resolved to sample
//! offsets and sorted; this device fragments the block at them, voicing note-on / note-off.

// no_std only on wasm (the deployed cdylib); native builds (incl. tests + the native cdylib `cargo
// test` produces) stay std, so no panic handler / unwinding conflict.
#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{EventRecord, Ports, EVENT_NOTE_ON};
use dsp::adsr::Adsr;
use dsp::{fast_sin, midi_to_hz, PI};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const MAX_VOICES: usize = 64;
const TAU: f32 = 2.0 * PI;
const VOICE_GAIN: f32 = 0.25; // headroom for polyphony

/// One voice slot in the state block. `active == 0` means free. Plain data: valid when zeroed (the
/// engine zero-allocates the block), and only ever read when `active != 0`, after `start` wrote it.
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
        env.set(0.005, 0.100, 0.7, 0.200); // 5ms attack, 100ms decay, 0.7 sustain, 200ms release
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
            *sample += fast_sin(self.phase) * self.env.next_value() * self.gain;
            self.phase += self.phase_inc;
            if self.phase > PI {
                self.phase -= TAU;
            }
        }
    }
}

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block. A fixed
/// voice array; `state_size()` tells the engine how many bytes to reserve.
pub struct SynthState {
    voices: [Voice; MAX_VOICES]
}

/// The device's DSP, plugged into the SDK's `Instrument` template ([`abi::render_instrument`]), which
/// owns the event pull, block timing, and dispatch. This device writes only: voice the active state into
/// a sub-chunk (`process_audio`), apply a note on/off (`handle_event`), and reclaim idle voices once per
/// quantum (`finish`).
pub struct Synth;

impl abi::Instrument for Synth {
    type State = SynthState;

    fn process_audio(state: &mut SynthState, output: &mut [f32], _sample_rate: f32) {
        for voice in state.voices.iter_mut() {
            if voice.active != 0 {
                voice.render(output);
            }
        }
    }

    fn handle_event(state: &mut SynthState, event: &EventRecord, sample_rate: f32) {
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

    fn finish(state: &mut SynthState, _output: &mut [f32], _sample_rate: f32) {
        for voice in state.voices.iter_mut() {
            if voice.active != 0 && voice.env.is_idle() {
                voice.active = 0;
            }
        }
    }
}

/// Host-independent entry for tests: clear the (mono) output, dispatch the supplied events through the
/// SDK template, and run the post-pass. The wasm `process` path uses [`abi::render_instrument`] instead,
/// which adds the event pull.
pub fn render(state: &mut SynthState, events: &[EventRecord], output: &mut [f32], sample_rate: f32) {
    use abi::Instrument;
    for sample in output.iter_mut() {
        *sample = 0.0;
    }
    abi::dispatch_range::<Synth>(state, output, events, sample_rate);
    Synth::finish(state, output, sample_rate);
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

/// Bytes the engine must allocate (zeroed) for one instance's state block. The sine's state is a fixed
/// voice array, so the size does not depend on `sample_rate`; the parameter keeps the ABI uniform with
/// devices whose state IS rate-sized (e.g. device-saw's delay buffer).
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<SynthState>() as u32
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

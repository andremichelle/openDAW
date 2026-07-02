//! A parallel AUX SEND (TS `AuxSendProcessor`): taps a unit's POST-effects / PRE-fader buffer, applies the
//! send's gain (dB) and pan, and produces an output that is summed into the target bus's `AudioBusProcessor`.
//! A dumb DSP node like the channel strip — it reads `SendParams` the engine keeps in sync with the
//! `AuxSendBox` (sendGain / sendPan), so the node holds no box knowledge. The pan law is the same linear
//! BALANCE law as the channel strip (center = unity on both channels, NOT constant-power). Per-sample gains
//! are de-clicked through `LinearRamp`s.

use alloc::rc::Rc;
use core::cell::Cell;
use math::db_to_gain;
use crate::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use crate::audio_generator::AudioGenerator;
use crate::audio_input::AudioInput;
use crate::event_buffer::EventBuffer;
use crate::event_receiver::EventReceiver;
use crate::process_info::ProcessInfo;
use crate::processor::Processor;
use crate::ramp::LinearRamp;
use crate::RENDER_QUANTUM;

/// The send's live parameters, shared (`Rc`) between the send node and the engine binding that keeps them in
/// sync with the `AuxSendBox` fields. Plain `Cell`s (single-threaded engine).
pub struct SendParams {
    pub gain_db: Cell<f32>,
    pub pan: Cell<f32> // -1 (left) .. +1 (right)
}

impl SendParams {
    pub fn new() -> Self {
        Self {gain_db: Cell::new(0.0), pan: Cell::new(0.0)}
    }
}

impl Default for SendParams {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AuxSendProcessor {
    params: Rc<SendParams>,
    output: SharedAudioBuffer,
    input: Option<SharedAudioBuffer>,
    gain_left: LinearRamp,
    gain_right: LinearRamp,
    processing: bool, // false until the first block, so the first targets jump (no ramp from 0)
    events: EventBuffer // unused, but required by `Processor: EventReceiver`
}

impl AuxSendProcessor {
    pub fn new(params: Rc<SendParams>, sample_rate: f32) -> Self {
        Self {
            params,
            output: shared_audio_buffer(),
            input: None,
            gain_left: LinearRamp::linear(sample_rate),
            gain_right: LinearRamp::linear(sample_rate),
            processing: false,
            events: EventBuffer::new()
        }
    }
}

impl EventReceiver for AuxSendProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for AuxSendProcessor {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.input = Some(source);
    }
}

impl AudioGenerator for AuxSendProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for AuxSendProcessor {
    fn reset(&mut self) {
        self.output.borrow_mut().clear();
    }

    fn process(&mut self, _info: &ProcessInfo) {
        let mut output = self.output.borrow_mut();
        let input = match &self.input {
            Some(input) => input,
            None => {
                output.clear_range(0, RENDER_QUANTUM);
                return;
            }
        };
        // sendGain (dB) -> linear, split into L/R by the balance pan law (TS AuxSendProcessor). Aim the ramps
        // at the new targets so parameter jumps de-click; `set` no-ops when a target is unchanged.
        let gain = db_to_gain(self.params.gain_db.get());
        let panning = self.params.pan.get();
        self.gain_left.set((1.0 - panning.max(0.0)) * gain, self.processing);
        self.gain_right.set((1.0 + panning.min(0.0)) * gain, self.processing);
        let source = input.borrow();
        for index in 0..RENDER_QUANTUM {
            output.left[index] = source.left[index] * self.gain_left.move_and_get();
            output.right[index] = source.right[index] * self.gain_right.move_and_get();
        }
        self.processing = true;
    }
}

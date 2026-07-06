//! A parallel AUX SEND (TS `AuxSendProcessor`): taps a unit's POST-effects / PRE-fader buffer, applies the
//! send's gain (dB) and pan, and produces an output that is summed into the target bus's `AudioBusProcessor`.
//! A dumb DSP node like the channel strip — it reads `SendParams` the engine keeps in sync with the
//! `AuxSendBox` (sendGain / sendPan), plus optional AUTOMATION closures (a `StripAutomation`, volume =
//! sendGain dB / panning = sendPan) resolved at the update clock, so the node holds no box knowledge. The
//! pan law is the same linear BALANCE law as the channel strip (center = unity on both channels, NOT
//! constant-power). Per-sample gains are de-clicked through `LinearRamp`s.

use alloc::rc::Rc;
use core::cell::Cell;
use math::db_to_gain;
use crate::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use crate::audio_generator::AudioGenerator;
use crate::audio_input::AudioInput;
use crate::block::Block;
use crate::channel_strip::StripAutomation;
use crate::event_buffer::EventBuffer;
use crate::event_receiver::EventReceiver;
use crate::ppqn::{first_update_position, pulses_to_samples, UPDATE_CLOCK_RATE};
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
    // The send's automation overrides, reusing the strip's shape: `volume` carries the sendGain curve (dB),
    // `panning` the sendPan curve (-1..1). `None` per parameter = not automated, the static `SendParams` rules.
    automation: Rc<StripAutomation>,
    output: SharedAudioBuffer,
    input: Option<SharedAudioBuffer>,
    gain_left: LinearRamp,
    gain_right: LinearRamp,
    sample_rate: f32,
    processing: bool, // false until the first chunk, so the first targets jump (no ramp from 0)
    // The last AUTOMATED values resolved at an update boundary, HELD while the transport is paused (the TS
    // `AutomatableParameter#value`, which only moves on update events — none arrive while not transporting).
    held_gain_db: Option<f32>,
    held_pan: Option<f32>,
    events: EventBuffer // unused, but required by `Processor: EventReceiver`
}

impl AuxSendProcessor {
    pub fn new(params: Rc<SendParams>, automation: Rc<StripAutomation>, sample_rate: f32) -> Self {
        Self {
            params,
            automation,
            output: shared_audio_buffer(),
            input: None,
            gain_left: LinearRamp::linear(sample_rate),
            gain_right: LinearRamp::linear(sample_rate),
            sample_rate,
            processing: false,
            held_gain_db: None,
            held_pan: None,
            events: EventBuffer::new()
        }
    }

    // Aim the L/R ramps at the balance-law gains. Smooth after the first processed chunk; `set` no-ops on an
    // unchanged target.
    fn retarget(&mut self, gain_db: f32, panning: f32) {
        let gain = db_to_gain(gain_db);
        self.gain_left.set((1.0 - panning.max(0.0)) * gain, self.processing);
        self.gain_right.set((1.0 + panning.min(0.0)) * gain, self.processing);
    }

    // Evaluate the automated sendGain / sendPan curves at `position` (falling back to the static params) and
    // retarget, remembering the resolved automated values for the paused hold. Called at each update-clock
    // boundary, mirroring TS `AutomatableParameter` events.
    fn retarget_at(&mut self, position: f64) {
        let gain_db = match self.automation.volume.borrow().as_ref() {
            Some(source) => {
                let value = source(position);
                self.held_gain_db = Some(value);
                value
            }
            None => self.params.gain_db.get()
        };
        let panning = match self.automation.panning.borrow().as_ref() {
            Some(source) => {
                let value = source(position);
                self.held_pan = Some(value);
                value
            }
            None => self.params.pan.get()
        };
        self.retarget(gain_db, panning);
    }

    // PAUSED (a non-transporting block): no update events (the TS `UpdateClock` gate), so an automated
    // sendGain / sendPan HOLDS its last resolved value; the static side still applies.
    fn retarget_held(&mut self) {
        let gain_db = match self.automation.volume.borrow().as_ref() {
            Some(_) => self.held_gain_db.unwrap_or_else(|| self.params.gain_db.get()),
            None => self.params.gain_db.get()
        };
        let panning = match self.automation.panning.borrow().as_ref() {
            Some(_) => self.held_pan.unwrap_or_else(|| self.params.pan.get()),
            None => self.params.pan.get()
        };
        self.retarget(gain_db, panning);
    }

    // Apply the gains over `[from, to)`: settled fast path (auto-vectorizable) vs the per-sample de-click ramps.
    fn apply(&mut self, source: &AudioBuffer, output: &mut AudioBuffer, from: usize, to: usize) {
        if self.gain_left.is_interpolating() || self.gain_right.is_interpolating() {
            for index in from..to {
                output.left[index] = source.left[index] * self.gain_left.move_and_get();
                output.right[index] = source.right[index] * self.gain_right.move_and_get();
            }
        } else {
            let gain_left = self.gain_left.get();
            let gain_right = self.gain_right.get();
            for index in from..to {
                output.left[index] = source.left[index] * gain_left;
                output.right[index] = source.right[index] * gain_right;
            }
        }
        self.processing = true; // per chunk (like TS), so a mid-quantum retarget already ramps
    }

    // Map an update-grid pulse to its sample offset within `block` (the engine's `sample_offset` formula).
    fn sample_offset(&self, position: f64, block: &Block) -> usize {
        let pulses = position - block.p0;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        let raw = if pulses.abs() < 1.0e-7 {
            s0
        } else {
            s0 + pulses_to_samples(pulses, block.bpm, self.sample_rate) as usize
        };
        raw.clamp(s0, s1)
    }
}

impl EventReceiver for AuxSendProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AuxSendProcessor {
    /// Detach the input (the source chain tore down): the send outputs silence instead of endlessly summing
    /// the last frozen buffer into its target bus.
    pub fn clear_audio_source(&mut self) {
        self.input = None;
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

    fn process(&mut self, info: &ProcessInfo) {
        let output = self.output.clone();
        let mut output = output.borrow_mut();
        let input = match &self.input {
            Some(input) => input.clone(),
            None => {
                output.clear_range(0, RENDER_QUANTUM);
                return;
            }
        };
        let source = input.borrow();
        let automated = self.automation.volume.borrow().is_some() || self.automation.panning.borrow().is_some();
        if !automated {
            // Static parameters: one retarget for the whole quantum (the ramps de-click any edit).
            self.retarget(self.params.gain_db.get(), self.params.pan.get());
            self.apply(&source, &mut output, 0, RENDER_QUANTUM);
        } else {
            // An automated sendGain / sendPan resolves at the UPDATE CLOCK, like the channel strip: split each
            // block at the 10-pulse grid and retarget at every boundary (TS `AudioProcessor`). A PAUSED
            // (non-transporting) block gets no update events (the TS `UpdateClock` gate): hold.
            for block in info.blocks {
                let (s0, s1) = (block.s0 as usize, block.s1 as usize);
                if !block.flags.transporting() {
                    self.retarget_held();
                    self.apply(&source, &mut output, s0, s1);
                    continue;
                }
                let mut cursor = s0;
                self.retarget_at(block.p0);
                let mut position = first_update_position(block.p0);
                while position < block.p1 {
                    let offset = self.sample_offset(position, block).clamp(cursor, s1);
                    if offset > cursor {
                        self.apply(&source, &mut output, cursor, offset);
                        cursor = offset;
                    }
                    self.retarget_at(position);
                    position += UPDATE_CLOCK_RATE;
                }
                if cursor < s1 {
                    self.apply(&source, &mut output, cursor, s1);
                }
            }
        }
    }
}

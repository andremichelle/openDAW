//! An audio unit's channel strip (TS `ChannelStripProcessor`): applies the unit's volume (dB), panning,
//! and mute to its input, producing the unit's output. A dumb DSP node — it reads its parameters from a
//! shared `StripParams` the engine keeps in sync with the `AudioUnitBox` (volume / panning / mute), so the
//! strip itself holds no box knowledge. Solo is a mixer-wide concern (cross-unit) and is not handled here
//! yet. Per-sample gains are de-clicked through `LinearRamp`s (L/R gain + a mute gain), as in TS.

use alloc::rc::Rc;
use core::cell::{Cell, RefCell};
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

/// The strip's live parameters, shared (`Rc`) between the strip node and the engine binding that keeps them
/// in sync with the unit's box fields. Plain `Cell`s, read on the audio thread, written by the box
/// subscriptions (single-threaded engine, so no atomics).
pub struct StripParams {
    pub volume_db: Cell<f32>,
    pub panning: Cell<f32>, // -1 (left) .. +1 (right)
    pub mute: Cell<bool>
}

impl StripParams {
    pub fn new() -> Self {
        Self {volume_db: Cell::new(0.0), panning: Cell::new(0.0), mute: Cell::new(false)}
    }
}

impl Default for StripParams {
    fn default() -> Self {
        Self::new()
    }
}

/// The strip's optional volume / panning AUTOMATION overrides: each closure maps a pulse position to the
/// strip-unit value (volume dB, panning -1..1) of the parameter's Value-track curve. `None` means the
/// parameter is not automated, so the strip uses the static `StripParams` value. Shared (`Rc`) between the
/// strip node and the engine binding, which swaps the closures in when a Value track attaches / detaches (like
/// `StripParams` is swapped for static edits). The engine owns the curve; the strip just calls the closure.
/// Maps a pulse position to a strip parameter's automated value (volume dB, panning -1..1). Built by the engine
/// from the parameter's Value-track curve; `None` when the parameter is not automated.
pub type StripValueSource = Rc<dyn Fn(f64) -> f32>;

pub struct StripAutomation {
    pub volume: RefCell<Option<StripValueSource>>,
    pub panning: RefCell<Option<StripValueSource>>
}

impl StripAutomation {
    pub fn new() -> Self {
        Self {volume: RefCell::new(None), panning: RefCell::new(None)}
    }
}

impl Default for StripAutomation {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ChannelStripProcessor {
    params: Rc<StripParams>,
    automation: Rc<StripAutomation>,
    output: SharedAudioBuffer,
    input: Option<SharedAudioBuffer>,
    gain_left: LinearRamp,
    gain_right: LinearRamp,
    mute_gain: LinearRamp,
    processing: bool, // false until the first block, so the first targets jump (no ramp from 0)
    events: EventBuffer // unused (the strip receives no events) but required by `Processor: EventReceiver`
}

impl ChannelStripProcessor {
    pub fn new(params: Rc<StripParams>, automation: Rc<StripAutomation>, sample_rate: f32) -> Self {
        Self {
            automation,
            params,
            output: shared_audio_buffer(),
            input: None,
            gain_left: LinearRamp::linear(sample_rate),
            gain_right: LinearRamp::linear(sample_rate),
            mute_gain: LinearRamp::linear(sample_rate),
            processing: false,
            events: EventBuffer::new()
        }
    }
}

impl EventReceiver for ChannelStripProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for ChannelStripProcessor {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.input = Some(source);
    }
}

impl AudioGenerator for ChannelStripProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for ChannelStripProcessor {
    fn reset(&mut self) {
        self.output.borrow_mut().clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        let mut output = self.output.borrow_mut();
        let input = match &self.input {
            Some(input) => input,
            None => {
                output.clear_range(0, RENDER_QUANTUM);
                return;
            }
        };
        // Volume in dB -> linear gain, split into L/R by the pan law (TS ChannelStripProcessor); mute is a
        // separate 0/1 gain. Aim the ramps at the new targets (smooth after the first block) so parameter
        // jumps de-click; `set` is a no-op when a target is unchanged.
        // An AUTOMATED volume / panning overrides the static value: evaluate its curve at this quantum's pulse
        // position; the L/R ramps then de-click the per-block value like any parameter move.
        let position = info.blocks.first().map_or(0.0, |block| block.p0);
        let volume_db = match self.automation.volume.borrow().as_ref() {
            Some(source) => source(position),
            None => self.params.volume_db.get()
        };
        let panning = match self.automation.panning.borrow().as_ref() {
            Some(source) => source(position),
            None => self.params.panning.get()
        };
        let gain = db_to_gain(volume_db);
        self.gain_left.set((1.0 - panning.max(0.0)) * gain, self.processing);
        self.gain_right.set((1.0 + panning.min(0.0)) * gain, self.processing);
        self.mute_gain.set(if self.params.mute.get() {0.0} else {1.0}, self.processing);
        let source = input.borrow();
        for index in 0..RENDER_QUANTUM {
            let mute = self.mute_gain.move_and_get();
            output.left[index] = source.left[index] * self.gain_left.move_and_get() * mute;
            output.right[index] = source.right[index] * self.gain_right.move_and_get() * mute;
        }
        self.processing = true;
    }
}

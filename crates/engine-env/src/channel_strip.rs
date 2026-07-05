//! An audio unit's channel strip (TS `ChannelStripProcessor`): applies the unit's volume (dB), panning,
//! and mute to its input, producing the unit's output. A dumb DSP node — it reads its parameters from a
//! shared `StripParams` the engine keeps in sync with the `AudioUnitBox` (volume / panning / mute), so the
//! strip itself holds no box knowledge. Solo is a mixer-wide concern (cross-unit) and is not handled here
//! yet. Per-sample gains are de-clicked through `LinearRamp`s (L/R gain + a mute gain), as in TS.

use alloc::rc::Rc;
use core::cell::{Cell, RefCell};
use math::db_to_gain;
use crate::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use crate::block::Block;
use crate::ppqn::{first_update_position, pulses_to_samples, UPDATE_CLOCK_RATE};
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
    meter: crate::meter::Meter, // peaks/RMS of the strip output (a broadcast slot)
    sample_rate: f32,
    processing: bool, // false until the first chunk, so the first targets jump (no ramp from 0)
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
            meter: crate::meter::Meter::new(sample_rate),
            sample_rate,
            processing: false,
            events: EventBuffer::new()
        }
    }

    // Aim the three ramps at the pan-law gains for `volume_db` / `panning` (+ the mute 0/1). Smooth after the
    // first processed chunk so parameter moves de-click; `set` no-ops on an unchanged target.
    fn retarget(&mut self, volume_db: f32, panning: f32) {
        let gain = db_to_gain(volume_db);
        self.gain_left.set((1.0 - panning.max(0.0)) * gain, self.processing);
        self.gain_right.set((1.0 + panning.min(0.0)) * gain, self.processing);
        self.mute_gain.set(if self.params.mute.get() {0.0} else {1.0}, self.processing);
    }

    // Evaluate the automated volume / panning curves at `position` (falling back to the static params) and
    // retarget. Called at each update-clock boundary, mirroring TS `AutomatableParameter` events.
    fn retarget_at(&mut self, position: f64) {
        let volume_db = match self.automation.volume.borrow().as_ref() {
            Some(source) => source(position),
            None => self.params.volume_db.get()
        };
        let panning = match self.automation.panning.borrow().as_ref() {
            Some(source) => source(position),
            None => self.params.panning.get()
        };
        self.retarget(volume_db, panning);
    }

    // Apply the gains over `[from, to)`. Settled fast path (TS `isInterpolating` branch): scalar gains keep
    // the loop auto-vectorizable; the ramped branch keeps the per-sample de-click. Two multiplies in BOTH
    // branches (float multiplication does not re-associate, the branches must produce identical samples).
    fn apply(&mut self, source: &AudioBuffer, output: &mut AudioBuffer, from: usize, to: usize) {
        if self.gain_left.is_interpolating() || self.gain_right.is_interpolating() || self.mute_gain.is_interpolating() {
            for index in from..to {
                let mute = self.mute_gain.move_and_get();
                output.left[index] = source.left[index] * self.gain_left.move_and_get() * mute;
                output.right[index] = source.right[index] * self.gain_right.move_and_get() * mute;
            }
        } else {
            let gain_left = self.gain_left.get();
            let gain_right = self.gain_right.get();
            let mute = self.mute_gain.get();
            for index in from..to {
                output.left[index] = source.left[index] * gain_left * mute;
                output.right[index] = source.right[index] * gain_right * mute;
            }
        }
        self.processing = true; // TS sets it per processed sub-block, so a mid-quantum retarget already ramps
    }

    /// The peak/RMS broadcast slot of this strip's output.
    pub fn meter_slot(&self) -> crate::telemetry::BroadcastSlot {
        self.meter.slot()
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
        self.meter.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        let output = self.output.clone();
        let mut output = output.borrow_mut();
        let input = match &self.input {
            Some(input) => input.clone(),
            None => {
                output.clear_range(0, RENDER_QUANTUM);
                self.meter.process(&output.left, &output.right); // the held peak still decays while unwired
                return;
            }
        };
        let source = input.borrow();
        let automated = self.automation.volume.borrow().is_some() || self.automation.panning.borrow().is_some();
        if !automated {
            // Static parameters: one retarget for the whole quantum (the ramps de-click any edit).
            self.retarget(self.params.volume_db.get(), self.params.panning.get());
            self.apply(&source, &mut output, 0, RENDER_QUANTUM);
        } else {
            // An automated volume / panning resolves at the UPDATE CLOCK, like every automated device: split
            // each block at the 10-pulse grid and retarget at every boundary (TS `AudioProcessor` splitting
            // the quantum at `UpdateEvent`s). A loop-wrap quantum's post-wrap block re-evaluates at ITS p0.
            for block in info.blocks {
                let (s0, s1) = (block.s0 as usize, block.s1 as usize);
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
        self.meter.process(&output.left, &output.right);
    }
}

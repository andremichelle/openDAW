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
    pub mute: Cell<bool>,
    pub solo: Cell<bool>,
    // Set by the engine's SOLO resolution (TS `Mixer.updateSolo`): true while another unit is soloed and
    // this one is neither soloed nor kept audible by the routing walk. Silences like mute (de-clicked).
    pub forced_silent: Cell<bool>
}

impl StripParams {
    pub fn new() -> Self {
        Self {volume_db: Cell::new(0.0), panning: Cell::new(0.0), mute: Cell::new(false),
            solo: Cell::new(false), forced_silent: Cell::new(false)}
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
    // The last AUTOMATED values resolved at an update boundary, HELD while the transport is paused (the TS
    // `AutomatableParameter#value`, which only moves on update events — none arrive while not transporting).
    held_volume_db: Option<f32>,
    held_panning: Option<f32>,
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
            held_volume_db: None,
            held_panning: None,
            events: EventBuffer::new()
        }
    }

    // Aim the three ramps at the pan-law gains for `volume_db` / `panning` (+ the mute 0/1). Smooth after the
    // first processed chunk so parameter moves de-click; `set` no-ops on an unchanged target.
    fn retarget(&mut self, volume_db: f32, panning: f32) {
        let gain = db_to_gain(volume_db);
        self.gain_left.set((1.0 - panning.max(0.0)) * gain, self.processing);
        self.gain_right.set((1.0 + panning.min(0.0)) * gain, self.processing);
        let silent = self.params.mute.get() || self.params.forced_silent.get();
        self.mute_gain.set(if silent {0.0} else {1.0}, self.processing);
    }

    // Evaluate the automated volume / panning curves at `position` (falling back to the static params) and
    // retarget, remembering the resolved automated values for the paused hold. Called at each update-clock
    // boundary, mirroring TS `AutomatableParameter` events.
    fn retarget_at(&mut self, position: f64) {
        let volume_db = match self.automation.volume.borrow().as_ref() {
            Some(source) => {
                let value = source(position);
                self.held_volume_db = Some(value);
                value
            }
            None => self.params.volume_db.get()
        };
        let panning = match self.automation.panning.borrow().as_ref() {
            Some(source) => {
                let value = source(position);
                self.held_panning = Some(value);
                value
            }
            None => self.params.panning.get()
        };
        self.retarget(volume_db, panning);
    }

    // PAUSED (a non-transporting block): the update clock is silent (TS `UpdateClock` gates on
    // `BlockFlag.transporting`), so an automated parameter HOLDS its last resolved value — never re-read at
    // the free-running paused position — while the static side (an edit, mute) still applies like TS's
    // `parameterChanged` -> `processAudio` path. Before any update event ever fired, the hold is the static
    // field value (the TS `AutomatableParameter` initial `#value`).
    fn retarget_held(&mut self) {
        let volume_db = match self.automation.volume.borrow().as_ref() {
            Some(_) => self.held_volume_db.unwrap_or_else(|| self.params.volume_db.get()),
            None => self.params.volume_db.get()
        };
        let panning = match self.automation.panning.borrow().as_ref() {
            Some(_) => self.held_panning.unwrap_or_else(|| self.params.panning.get()),
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
            // A PAUSED (non-transporting) block gets no update events (the TS `UpdateClock` gate): hold.
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
        self.meter.process(&output.left, &output.right);
    }
}

#[cfg(test)]
mod tests {
    //! Paused (non-transporting) blocks must HOLD an automated parameter: the TS `UpdateClock` emits no
    //! update events without `BlockFlag.transporting`, so `AutomatableParameter#value` freezes — the strip
    //! must neither re-resolve the curve at the paused free-running position nor move its gains.
    use alloc::rc::Rc;
    use core::cell::Cell;
    use crate::block::Block;
    use crate::block_flags::BlockFlags;
    use crate::process_info::ProcessInfo;
    use crate::processor::Processor;
    use crate::audio_input::AudioInput;
    use crate::audio_generator::AudioGenerator;
    use crate::audio_buffer::shared_audio_buffer;
    use crate::RENDER_QUANTUM;
    use super::{ChannelStripProcessor, StripAutomation, StripParams};

    const SR: f32 = 48_000.0;

    fn block(transporting: bool, p0: f64) -> Block {
        Block {index: 0, flags: BlockFlags::create(transporting, false, transporting, false),
            p0, p1: p0 + 5.12, s0: 0, s1: RENDER_QUANTUM as u32, bpm: 120.0}
    }

    #[test]
    fn paused_blocks_hold_the_automated_gain_and_never_resolve_the_curve() {
        let params = Rc::new(StripParams::new());
        let automation = Rc::new(StripAutomation::new());
        let calls = Rc::new(Cell::new(0u32));
        let calls_probe = calls.clone();
        // The curve: -20 dB early, +12 dB at the paused free-running position — a paused re-resolve would
        // audibly JUMP the gain; the call counter proves the closure is never consulted while paused.
        *automation.volume.borrow_mut() = Some(Rc::new(move |position: f64| {
            calls_probe.set(calls_probe.get() + 1);
            if position < 100.0 {-20.0} else {12.0}
        }));
        let mut strip = ChannelStripProcessor::new(params, automation, SR);
        let input = shared_audio_buffer();
        {
            let mut buffer = input.borrow_mut();
            buffer.left.fill(1.0);
            buffer.right.fill(1.0);
        }
        strip.set_audio_source(input);
        strip.process(&ProcessInfo {blocks: &[block(true, 0.0)]});
        let transporting_calls = calls.get();
        assert!(transporting_calls > 0, "a transporting block resolves the curve at the update clock");
        strip.process(&ProcessInfo {blocks: &[block(false, 500.0)]});
        assert_eq!(calls.get(), transporting_calls, "a paused block must NOT resolve the automation curve");
        let output = strip.audio_output();
        let output = output.borrow();
        let expected = math::db_to_gain(-20.0);
        for index in 0..RENDER_QUANTUM {
            assert!((output.left[index] - expected).abs() < 1.0e-4,
                "paused sample {index} must keep the held -20 dB gain, got {}", output.left[index]);
        }
    }
}

//! The two DSP nodes an EFFECT COMPOSITE (a parallel fx stack / split container) needs beyond what already
//! exists. Everything else it is built from is reused: each ENTRY's gain / mute / solo strip is a plain
//! `ChannelStripProcessor` (volume = the entry's gain, `forced_silent` = the cross-entry solo gate) with its
//! panning left at 0, and the entries' wet sum is a plain `AudioBusProcessor`.
//!
//! Signal flow of an audio composite:
//! ```text
//!   upstream -> Distributor -> (branch per entry) -> entry chain -> entry strip -\
//!                    |                                                            +-> wet sum -\
//!                    |                                                                          +-> DryWetMix -> downstream
//!                    \------------------------- the input TAP (dry) ---------------------------/
//! ```
//! The distributor OWNS its input copy (the `tap`). That is what makes a nested device's sidechain on the
//! composite's INPUT survive replacing the plugin upstream of the composite: the tap buffer's identity never
//! changes, only the distributor's source is re-pointed.

use alloc::rc::Rc;
use alloc::vec::Vec;
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

/// How the composite's input reaches its entries.
// WASM CONTRACT: mirrors `Distributor` in crates/engine/src/lib.rs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DistributorMode {
    /// Every entry reads the same signal (the plain parallel stack).
    Broadcast,
    /// Per-channel split: entry 0 reads `(left, 0)`, entry 1 reads `(0, right)`. Summing the untouched
    /// branches recombines the input EXACTLY, so an empty stereo split is bit-identical to a bypass.
    Stereo
}

/// Copies the composite's input into a tap it OWNS, and presents one source buffer per entry.
///
/// For `Broadcast` every entry shares the tap itself, so no per-entry copy happens at all. For `Stereo` the
/// branches are separate buffers holding one channel each. An entry index beyond the distributor's branch count
/// reads SILENCE: a split's entry count is a UI invariant the engine does not enforce, so a stray extra entry
/// (a corrupt project, a future regression) contributes nothing rather than DOUBLING a channel into the mix.
pub struct DistributorProcessor {
    mode: DistributorMode,
    input: Option<SharedAudioBuffer>,
    tap: SharedAudioBuffer,
    branches: Vec<SharedAudioBuffer>,
    silent: SharedAudioBuffer, // fixed cleared buffer for out-of-range entries (never written)
    events: EventBuffer
}

impl DistributorProcessor {
    pub fn new(mode: DistributorMode) -> Self {
        let tap = shared_audio_buffer();
        // Broadcast hands every entry the tap itself; a stereo split needs one buffer per channel.
        let branches = match mode {
            DistributorMode::Broadcast => Vec::new(),
            DistributorMode::Stereo => alloc::vec![shared_audio_buffer(), shared_audio_buffer()]
        };
        Self {mode, input: None, tap, branches, silent: shared_audio_buffer(), events: EventBuffer::new()}
    }

    /// The composite's INPUT copy: the dry source, and the buffer a nested sidechain taps.
    pub fn tap(&self) -> SharedAudioBuffer {
        self.tap.clone()
    }

    /// The source buffer entry `index` reads.
    pub fn branch(&self, index: usize) -> SharedAudioBuffer {
        match self.mode {
            DistributorMode::Broadcast => self.tap.clone(),
            DistributorMode::Stereo => self.branches.get(index).unwrap_or(&self.silent).clone()
        }
    }

    /// Detach the input (the upstream chain tore down): the composite reads silence rather than endlessly
    /// re-reading the last frozen buffer.
    pub fn clear_audio_source(&mut self) {
        self.input = None;
    }
}

impl EventReceiver for DistributorProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for DistributorProcessor {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.input = Some(source);
    }
}

impl AudioGenerator for DistributorProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.tap.clone()
    }
}

impl Processor for DistributorProcessor {
    fn reset(&mut self) {
        self.tap.borrow_mut().clear();
        for branch in &self.branches {
            branch.borrow_mut().clear();
        }
    }

    fn process(&mut self, _info: &ProcessInfo) {
        let tap = self.tap.clone();
        let mut tap = tap.borrow_mut();
        match &self.input {
            Some(input) => {
                let source = input.borrow();
                tap.left[..RENDER_QUANTUM].copy_from_slice(&source.left[..RENDER_QUANTUM]);
                tap.right[..RENDER_QUANTUM].copy_from_slice(&source.right[..RENDER_QUANTUM]);
            }
            None => tap.clear_range(0, RENDER_QUANTUM)
        }
        if self.mode == DistributorMode::Stereo {
            let mut left = self.branches[0].borrow_mut();
            let mut right = self.branches[1].borrow_mut();
            for index in 0..RENDER_QUANTUM {
                left.left[index] = tap.left[index];
                left.right[index] = 0.0;
                right.left[index] = 0.0;
                right.right[index] = tap.right[index];
            }
        }
    }
}

/// The composite's dry / wet gains (dB), shared (`Rc`) between the mix node and the engine binding that keeps
/// them in sync with the composite box's fields. Plain `Cell`s (single-threaded engine).
pub struct DryWetParams {
    pub dry_db: Cell<f32>,
    pub wet_db: Cell<f32>,
    /// Set by the engine while the composite has NO entries: the composite then passes its input through
    /// unchanged, whatever dry / wet say, so inserting a fresh stack never kills the chain.
    pub bypass: Cell<bool>
}

impl DryWetParams {
    pub fn new() -> Self {
        // Dry defaults to SILENT and wet to 0dB: a composite REPLACES the signal unless the user raises dry.
        Self {dry_db: Cell::new(f32::NEG_INFINITY), wet_db: Cell::new(0.0), bypass: Cell::new(true)}
    }
}

impl Default for DryWetParams {
    fn default() -> Self {
        Self::new()
    }
}

/// Blends the composite's dry input against its entries' wet sum: `out = dry * tap + wet * wetSum`.
///
/// While `bypass` is set (no entries) it copies the tap through untouched, so an empty composite is an exact
/// identity — its output buffer stays the SAME object either way, so the downstream chain is never re-wired.
/// The gains resolve at the UPDATE CLOCK when automated (the `StripAutomation` shape the strip and the aux
/// sends use: `volume` carries dry, `panning` carries wet) and are de-clicked through `LinearRamp`s.
pub struct DryWetMixProcessor {
    params: Rc<DryWetParams>,
    meter: crate::meter::Meter, // peaks/RMS of the composite's OUTPUT (a broadcast slot), like any device
    automation: Rc<StripAutomation>,
    output: SharedAudioBuffer,
    tap: SharedAudioBuffer,
    wet_sum: SharedAudioBuffer,
    dry_gain: LinearRamp,
    wet_gain: LinearRamp,
    sample_rate: f32,
    processing: bool, // false until the first chunk, so the first targets jump (no ramp from 0)
    held_dry_db: Option<f32>,
    held_wet_db: Option<f32>,
    events: EventBuffer
}

impl DryWetMixProcessor {
    pub fn new(params: Rc<DryWetParams>, automation: Rc<StripAutomation>, tap: SharedAudioBuffer,
               wet_sum: SharedAudioBuffer, sample_rate: f32) -> Self {
        Self {
            params,
            meter: crate::meter::Meter::new(sample_rate),
            automation,
            output: shared_audio_buffer(),
            tap,
            wet_sum,
            dry_gain: LinearRamp::linear(sample_rate),
            wet_gain: LinearRamp::linear(sample_rate),
            sample_rate,
            processing: false,
            held_dry_db: None,
            held_wet_db: None,
            events: EventBuffer::new()
        }
    }

    // Aim both ramps. Smooth after the first processed chunk; `set` no-ops on an unchanged target.
    fn retarget(&mut self, dry_db: f32, wet_db: f32) {
        self.dry_gain.set(db_to_gain(dry_db), self.processing);
        self.wet_gain.set(db_to_gain(wet_db), self.processing);
    }

    // Evaluate the automated dry / wet curves at `position` (falling back to the static params), remembering
    // the resolved values for the paused hold. `volume` carries dry, `panning` carries wet (the shared
    // `StripAutomation` shape; a composite has no pan of its own).
    fn retarget_at(&mut self, position: f64) {
        let dry_db = match self.automation.volume.borrow().as_ref() {
            Some(source) => {
                let value = source(position);
                self.held_dry_db = Some(value);
                value
            }
            None => self.params.dry_db.get()
        };
        let wet_db = match self.automation.panning.borrow().as_ref() {
            Some(source) => {
                let value = source(position);
                self.held_wet_db = Some(value);
                value
            }
            None => self.params.wet_db.get()
        };
        self.retarget(dry_db, wet_db);
    }

    // PAUSED (a non-transporting block): no update events, so an automated dry / wet HOLDS its last resolved
    // value; the static side still applies.
    fn retarget_held(&mut self) {
        let dry_db = match self.automation.volume.borrow().as_ref() {
            Some(_) => self.held_dry_db.unwrap_or_else(|| self.params.dry_db.get()),
            None => self.params.dry_db.get()
        };
        let wet_db = match self.automation.panning.borrow().as_ref() {
            Some(_) => self.held_wet_db.unwrap_or_else(|| self.params.wet_db.get()),
            None => self.params.wet_db.get()
        };
        self.retarget(dry_db, wet_db);
    }

    // Mix `[from, to)`: settled fast path (auto-vectorizable) vs the per-sample de-click ramps.
    fn apply(&mut self, dry: &AudioBuffer, wet: &AudioBuffer, output: &mut AudioBuffer, from: usize, to: usize) {
        if self.dry_gain.is_interpolating() || self.wet_gain.is_interpolating() {
            for index in from..to {
                let dry_gain = self.dry_gain.move_and_get();
                let wet_gain = self.wet_gain.move_and_get();
                output.left[index] = dry.left[index] * dry_gain + wet.left[index] * wet_gain;
                output.right[index] = dry.right[index] * dry_gain + wet.right[index] * wet_gain;
            }
        } else {
            let dry_gain = self.dry_gain.get();
            let wet_gain = self.wet_gain.get();
            for index in from..to {
                output.left[index] = dry.left[index] * dry_gain + wet.left[index] * wet_gain;
                output.right[index] = dry.right[index] * dry_gain + wet.right[index] * wet_gain;
            }
        }
        self.processing = true; // per chunk (like the strip), so a mid-quantum retarget already ramps
    }

    /// The peak/RMS broadcast slot of the composite's output — what the device's peak meter reads.
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

impl EventReceiver for DryWetMixProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioGenerator for DryWetMixProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for DryWetMixProcessor {
    fn reset(&mut self) {
        self.output.borrow_mut().clear();
        self.meter.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        // Clone the handles before borrowing: a borrow taken straight off `self` would freeze `self` and block
        // the `&mut self` retargets below (the aux send does the same).
        let output = self.output.clone();
        let tap = self.tap.clone();
        let wet_sum = self.wet_sum.clone();
        let mut output = output.borrow_mut();
        let dry = tap.borrow();
        // An EMPTY composite passes its input through untouched, whatever dry / wet say, so inserting a fresh
        // stack never kills the chain. Same output buffer, so nothing downstream re-wires.
        if self.params.bypass.get() {
            output.left[..RENDER_QUANTUM].copy_from_slice(&dry.left[..RENDER_QUANTUM]);
            output.right[..RENDER_QUANTUM].copy_from_slice(&dry.right[..RENDER_QUANTUM]);
            // The ramps must not carry a stale target into the next non-bypassed block.
            self.processing = false;
            self.meter.process(&output.left, &output.right); // an empty stack still shows its pass-through
            return;
        }
        let wet = wet_sum.borrow();
        let automated = self.automation.volume.borrow().is_some() || self.automation.panning.borrow().is_some();
        if !automated {
            // Static parameters: one retarget for the whole quantum (the ramps de-click any edit).
            self.retarget(self.params.dry_db.get(), self.params.wet_db.get());
            self.apply(&dry, &wet, &mut output, 0, RENDER_QUANTUM);
            self.meter.process(&output.left, &output.right);
            return;
        }
        // An automated dry / wet resolves at the UPDATE CLOCK, like the channel strip and the aux sends: split
        // each block at the 10-pulse grid and retarget at every boundary. A PAUSED block gets no update events.
        for block in info.blocks {
            let (s0, s1) = (block.s0 as usize, block.s1 as usize);
            if !block.flags.transporting() {
                self.retarget_held();
                self.apply(&dry, &wet, &mut output, s0, s1);
                continue;
            }
            let mut cursor = s0;
            self.retarget_at(block.p0);
            let mut position = first_update_position(block.p0);
            while position < block.p1 {
                let offset = self.sample_offset(position, block).clamp(cursor, s1);
                if offset > cursor {
                    self.apply(&dry, &wet, &mut output, cursor, offset);
                    cursor = offset;
                }
                self.retarget_at(position);
                position += UPDATE_CLOCK_RATE;
            }
            if cursor < s1 {
                self.apply(&dry, &wet, &mut output, cursor, s1);
            }
        }
        self.meter.process(&output.left, &output.right);
    }
}

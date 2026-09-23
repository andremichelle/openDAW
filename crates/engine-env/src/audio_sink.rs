//! An AUDIO SINK (the `AudioSinkDeviceBox`): a 1:1 cable sitting IN an audio chain. Its `tap` is a copy of the
//! input the engine sums into the target bus, its `output` is what the chain continues from: the input at the
//! `pass` level (dB, -inf = the chain goes silent, 0 dB = a full copy). A dumb node like the aux send: it reads
//! `SendParams.gain_db` the engine keeps in sync with the box, plus an optional automation closure
//! (`StripAutomation.volume`) resolved at the update clock. The gain is de-clicked through a `LinearRamp`.

use alloc::rc::Rc;
use math::db_to_gain;
use crate::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use crate::audio_generator::AudioGenerator;
use crate::audio_input::AudioInput;
use crate::aux_send::SendParams;
use crate::block::Block;
use crate::channel_strip::StripAutomation;
use crate::event_buffer::EventBuffer;
use crate::event_receiver::EventReceiver;
use crate::meter::Meter;
use crate::ppqn::{first_update_position, pulses_to_samples, UPDATE_CLOCK_RATE};
use crate::process_info::ProcessInfo;
use crate::processor::Processor;
use crate::ramp::LinearRamp;
use crate::telemetry::BroadcastSlot;
use crate::RENDER_QUANTUM;

pub struct AudioSinkProcessor {
    params: Rc<SendParams>, // `gain_db` = the pass level (pan unused)
    automation: Rc<StripAutomation>, // `volume` = the pass automation override
    output: SharedAudioBuffer,
    tap: SharedAudioBuffer,
    input: Option<SharedAudioBuffer>,
    gain: LinearRamp,
    sample_rate: f32,
    processing: bool, // false until the first chunk, so the first target jumps (no ramp from 0)
    meter: Meter, // peaks/RMS of the tap, what the bus receives (a broadcast slot)
    events: EventBuffer // unused, but required by `Processor: EventReceiver`
}

impl AudioSinkProcessor {
    pub fn new(params: Rc<SendParams>, automation: Rc<StripAutomation>, sample_rate: f32) -> Self {
        Self {
            params,
            automation,
            output: shared_audio_buffer(),
            tap: shared_audio_buffer(),
            input: None,
            gain: LinearRamp::linear(sample_rate),
            sample_rate,
            processing: false,
            meter: Meter::new(sample_rate),
            events: EventBuffer::new()
        }
    }

    pub fn meter_slot(&self) -> BroadcastSlot {
        self.meter.slot()
    }

    fn retarget(&mut self, gain_db: f32) {
        self.gain.set(db_to_gain(gain_db), self.processing);
    }

    fn retarget_resolved(&mut self, position: f64, transporting: bool) {
        let gain_db = match self.automation.volume.borrow().as_ref() {
            Some(source) => source(position, transporting),
            None => self.params.gain_db.get()
        };
        self.retarget(gain_db);
    }

    fn apply(&mut self, source: &AudioBuffer, output: &mut AudioBuffer, from: usize, to: usize) {
        if self.gain.is_interpolating() {
            for index in from..to {
                let gain = self.gain.move_and_get();
                output.left[index] = source.left[index] * gain;
                output.right[index] = source.right[index] * gain;
            }
        } else {
            let gain = self.gain.get();
            for index in from..to {
                output.left[index] = source.left[index] * gain;
                output.right[index] = source.right[index] * gain;
            }
        }
        self.processing = true;
    }

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

    /// The copy of the input the target bus sums (always the full signal, regardless of the pass level).
    pub fn tap_output(&self) -> SharedAudioBuffer {
        self.tap.clone()
    }

    /// Whether a chain wired this sink an input (every chain wire loop must, or the sink is a silent identity).
    pub fn has_audio_source(&self) -> bool {
        self.input.is_some()
    }

    /// Detach the input (the source chain tore down): both buffers go silent instead of holding the last
    /// frozen quantum.
    pub fn clear_audio_source(&mut self) {
        self.input = None;
    }
}

impl EventReceiver for AudioSinkProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for AudioSinkProcessor {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.input = Some(source);
    }
}

impl AudioGenerator for AudioSinkProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for AudioSinkProcessor {
    fn reset(&mut self) {
        self.output.borrow_mut().clear();
        self.tap.borrow_mut().clear();
        self.meter.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        let output = self.output.clone();
        let tap = self.tap.clone();
        let mut output = output.borrow_mut();
        let mut tap = tap.borrow_mut();
        let Some(input) = self.input.clone() else {
            output.clear_range(0, RENDER_QUANTUM);
            tap.clear_range(0, RENDER_QUANTUM);
            self.meter.process(&tap.left, &tap.right); // the held peak still decays while unwired
            return;
        };
        let source = input.borrow();
        tap.left.copy_from_slice(&source.left);
        tap.right.copy_from_slice(&source.right);
        self.meter.process(&tap.left, &tap.right);
        if self.automation.volume.borrow().is_none() {
            self.retarget(self.params.gain_db.get());
            self.apply(&source, &mut output, 0, RENDER_QUANTUM);
            return;
        }
        // An automated pass level resolves at the UPDATE CLOCK like the channel strip / aux send: split each
        // block at the 10-pulse grid, retarget at every boundary, HOLD while paused.
        for block in info.blocks {
            let (s0, s1) = (block.s0 as usize, block.s1 as usize);
            if !block.flags.transporting() {
                self.retarget_resolved(block.p0, false);
                self.apply(&source, &mut output, s0, s1);
                continue;
            }
            let mut cursor = s0;
            self.retarget_resolved(block.p0, true);
            let mut position = first_update_position(block.p0);
            while position < block.p1 {
                let offset = self.sample_offset(position, block).clamp(cursor, s1);
                if offset > cursor {
                    self.apply(&source, &mut output, cursor, offset);
                    cursor = offset;
                }
                self.retarget_resolved(position, true);
                position += UPDATE_CLOCK_RATE;
            }
            if cursor < s1 {
                self.apply(&source, &mut output, cursor, s1);
            }
        }
    }
}

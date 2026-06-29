//! A summing bus, ported from core-processors `AudioBusProcessor`. It owns an output buffer and a list
//! of shared source buffers added via `add_audio_source`; each render it clears its output and sums the
//! sources into it. Used for an audio bus and for the output audio unit (no channel-strip gain yet).
//! Topological ordering guarantees the sources are rendered before this node runs.

use alloc::rc::Rc;
use alloc::vec::Vec;
use crate::audio_buffer::SharedAudioBuffer;
use crate::audio_generator::AudioGenerator;
use crate::event_buffer::EventBuffer;
use crate::event_receiver::EventReceiver;
use crate::process_info::ProcessInfo;
use crate::processor::Processor;
use crate::RENDER_QUANTUM;

pub struct AudioBusProcessor {
    output: SharedAudioBuffer,
    sources: Vec<SharedAudioBuffer>,
    enabled: bool,
    events: EventBuffer
}

impl AudioBusProcessor {
    pub fn new(output: SharedAudioBuffer) -> Self {
        Self {output, sources: Vec::new(), enabled: true, events: EventBuffer::new()}
    }

    /// Enable / disable the bus. A disabled bus outputs silence (it stops summing its sources). Used to bypass a
    /// composite device (e.g. a disabled Playfield): the children keep their state but contribute no signal.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Add a source whose output is summed into this bus (TS `addAudioSource`).
    pub fn add_audio_source(&mut self, source: SharedAudioBuffer) {
        self.sources.push(source);
    }

    /// Remove a previously added source (by buffer identity), e.g. when its audio unit is removed.
    pub fn remove_audio_source(&mut self, source: &SharedAudioBuffer) {
        self.sources.retain(|existing| !Rc::ptr_eq(existing, source));
    }

    /// How many sources this bus currently sums (for tests / introspection).
    pub fn audio_source_count(&self) -> usize {
        self.sources.len()
    }
}

impl EventReceiver for AudioBusProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioGenerator for AudioBusProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for AudioBusProcessor {
    fn reset(&mut self) {
        self.output.borrow_mut().clear();
    }

    fn process(&mut self, _info: &ProcessInfo) {
        let mut output = self.output.borrow_mut();
        output.clear_range(0, RENDER_QUANTUM);
        if !self.enabled {
            return; // disabled (bypassed composite): emit silence, sum nothing
        }
        for source in &self.sources {
            let source = source.borrow();
            output.add_range(&source, 0, RENDER_QUANTUM);
        }
    }
}

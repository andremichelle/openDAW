//! The block/event split template, ported from core-processors `AudioProcessor.process` (which extends
//! `AbstractProcessor`). The default `process` walks each block's events in order, renders audio up to
//! each event's sample offset (`process_audio`), then dispatches the event at that boundary
//! (`handle_event`, or `update_parameters` for an update-clock tick). Implementors supply the two
//! required hooks plus their `event_input` and `sample_rate`.
//!
//! `introduce_block` runs first per block, so a note-driven instrument fills its own `event_input`
//! there (pulling its note source); we then read `event_input` live, exactly like TS, and `clear` at
//! the end. TS keeps a per-block `anyEvents` array to defer handling; the audio thread must not
//! allocate, so we render-to-boundary then handle-at-boundary directly (events are Copy, read by index,
//! no per-block buffer). The render/handle ordering is identical: audio before an event, the event,
//! then audio after it.
//!
//! `AbstractProcessor`'s parameter-binding machinery (`bindParameter`, `AutomatableParameter`, the
//! update-clock connection) is not ported yet; it needs the parameter/automation layer + EngineContext.
//! Until then `update_parameters` is a no-op hook, but update events are already dispatched to it.

use crate::block::Block;
use crate::event::Event;
use crate::event_receiver::EventReceiver;
use crate::ppqn::{pulses_to_samples, pulses_to_seconds};
use crate::process_info::ProcessInfo;

/// Extends `EventReceiver` (the per-block `event_input` the template drains).
pub trait AudioProcessor: EventReceiver {
    /// Engine sample rate (the ambient global `sampleRate` in TS).
    fn sample_rate(&self) -> f32;

    /// Render one contiguous sub-block into this processor's output (TS `processAudio`).
    fn process_audio(&mut self, chunk: &Block);

    /// Apply one runtime event at its boundary (TS `handleEvent`): a note-on / note-off, etc.
    fn handle_event(&mut self, event: &Event);

    /// Hook called once per block before its events (TS `introduceBlock`).
    fn introduce_block(&mut self, _block: &Block) {}

    /// Poll automated parameters at an update-clock tick (TS `updateParameters`). No-op until the
    /// parameter/automation layer lands.
    fn update_parameters(&mut self, _position: f64, _block_time_seconds: f64) {}

    /// Hook called once after all blocks (TS `finishProcess`).
    fn finish_process(&mut self) {}

    fn process(&mut self, info: &ProcessInfo) {
        let sample_rate = self.sample_rate();
        for block in info.blocks {
            self.introduce_block(block); // may fill event_input for this block (note source / update clock)
            let mut chunk = *block;
            let count = self.event_input().get(block.index).len();
            for index in 0..count {
                let event = self.event_input().get(block.index)[index]; // Copy; borrow ends immediately
                let pulses = event.position() - block.p0;
                let raw = if pulses.abs() < 1.0e-7 {
                    block.s0
                } else {
                    block.s0 + pulses_to_samples(pulses, block.bpm, sample_rate) as usize
                };
                debug_assert!(raw >= block.s0 && raw <= block.s1, "event out of block bounds");
                let to_index = raw.clamp(block.s0, block.s1);
                if chunk.s0 < to_index {
                    chunk.s1 = to_index;
                    chunk.p1 = event.position();
                    self.process_audio(&chunk);
                    chunk.s0 = to_index;
                    chunk.p0 = event.position();
                    chunk.flags.clear_event_flags();
                }
                match event {
                    Event::Update {position} => {
                        let block_time = block.s0 as f64 / sample_rate as f64
                            + pulses_to_seconds(position - block.p0, block.bpm);
                        self.update_parameters(position, block_time);
                    }
                    _ => self.handle_event(&event)
                }
            }
            if chunk.s0 < block.s1 {
                chunk.s1 = block.s1;
                chunk.p1 = block.p1;
                self.process_audio(&chunk);
            }
        }
        self.event_input().clear();
        self.finish_process();
    }
}

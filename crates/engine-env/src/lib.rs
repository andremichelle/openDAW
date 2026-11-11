//! engine-env: the engine's shared standard library, the vocabulary the engine and every device speak.
//! Ported faithfully in structure from the TS engine (`lib/dsp`, `core-processors`). Everything reused
//! by both the host engine and device plugins lives here (see `plans/wasm-audio/processor-port-map.md`),
//! one declaration per module. Pure (`no_std` + alloc), native-tested.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

/// Samples per render quantum (lib-dsp `RenderQuantum`). The fixed audio block size.
pub const RENDER_QUANTUM: usize = 128;

pub mod audio_buffer;
pub mod audio_bus_processor;
pub mod aux_send;
pub mod audio_sink;
pub mod channel_strip;
pub mod clip_sequencer;
pub mod composite_mix;
pub mod compensation;
pub mod telemetry;
pub mod ramp;
pub mod audio_generator;
pub mod audio_input;
pub mod audio_output_buffer_registry;
pub mod audio_processor;
// The block type and its flags are part of the device ABI (host and devices share them), so they live in
// `abi`; re-export under the original paths so host code keeps using `block::Block` / `block_flags::BlockFlags`.
pub mod block {
    pub use abi::Block;

    /// The frame of `position` in the quantum: the block's bounds map to its own frames, an inner position is
    /// counted from the block's anchor (converting a bound back would floor one frame short).
    pub fn frame_of(block: &Block, position: f64, sample_rate: f32) -> usize {
        if position <= block.p0 {return block.s0 as usize}
        if position >= block.p1 {return block.s1 as usize}
        dsp::ppqn::frame_at(position, block.anchor, block.anchor_frame, block.bpm, sample_rate)
            .clamp(block.s0 as i64, block.s1 as i64) as usize
    }
}
pub mod block_flags {
    pub use abi::BlockFlags;
}
pub mod engine_context;
pub mod event;
pub mod event_buffer;
pub mod event_receiver;
pub mod frequency_split;
pub mod graph;
pub mod linkwitz_riley;
pub mod meter;
pub mod scope;
pub mod note_event_instrument;
pub mod note_event_source;
pub mod note_region;
pub mod note_content_source;
pub mod note_sequencer;
pub mod ppqn;
pub mod process_info;
pub mod process_phase;
pub mod processor;
pub mod topological_sort;
pub mod update_clock;

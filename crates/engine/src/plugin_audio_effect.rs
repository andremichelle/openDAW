//! The `PluginAudioEffect` graph node: runs an audio-effect device after an upstream node (Route B).
//!
//! It owns the device-facing memory (descriptor, input/output offsets, state block, block array, all
//! talc-allocated so they free with the node). Per quantum it fills the block array (so the effect can
//! sync to tempo), calls the device's `process` wasm-to-wasm (zero copy) to transform its single input
//! buffer into the engine-allocated mono output, and fans that to its stereo output for the next node or
//! the bus. The host owns ordering: a `register_edge(upstream, this)` keeps the input fresh. It pulls no
//! events, so it never touches `PULL`.

use alloc::boxed::Box;
use alloc::vec;
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use transport::transport::RENDER_QUANTUM;
use crate::{call_device_process, DeviceReg};

/// A graph node that runs an audio-EFFECT device after an upstream node (Route B). It reads its single
/// input buffer (the upstream's mono output, taken from its `left` channel) through the device, into the
/// engine-allocated mono output, then fans that to its stereo output for the next node / the bus. The host
/// owns ordering: a `register_edge(upstream, this)` guarantees the input buffer is fresh when this runs.
/// Pulls no events (a no-param effect), so it never touches `PULL`. All device memory is talc-allocated.
pub(crate) struct PluginAudioEffect {
    process_index: u32,
    events: EventBuffer, // unused (a no-param effect receives no events) but required by `Processor: EventReceiver`
    output: SharedAudioBuffer,
    // The upstream output buffer, kept alive; its `left` address is captured into `in_offsets[0]`. The
    // `Rc<RefCell<AudioBuffer>>` never moves, so the captured pointer stays valid.
    #[allow(dead_code)]
    input: Option<SharedAudioBuffer>,
    device_output: Box<[f32]>,
    in_offsets: Box<[u32]>,
    #[allow(dead_code)]
    out_offsets: Box<[u32]>,
    #[allow(dead_code)]
    device_state: Box<[u32]>,
    descriptor: Box<[u32]>
}

impl PluginAudioEffect {
    pub(crate) fn new(sample_rate: f32, device: DeviceReg) -> Self {
        let device_output = vec![0.0f32; RENDER_QUANTUM].into_boxed_slice();
        let state_size = device.state_size as usize;
        let device_state = vec![0u32; state_size.div_ceil(4)].into_boxed_slice();
        let in_offsets = vec![0u32].into_boxed_slice(); // input buffer ptr, set by set_audio_source
        let out_offsets = vec![device_output.as_ptr() as u32].into_boxed_slice();
        // descriptor (see `abi`): frames, in_count/ptr (1), out_count/ptr (1), no params, state, no event
        // scratch, no out events, block_count/ptr (set per quantum from the ProcessInfo, so the effect gets
        // transport for tempo sync), sample_rate.
        let descriptor = vec![
            RENDER_QUANTUM as u32,
            1, in_offsets.as_ptr() as u32,
            1, out_offsets.as_ptr() as u32,
            0, 0,
            device_state.as_ptr() as u32,
            0, 0,
            0, 0,
            0, 0,
            sample_rate.to_bits()
        ].into_boxed_slice();
        Self {
            process_index: device.process_index,
            events: EventBuffer::new(),
            output: shared_audio_buffer(),
            input: None,
            device_output,
            in_offsets,
            out_offsets,
            device_state,
            descriptor
        }
    }
}

impl EventReceiver for PluginAudioEffect {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for PluginAudioEffect {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.in_offsets[0] = source.borrow().left.as_ptr() as u32;
        self.input = Some(source);
    }
}

impl AudioGenerator for PluginAudioEffect {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for PluginAudioEffect {
    fn reset(&mut self) {}

    fn process(&mut self, info: &ProcessInfo) {
        // Point the descriptor straight at the engine's per-quantum block array (shared wire type, in
        // shared memory) so the effect can sync to tempo — no per-node copy. Refresh the pointer each
        // quantum (the blocks Vec may move).
        self.descriptor[0] = RENDER_QUANTUM as u32;
        self.descriptor[12] = info.blocks.len() as u32;
        self.descriptor[13] = info.blocks.as_ptr() as u32;
        call_device_process(self.process_index, self.descriptor.as_ptr() as u32);
        let mut output = self.output.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            let sample = self.device_output[index];
            output.left[index] = sample;
            output.right[index] = sample;
        }
    }
}

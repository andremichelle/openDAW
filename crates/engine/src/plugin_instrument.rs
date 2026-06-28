//! The `PluginInstrument` graph node: voices an audio unit's notes through a loaded instrument device.
//!
//! It owns the device-facing memory (descriptor, IO buffers, event scratch, block array, state block, all
//! talc-allocated so they free with the node) and drives the device once per quantum: it fills the block
//! array, hands the device its pull context via the shared `PULL` cell, calls `process` wasm-to-wasm (zero
//! copy), and copies the device's stereo output (both channels) into its output buffer for the bus. The
//! device PULLS its own events (notes + param updates) through `host_pull_events`, so this node pushes no event list.

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;
use abi::EventRecord;
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use transport::transport::RENDER_QUANTUM;
use crate::param_automation::{ParamHandle, ParamSink};
use crate::{call_device_process, call_device_reset, DeviceReg, PullLink, DEVICE_MAX_EVENTS, PULL};

/// A graph node that voices its notes through a loaded instrument device (e.g. `device_sine.wasm`). It
/// pulls notes from its `PullLink` chain (resolved by the device via `host_pull_events`), fills the
/// engine-allocated (shared-memory) descriptor + block array, and calls the device's `process`
/// wasm-to-wasm (zero copy). The device renders into the engine-allocated stereo output buffers, which this
/// node copies to its output for the master bus. All device-facing memory (state, IO, descriptor)
/// is talc-allocated here, so it is freed when the instrument is dropped.
pub(crate) struct PluginInstrument {
    process_index: u32, // the device's `process` slot in the shared function table
    reset_index: u32,   // the device's `reset` slot (clears voices on STOP); 0 if none
    sample_rate: f32,
    pull_chain: Option<PullLink>, // the top of this unit's event pull chain (sequencer, or a midi-fx over it)
    // This device's bound parameters, swapped into `PULL` for the device call so `host_update_parameters`
    // resolves + diffs them; `clock_armed` is true iff one is automated (so the clock injects update ticks).
    params: Vec<ParamHandle>,
    clock_armed: bool,
    events: EventBuffer,
    output: SharedAudioBuffer,
    device_output: [Box<[f32]>; 2], // the device's stereo output buffers ([left, right])
    // `device_events` (the event scratch the device pulls into), `device_state`, and `out_offsets` are
    // referenced only by raw address inside `descriptor`; they must stay alive (dropping them frees the
    // memory the device reads/writes), so keep the fields even though Rust sees no direct reads. The block
    // array is NOT held here: the descriptor points straight at the engine's per-quantum `ProcessInfo`
    // blocks (the shared wire type), set in `process`.
    #[allow(dead_code)]
    device_events: Box<[EventRecord]>,
    #[allow(dead_code)]
    device_state: Box<[u32]>, // u32 so the block is 4-aligned for the device's SynthState
    #[allow(dead_code)]
    out_offsets: Box<[u32]>,
    descriptor: Box<[u32]>
}

impl PluginInstrument {
    pub(crate) fn new(sample_rate: f32, device: DeviceReg) -> Self {
        crate::note_device_build();
        let device_output = [
            vec![0.0f32; RENDER_QUANTUM].into_boxed_slice(),
            vec![0.0f32; RENDER_QUANTUM].into_boxed_slice()
        ];
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0};
        let device_events = vec![blank; DEVICE_MAX_EVENTS].into_boxed_slice();
        let state_size = device.state_size as usize;
        let device_state = vec![0u32; state_size.div_ceil(4)].into_boxed_slice(); // 4-aligned, >= state_size bytes
        // Two output offsets (L, R) -> the two device output buffers; the engine is stereo.
        let out_offsets = vec![device_output[0].as_ptr() as u32, device_output[1].as_ptr() as u32].into_boxed_slice();
        // descriptor words (see the `abi` layout): frames, in_count/ptr, out_count/ptr (2, stereo),
        // param_count/ptr, state_ptr, in_event_cap/ptr (pull scratch), out_event_cap/ptr (0, instrument has no
        // event out), block_count/ptr (set per quantum from the ProcessInfo), sample_rate (f32 bits).
        let descriptor = vec![
            RENDER_QUANTUM as u32,
            0, 0,
            2, out_offsets.as_ptr() as u32,
            0, 0,
            device_state.as_ptr() as u32,
            DEVICE_MAX_EVENTS as u32, device_events.as_ptr() as u32,
            0, 0,
            0, 0,
            sample_rate.to_bits()
        ].into_boxed_slice();
        Self {
            process_index: device.process_index,
            reset_index: device.reset_index,
            sample_rate,
            pull_chain: None,
            params: Vec::new(),
            clock_armed: false,
            events: EventBuffer::new(),
            output: shared_audio_buffer(),
            device_output,
            device_events,
            device_state,
            out_offsets,
            descriptor
        }
    }

    pub(crate) fn set_pull_chain(&mut self, chain: PullLink) {
        self.pull_chain = Some(chain);
    }
}

impl ParamSink for PluginInstrument {
    fn set_params(&mut self, params: Vec<ParamHandle>, clock_armed: bool) {
        self.params = params;
        self.clock_armed = clock_armed;
    }

    fn state_ptr(&self) -> u32 {
        self.device_state.as_ptr() as u32
    }
}

impl EventReceiver for PluginInstrument {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioGenerator for PluginInstrument {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for PluginInstrument {
    fn reset(&mut self) {
        // Transport STOP: drop every active voice (the device clears its voice pool / envelopes), and clear the
        // buffered events.
        call_device_reset(self.reset_index, self.device_state.as_ptr() as u32);
        self.events.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        // Point the descriptor straight at the engine's per-quantum block array (the shared wire type, in
        // shared memory) — no per-node copy. The blocks Vec may move between quanta, so refresh the pointer.
        self.descriptor[0] = RENDER_QUANTUM as u32;
        self.descriptor[12] = info.blocks.len() as u32;
        self.descriptor[13] = info.blocks.as_ptr() as u32;
        // Hand the device its pull context, then call it. The device PULLS its events via host_pull_events.
        // Scope the `PULL.get()` borrow so none is live across `call_device_process` (the device's
        // host_pull_events takes its own `PULL.get()`); single-threaded, so the two never overlap.
        {
            let pull = unsafe { PULL.get() };
            pull.current = self.pull_chain.clone();
            pull.blocks = info.blocks.as_ptr();
            pull.block_count = info.blocks.len();
            pull.sample_rate = self.sample_rate;
            pull.clock_armed = self.clock_armed;
            core::mem::swap(&mut self.params, &mut pull.params); // move our params in (no alloc)
        }
        call_device_process(self.process_index, self.descriptor.as_ptr() as u32);
        {
            let pull = unsafe { PULL.get() };
            pull.current = None;
            pull.blocks = core::ptr::null();
            pull.block_count = 0;
            pull.clock_armed = false;
            core::mem::swap(&mut self.params, &mut pull.params); // and take them back
        }
        let mut output = self.output.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            output.left[index] = self.device_output[0][index];
            output.right[index] = self.device_output[1][index];
        }
    }
}

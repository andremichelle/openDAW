//! The `PluginAudioEffect` graph node: runs an audio-effect device after an upstream node (Route B).
//!
//! It owns the device-facing memory (descriptor, input/output offsets, state block, block array, all
//! talc-allocated so they free with the node). Per quantum it fills the block array (so the effect can
//! sync to tempo), calls the device's `process` wasm-to-wasm (zero copy) to transform its stereo input
//! buffers into the engine-allocated stereo output, and copies that to its output for the next node or
//! the bus. The host owns ordering: a `register_edge(upstream, this)` keeps the input fresh. When the
//! effect has an automated parameter it pulls the global update clock (Route D) through `PULL`, so its DSP
//! splits each block at the clock and refreshes parameters; with no automation it pulls nothing.

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use transport::transport::RENDER_QUANTUM;
use crate::param_automation::{ParamHandle, ParamSink};
use crate::{call_device_process, call_device_reset, DeviceReg, INPUTS, PULL};

/// A graph node that runs an audio-EFFECT device after an upstream node (Route B). It reads the upstream's
/// stereo output (both channels) through the device, into the engine-allocated stereo output, then copies
/// that to its output for the next node / the bus. The host owns ordering: a `register_edge(upstream, this)`
/// guarantees the input buffer is fresh when this runs.
/// Pulls the global update clock through `PULL` when it has automation. All device memory is talc-allocated.
pub(crate) struct PluginAudioEffect {
    process_index: u32,
    reset_index: u32,
    sample_rate: f32,
    meter: engine_env::meter::Meter, // peaks/RMS of the device output (a broadcast slot)
    events: EventBuffer, // unused here (the device PULLS its events) but required by `Processor: EventReceiver`
    // This effect's bound parameters, swapped into `PULL` for the device call so `host_update_parameters`
    // resolves + diffs them; `clock_armed` is true iff one is automated. When armed, the device's per-block
    // pull carries the global update clock, which the SDK turns into `parameter_changed` applies.
    params: Vec<ParamHandle>,
    clock_armed: bool,
    output: SharedAudioBuffer,
    // The upstream output buffer, kept alive; its `left` address is captured into `in_offsets[0]`. The
    // `Rc<RefCell<AudioBuffer>>` never moves, so the captured pointer stays valid.
    #[allow(dead_code)]
    input: Option<SharedAudioBuffer>,
    // The device's audio input PORTS (id, left_ptr, right_ptr): port 1 the through-signal (set by
    // `set_audio_source`), ports 2+ the resolved sidechains (set by `set_sidechain`). Swapped into `INPUTS`
    // per `process` so `host_resolve_input` finds them. The sidechain source buffers are kept alive so their
    // captured pointers stay valid.
    input_ports: Vec<(u32, u32, u32)>,
    #[allow(dead_code)]
    sidechain_buffers: Vec<SharedAudioBuffer>,
    device_output: [Box<[f32]>; 2], // the device's stereo output buffers ([left, right])
    in_offsets: Box<[u32]>,
    #[allow(dead_code)]
    out_offsets: Box<[u32]>,
    #[allow(dead_code)]
    device_state: Box<[u64]>,
    descriptor: Box<[u32]>
}

impl PluginAudioEffect {
    pub(crate) fn new(sample_rate: f32, device: DeviceReg) -> Self {
        crate::note_device_build();
        let device_output = [
            vec![0.0f32; RENDER_QUANTUM].into_boxed_slice(),
            vec![0.0f32; RENDER_QUANTUM].into_boxed_slice()
        ];
        let state_size = device.state_size as usize;
        // u64-backed so the block is 8-aligned for any device state struct (e.g. a biquad's f64 fields); a
        // 4-aligned block would be misaligned for those.
        let device_state = vec![0u64; state_size.div_ceil(8)].into_boxed_slice();
        let in_offsets = vec![0u32, 0u32].into_boxed_slice(); // L, R input ptrs, set by set_audio_source
        let out_offsets = vec![device_output[0].as_ptr() as u32, device_output[1].as_ptr() as u32].into_boxed_slice();
        // descriptor (see `abi`): frames, in_count/ptr (2, stereo), out_count/ptr (2, stereo), no params, state,
        // NO event scratch (the effect no longer pulls notes; it fragments at the engine's update positions),
        // no out events, block_count/ptr (set per quantum from the ProcessInfo for tempo sync), sample_rate.
        let descriptor = vec![
            RENDER_QUANTUM as u32,
            2, in_offsets.as_ptr() as u32,
            2, out_offsets.as_ptr() as u32,
            0, 0,
            device_state.as_ptr() as u32,
            0, 0,
            0, 0,
            0, 0,
            sample_rate.to_bits()
        ].into_boxed_slice();
        Self {
            process_index: device.process_index,
            reset_index: device.reset_index,
            sample_rate,
            meter: engine_env::meter::Meter::new(sample_rate),
            events: EventBuffer::new(),
            params: Vec::new(),
            clock_armed: false,
            output: shared_audio_buffer(),
            input: None,
            input_ports: vec![(abi::MAIN_INPUT, 0, 0)], // port 1 = the through-signal, ptrs set by set_audio_source
            sidechain_buffers: Vec::new(),
            device_output,
            in_offsets,
            out_offsets,
            device_state,
            descriptor
        }
    }

    /// The peak/RMS broadcast slot of this effect's output.
    pub(crate) fn meter_slot(&self) -> engine_env::meter::MeterSlot {
        self.meter.slot()
    }
}

impl ParamSink for PluginAudioEffect {
    fn set_params(&mut self, params: Vec<ParamHandle>, clock_armed: bool) {
        self.params = params;
        self.clock_armed = clock_armed;
    }

    fn state_ptr(&self) -> u32 {
        self.device_state.as_ptr() as u32
    }
}

impl EventReceiver for PluginAudioEffect {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioInput for PluginAudioEffect {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        let buffer = source.borrow();
        let (left, right) = (buffer.left.as_ptr() as u32, buffer.right.as_ptr() as u32);
        self.in_offsets[0] = left;
        self.in_offsets[1] = right;
        self.input_ports[0] = (abi::MAIN_INPUT, left, right); // port 1, the through-signal resolve_input(1) returns
        drop(buffer);
        self.input = Some(source);
    }
}

impl PluginAudioEffect {
    /// REPLACE this effect's resolved sidechains with `sources` (each `(port_id, buffer)`, the id
    /// `bind_sidechain` returned, 2+). Rebuilds from scratch: keeps the MAIN through-signal at index 0 and
    /// drops every previous sidechain, so a re-point / detach leaves no stale port — an unbound port simply
    /// vanishes, and `host_resolve_input(port_id)` returns 0 (the device falls back to MAIN). Source buffers
    /// are kept alive so their captured pointers stay valid. Called by the engine's sidechain-resolution pass.
    pub(crate) fn set_sidechains(&mut self, sources: &[(u32, SharedAudioBuffer)]) {
        self.input_ports.truncate(1); // index 0 is MAIN (set by set_audio_source); drop the previous sidechains
        self.sidechain_buffers.clear();
        for (port_id, source) in sources {
            let buffer = source.borrow();
            let (left, right) = (buffer.left.as_ptr() as u32, buffer.right.as_ptr() as u32);
            drop(buffer);
            self.input_ports.push((*port_id, left, right));
            self.sidechain_buffers.push(source.clone());
        }
    }
}

impl AudioGenerator for PluginAudioEffect {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for PluginAudioEffect {
    fn reset(&mut self) {
        // Transport STOP: clear the device's runtime state (delay lines, filter history, detector / envelope),
        // keeping its bindings. Also drop the buffered input residual.
        call_device_reset(self.reset_index, self.device_state.as_ptr() as u32);
    }

    fn process(&mut self, info: &ProcessInfo) {
        // Point the descriptor straight at the engine's per-quantum block array (shared wire type, in
        // shared memory) so the effect can sync to tempo — no per-node copy. Refresh the pointer each
        // quantum (the blocks Vec may move).
        self.descriptor[0] = RENDER_QUANTUM as u32;
        self.descriptor[12] = info.blocks.len() as u32;
        self.descriptor[13] = info.blocks.as_ptr() as u32;
        // Hand the device its pull context: no note source (an effect has none), but the blocks and — when
        // it has automation — the armed global clock + this device's params, so its per-block pull returns
        // the update events that drive `parameter_changed`. Scope the borrows so none is held across the call.
        {
            let pull = unsafe { PULL.get() };
            pull.current = None;
            pull.blocks = info.blocks.as_ptr();
            pull.block_count = info.blocks.len();
            pull.sample_rate = self.sample_rate;
            pull.clock_armed = self.clock_armed;
            core::mem::swap(&mut self.params, &mut pull.params);
            // Swap in this effect's input ports so `host_resolve_input` resolves port 1 (the through-signal)
            // and any sidechains for THIS device's call.
            core::mem::swap(&mut self.input_ports, unsafe { INPUTS.get() });
        }
        call_device_process(self.process_index, self.descriptor.as_ptr() as u32);
        {
            let pull = unsafe { PULL.get() };
            pull.blocks = core::ptr::null();
            pull.block_count = 0;
            pull.clock_armed = false;
            core::mem::swap(&mut self.params, &mut pull.params);
            core::mem::swap(&mut self.input_ports, unsafe { INPUTS.get() });
        }
        {
            let mut output = self.output.borrow_mut();
            for index in 0..RENDER_QUANTUM {
                output.left[index] = self.device_output[0][index];
                output.right[index] = self.device_output[1][index];
            }
        }
        self.meter.process(&self.device_output[0], &self.device_output[1]);
    }
}

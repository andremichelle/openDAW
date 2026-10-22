//! Plugin delay compensation (plans/delay-compensation.md): the signal graph snapshot and its limits.

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use crate::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use crate::engine_context::NodeId;

/// The longest delay a compensation stage applies. A path that needs more stays unaligned and is reported.
pub const MAX_COMPENSATION_SECONDS: f32 = 0.1;

pub fn max_compensation_frames(sample_rate: f32) -> u32 {
    -math::floor(-(MAX_COMPENSATION_SECONDS * sample_rate) as f64) as u32
}

/// Crossfade length when a compensation delay changes, so a latency change does not click.
pub const COMPENSATION_CROSSFADE_SECONDS: f32 = 0.01;

/// The longest delay a junction may apply and the crossfade length of a change, both in frames.
#[derive(Clone, Copy)]
pub struct CompensationLimits {
    pub max_frames: u32,
    pub fade_frames: u32
}

/// A stereo delay that aligns one junction input. Sized and resized outside render, `process` never allocates.
pub struct CompensationDelay {
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    from: u32,
    to: u32,
    fade_position: u32,
    fade_length: u32
}

impl CompensationDelay {
    pub fn new() -> Self {
        Self {left: Vec::new(), right: Vec::new(), write: 0, from: 0, to: 0, fade_position: 0, fade_length: 0}
    }

    pub fn delay(&self) -> u32 {
        self.to
    }

    pub fn set_delay(&mut self, frames: u32, limits: CompensationLimits) {
        let frames = frames.min(limits.max_frames);
        if frames == self.to {
            return;
        }
        self.grow(limits.max_frames as usize + 1);
        self.from = self.to;
        self.to = frames;
        self.fade_position = 0;
        self.fade_length = limits.fade_frames.max(1);
    }

    fn grow(&mut self, capacity: usize) {
        let old = self.left.len();
        if capacity <= old {
            return;
        }
        let mut left = vec![0.0; capacity];
        let mut right = vec![0.0; capacity];
        for index in 0..old {
            left[capacity - old + index] = self.left[(self.write + index) % old];
            right[capacity - old + index] = self.right[(self.write + index) % old];
        }
        self.left = left;
        self.right = right;
        self.write = 0;
    }

    pub fn process(&mut self, input: &AudioBuffer, output: &mut AudioBuffer, from: usize, to: usize) {
        let capacity = self.left.len();
        if capacity == 0 {
            output.left[from..to].copy_from_slice(&input.left[from..to]);
            output.right[from..to].copy_from_slice(&input.right[from..to]);
            return;
        }
        for index in from..to {
            let write = self.write;
            self.left[write] = input.left[index];
            self.right[write] = input.right[index];
            let read = |delay: u32| (write + capacity - delay as usize) % capacity;
            if self.fade_position < self.fade_length {
                let mix = self.fade_position as f32 / self.fade_length as f32;
                let (old, new) = (read(self.from), read(self.to));
                output.left[index] = self.left[old] * (1.0 - mix) + self.left[new] * mix;
                output.right[index] = self.right[old] * (1.0 - mix) + self.right[new] * mix;
                self.fade_position += 1;
            } else {
                let position = read(self.to);
                output.left[index] = self.left[position];
                output.right[index] = self.right[position];
            }
            self.write = (write + 1) % capacity;
        }
    }

    pub fn clear(&mut self) {
        self.left.fill(0.0);
        self.right.fill(0.0);
        self.fade_position = self.fade_length;
    }
}

/// A delayed copy of one input in a stable buffer, so a device can read it through a fixed pointer.
pub struct CompensatedInput {
    delay: CompensationDelay,
    output: SharedAudioBuffer
}

impl CompensatedInput {
    pub fn new() -> Self {
        Self {delay: CompensationDelay::new(), output: shared_audio_buffer()}
    }

    pub fn output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }

    pub fn set_delay(&mut self, frames: u32, limits: CompensationLimits) {
        self.delay.set_delay(frames, limits);
    }

    pub fn process(&mut self, source: &SharedAudioBuffer) {
        self.delay.process(&source.borrow(), &mut self.output.borrow_mut(), 0, crate::RENDER_QUANTUM);
    }

    pub fn clear(&mut self) {
        self.delay.clear();
    }
}

impl Default for CompensatedInput {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for CompensationDelay {
    fn default() -> Self {
        Self::new()
    }
}

/// One processor in the signal graph: its own reported latency and the latency its output arrives at.
pub struct SignalNode {
    pub id: NodeId,
    pub label: String,
    pub owner: Option<[u8; 16]>,
    pub latency: u32,
    pub arrival: u32
}

/// `data` false = the edge only orders the render (a sidechain), `delay` = compensation on this edge.
pub struct SignalEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub data: bool,
    pub delay: u32
}

pub struct SignalGraph {
    pub nodes: Vec<SignalNode>,
    pub edges: Vec<SignalEdge>
}

#[cfg(test)]
mod tests {
    use alloc::rc::Rc;
    use core::cell::RefCell;
    use crate::engine_context::EngineContext;
    use crate::event_buffer::EventBuffer;
    use crate::event_receiver::EventReceiver;
    use crate::process_info::ProcessInfo;
    use crate::processor::Processor;
    use super::*;

    struct Latent {
        latency: u32,
        aligns: bool,
        events: EventBuffer
    }

    impl EventReceiver for Latent {
        fn event_input(&mut self) -> &mut EventBuffer {
            &mut self.events
        }
    }

    impl Processor for Latent {
        fn reset(&mut self) {}
        fn process(&mut self, _info: &ProcessInfo) {}
        fn latency(&self) -> u32 {
            self.latency
        }
        fn aligns_inputs(&self) -> bool {
            self.aligns
        }
    }

    fn add(context: &mut EngineContext, latency: u32) -> NodeId {
        context.register_processor(Rc::new(RefCell::new(Latent {latency, aligns: false, events: EventBuffer::new()})))
    }

    fn add_aligning(context: &mut EngineContext, latency: u32) -> NodeId {
        context.register_processor(Rc::new(RefCell::new(Latent {latency, aligns: true, events: EventBuffer::new()})))
    }

    #[test]
    fn arrival_is_the_longest_data_path_and_ignores_order_edges() {
        let mut context = EngineContext::new();
        let source = add(&mut context, 0);
        let latent = add(&mut context, 240);
        let dry = add(&mut context, 0);
        let sum = add(&mut context, 0);
        let sidechained = add(&mut context, 0);
        context.register_edge(source, latent);
        context.register_edge(latent, sum);
        context.register_edge(dry, sum);
        context.register_order_edge(latent, sidechained);
        context.set_owner(latent, [7; 16]);
        let graph = context.signal_graph();
        let node = |id: NodeId| graph.nodes.iter().find(|node| node.id == id).unwrap();
        assert_eq!(node(latent).latency, 240);
        assert_eq!(node(latent).arrival, 240);
        assert_eq!(node(sum).arrival, 240);
        assert_eq!(node(dry).arrival, 0);
        assert_eq!(node(sidechained).arrival, 0);
        assert_eq!(node(latent).owner, Some([7; 16]));
        let edge = |source: NodeId, target: NodeId| graph.edges.iter().find(|edge| edge.source == source && edge.target == target).unwrap();
        assert!(edge(latent, sum).data);
        assert!(!edge(latent, sidechained).data);
        assert_eq!(graph.edges.len(), 4);
    }

    #[test]
    fn removing_an_order_edge_forgets_its_kind() {
        let mut context = EngineContext::new();
        let source = add(&mut context, 0);
        let target = add(&mut context, 0);
        context.register_order_edge(source, target);
        context.remove_edge(source, target);
        context.register_edge(source, target);
        assert!(context.signal_graph().edges[0].data);
    }

    fn impulse_buffer(at: usize) -> AudioBuffer {
        let mut buffer = AudioBuffer::new();
        buffer.left[at] = 1.0;
        buffer.right[at] = -1.0;
        buffer
    }

    fn run(delay: &mut CompensationDelay, input: &AudioBuffer) -> AudioBuffer {
        let mut output = AudioBuffer::new();
        delay.process(input, &mut output, 0, crate::RENDER_QUANTUM);
        output
    }

    #[test]
    fn delays_by_exactly_the_requested_frames_across_quanta() {
        let mut delay = CompensationDelay::new();
        delay.set_delay(200, CompensationLimits {max_frames: 4800, fade_frames: 1});
        run(&mut delay, &AudioBuffer::new());
        let first = run(&mut delay, &impulse_buffer(10));
        assert!(first.left.iter().all(|sample| *sample == 0.0));
        let second = run(&mut delay, &AudioBuffer::new());
        assert_eq!(second.left.iter().position(|sample| *sample == 1.0), Some(128 + 10 + 200 - 256));
        assert_eq!(second.right[128 + 10 + 200 - 256], -1.0);
    }

    #[test]
    fn an_empty_delay_passes_through() {
        let mut delay = CompensationDelay::new();
        let output = run(&mut delay, &impulse_buffer(3));
        assert_eq!(output.left[3], 1.0);
    }

    #[test]
    fn a_longer_delay_reads_history_and_crossfades() {
        let mut delay = CompensationDelay::new();
        delay.set_delay(10, CompensationLimits {max_frames: 4800, fade_frames: 1});
        let ramp: AudioBuffer = {
            let mut buffer = AudioBuffer::new();
            for index in 0..crate::RENDER_QUANTUM {buffer.left[index] = index as f32;}
            buffer
        };
        run(&mut delay, &ramp);
        delay.set_delay(100, CompensationLimits {max_frames: 4800, fade_frames: 64});
        let output = run(&mut delay, &AudioBuffer::new());
        assert_eq!(output.left[0], (crate::RENDER_QUANTUM - 10) as f32);
        assert!(output.left[63] < output.left[0]);
        assert_eq!(output.left[64], (crate::RENDER_QUANTUM - 100 + 64) as f32);
    }

    #[test]
    fn compensate_delays_the_earlier_bus_input_and_reports_it() {
        use crate::audio_buffer::shared_audio_buffer;
        use crate::audio_bus_processor::AudioBusProcessor;
        let mut context = EngineContext::new();
        let dry = add(&mut context, 0);
        let latent = add(&mut context, 240);
        let bus = Rc::new(RefCell::new(AudioBusProcessor::new(shared_audio_buffer())));
        bus.borrow_mut().add_audio_source(shared_audio_buffer(), dry);
        bus.borrow_mut().add_audio_source(shared_audio_buffer(), latent);
        let sum = context.register_processor(bus.clone());
        context.register_edge(dry, sum);
        context.register_edge(latent, sum);
        assert!(context.compensation_dirty());
        context.compensate(CompensationLimits {max_frames: 4800, fade_frames: 480});
        assert!(!context.compensation_dirty());
        let graph = context.signal_graph();
        let edge = |source: NodeId| graph.edges.iter().find(|edge| edge.source == source && edge.target == sum).unwrap().delay;
        assert_eq!(edge(dry), 240);
        assert_eq!(edge(latent), 0);
        assert_eq!(graph.nodes.iter().find(|node| node.id == sum).unwrap().arrival, 240);
    }

    #[test]
    fn a_delay_beyond_the_cap_is_reported_unclamped() {
        use crate::audio_buffer::shared_audio_buffer;
        use crate::audio_bus_processor::AudioBusProcessor;
        let mut context = EngineContext::new();
        let dry = add(&mut context, 0);
        let latent = add(&mut context, 9000);
        let bus = Rc::new(RefCell::new(AudioBusProcessor::new(shared_audio_buffer())));
        bus.borrow_mut().add_audio_source(shared_audio_buffer(), dry);
        bus.borrow_mut().add_audio_source(shared_audio_buffer(), latent);
        let sum = context.register_processor(bus);
        context.register_edge(dry, sum);
        context.register_edge(latent, sum);
        context.compensate(CompensationLimits {max_frames: 4800, fade_frames: 480});
        let graph = context.signal_graph();
        assert_eq!(graph.edges.iter().find(|edge| edge.source == dry).unwrap().delay, 9000);
    }

    #[test]
    fn a_sidechain_from_downstream_does_not_recurse() {
        let mut context = EngineContext::new();
        let source = add(&mut context, 0);
        let effect = add_aligning(&mut context, 240);
        let strip = add(&mut context, 0);
        context.register_edge(source, effect);
        context.register_edge(effect, strip);
        context.register_order_edge(strip, effect);
        context.compensate(CompensationLimits {max_frames: 4800, fade_frames: 480});
        let graph = context.signal_graph();
        assert_eq!(graph.nodes.iter().find(|node| node.id == strip).unwrap().arrival, 240);
        assert!(graph.edges.iter().all(|edge| edge.delay == 0));
    }

    #[test]
    fn a_late_sidechain_delays_the_main_input() {
        let mut context = EngineContext::new();
        let main = add(&mut context, 0);
        let latent = add(&mut context, 240);
        let ducker = add_aligning(&mut context, 0);
        context.register_edge(main, ducker);
        context.register_order_edge(latent, ducker);
        context.compensate(CompensationLimits {max_frames: 4800, fade_frames: 480});
        let graph = context.signal_graph();
        assert_eq!(graph.nodes.iter().find(|node| node.id == ducker).unwrap().arrival, 240);
        assert_eq!(graph.edges.iter().find(|edge| edge.source == main).unwrap().delay, 240);
        assert_eq!(graph.edges.iter().find(|edge| edge.source == latent).unwrap().delay, 0);
    }

    #[test]
    fn max_compensation_frames_rounds_up() {
        assert_eq!(max_compensation_frames(48_000.0), 4800);
        assert_eq!(max_compensation_frames(44_100.0), 4410);
    }
}

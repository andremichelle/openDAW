//! EngineContext: registered processors render in dependency order (regardless of registration order),
//! ProcessPhase observers fire Before then After around the render, and the output-buffer registry is
//! reachable through the handle.

use std::cell::RefCell;
use std::rc::Rc;

use boxgraph::address::Address;
use engine_env::audio_buffer::shared_audio_buffer;
use engine_env::engine_context::EngineContext;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::process_phase::ProcessPhase;
use engine_env::processor::Processor;

struct Probe {
    tag: u32,
    log: Rc<RefCell<Vec<u32>>>,
    events: EventBuffer
}

impl EventReceiver for Probe {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl Processor for Probe {
    fn reset(&mut self) {}
    fn process(&mut self, _info: &ProcessInfo) {
        self.log.borrow_mut().push(self.tag);
    }
}

fn probe(tag: u32, log: &Rc<RefCell<Vec<u32>>>) -> Rc<RefCell<Probe>> {
    Rc::new(RefCell::new(Probe {tag, log: log.clone(), events: EventBuffer::new()}))
}

#[test]
fn processes_nodes_in_dependency_order() {
    let log = Rc::new(RefCell::new(Vec::new()));
    let mut context = EngineContext::new();
    // register the consumer first, the source second; the edge (source -> consumer) must still win.
    let consumer = context.register_processor(probe(2, &log));
    let source = context.register_processor(probe(1, &log));
    context.register_edge(source, consumer);
    context.process(&ProcessInfo {blocks: &[]});
    assert_eq!(*log.borrow(), vec![1, 2], "the source ran before the consumer");
}

#[test]
fn process_phase_observers_fire_before_then_after() {
    let phases = Rc::new(RefCell::new(Vec::new()));
    let mut context = EngineContext::new();
    let captured = phases.clone();
    context.subscribe_process_phase(Box::new(move |phase| captured.borrow_mut().push(phase)));
    context.process(&ProcessInfo {blocks: &[]});
    assert_eq!(*phases.borrow(), vec![ProcessPhase::Before, ProcessPhase::After]);
}

#[test]
fn the_output_buffer_registry_is_reachable_through_the_handle() {
    let mut context = EngineContext::new();
    let buffer = shared_audio_buffer();
    let address = Address::box_of([7; 16]);
    context.registry_mut().register(address.clone(), buffer.clone(), 0);
    buffer.borrow_mut().left[0] = 0.9;
    let entry = context.registry().resolve(&address).expect("registered");
    assert_eq!(entry.buffer.borrow().left[0], 0.9);
}

struct Flagged {
    in_loop: Rc<RefCell<bool>>,
    events: EventBuffer
}

impl EventReceiver for Flagged {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl Processor for Flagged {
    fn reset(&mut self) {}
    fn process(&mut self, _info: &ProcessInfo) {}
    fn set_feedback(&mut self, in_loop: bool) {
        *self.in_loop.borrow_mut() = in_loop;
    }
}

fn flagged(context: &mut EngineContext) -> (u64, Rc<RefCell<bool>>) {
    let in_loop = Rc::new(RefCell::new(false));
    let id = context.register_processor(Rc::new(RefCell::new(Flagged {in_loop: in_loop.clone(), events: EventBuffer::new()})));
    (id, in_loop)
}

#[test]
fn a_sidechain_from_downstream_names_exactly_the_nodes_on_its_loop() {
    // feeder -> vocoder -> revamp -> strip, and the vocoder listens to the revamp
    let mut context = EngineContext::new();
    let (feeder, _) = flagged(&mut context);
    let (vocoder, vocoder_flag) = flagged(&mut context);
    let (revamp, revamp_flag) = flagged(&mut context);
    let (strip, strip_flag) = flagged(&mut context);
    let (other, _) = flagged(&mut context);
    context.register_edge(feeder, vocoder);
    context.register_edge(vocoder, revamp);
    context.register_edge(revamp, strip);
    context.register_order_edge(revamp, vocoder);
    let nodes = context.feedback_nodes(revamp, vocoder);
    assert_eq!(nodes.into_iter().collect::<Vec<_>>(), vec![vocoder, revamp]);
    assert!(context.feedback_nodes(feeder, vocoder).is_empty(), "an upstream sidechain closes no loop");
    assert!(context.feedback_nodes(other, vocoder).is_empty(), "an unrelated sidechain closes no loop");
    assert_eq!(context.feedback_nodes(strip, feeder).len(), 4, "a feeder listening to the strip loops the whole chain");
    context.set_feedback(context.feedback_nodes(revamp, vocoder));
    assert!(*vocoder_flag.borrow() && *revamp_flag.borrow() && !*strip_flag.borrow());
    context.set_feedback(Default::default());
    assert!(!*vocoder_flag.borrow() && !*revamp_flag.borrow(), "an opened loop clears its flags");
}

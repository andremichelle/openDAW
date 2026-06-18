//! The new architecture, end to end and audible: a NoteSequencer (reading a looping note region) feeds
//! a SineDevice, whose output is summed by an AudioBusProcessor (the output unit). Driven through the
//! EngineContext over a real 128-sample block loop, the output node accumulates recurring audio, and the
//! looping region retriggers its note once per bar. This is the Rust proof that the ported graph plays.

use std::cell::RefCell;
use std::rc::Rc;

use device_sine::SineDevice;
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::audio_buffer::{shared_audio_buffer, AudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::engine_context::EngineContext;
use engine_env::note_region::NoteRegion;
use engine_env::note_region_source::NoteRegionSource;
use engine_env::note_sequencer::NoteSequencer;
use engine_env::ppqn::samples_to_pulses;
use engine_env::process_info::ProcessInfo;
use engine_env::RENDER_QUANTUM;
use value::event::EventCollection;
use value::note::NoteEvent;

const SR: f32 = 48_000.0;
const BPM: f32 = 120.0;
const BAR: f64 = 3840.0;

// A fixed note source: one looping region with a single note at the start of each loop cycle.
struct StaticRegion {
    region: NoteRegion,
    notes: EventCollection<NoteEvent>
}

impl NoteRegionSource for StaticRegion {
    fn for_each_region(&self, _from: f64, _to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        visit(&self.region, &self.notes);
    }
}

fn energy(buffer: &AudioBuffer) -> f32 {
    buffer.left.iter().map(|sample| sample * sample).sum()
}

#[test]
fn sequencer_into_sine_into_bus_is_audible() {
    // A 4-bar region looping a 1-bar phrase with one note (A4) at the bar start -> a hit every bar.
    let region = NoteRegion {position: 0.0, duration: 4.0 * BAR, loop_offset: 0.0, loop_duration: BAR};
    let mut notes = EventCollection::new();
    notes.add(NoteEvent::new(0.0, 480.0, 69, 0.0, 1.0));
    let sequencer = Rc::new(RefCell::new(NoteSequencer::new(Box::new(StaticRegion {region, notes}))));

    let device = Rc::new(RefCell::new(SineDevice::new(SR)));
    device.borrow_mut().set_note_event_source(sequencer.clone());

    let output_buffer = shared_audio_buffer();
    let bus = Rc::new(RefCell::new(AudioBusProcessor::new(output_buffer.clone())));
    bus.borrow_mut().add_audio_source(device.borrow().audio_output());

    let mut context = EngineContext::new();
    let device_id = context.register_processor(device.clone());
    let bus_id = context.register_processor(bus.clone());
    context.register_edge(device_id, bus_id); // instrument renders before the bus sums it

    let pulses_per_quantum = samples_to_pulses(RENDER_QUANTUM as f64, BPM, SR);
    let quanta = (2.0 * BAR / pulses_per_quantum) as usize; // two bars
    let flags = BlockFlags::create(true, false, true, false); // transporting + playing
    let mut position = 0.0;
    let mut total_energy = 0.0;
    for _ in 0..quanta {
        let block = Block {
            index: 0,
            p0: position,
            p1: position + pulses_per_quantum,
            s0: 0,
            s1: RENDER_QUANTUM,
            bpm: BPM,
            flags
        };
        context.process(&ProcessInfo {blocks: &[block]});
        total_energy += energy(&output_buffer.borrow());
        position = block.p1;
    }
    assert!(total_energy > 0.1, "the output unit carries audible energy, got {total_energy}");
}

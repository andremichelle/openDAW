//! The AudioProcessor block/event split template (ported from core-processors `AudioProcessor.process`):
//! audio renders up to each event boundary, the event is handled there, then audio continues; an event
//! exactly at the block start renders no leading chunk; update events go to `update_parameters` (not
//! `handle_event`); one-shot block flags clear after the first chunk; and `introduce_block` /
//! `finish_process` fire once per block / once overall.

use engine_env::audio_processor::AudioProcessor;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::event::Event;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::ppqn::pulses_to_samples;
use engine_env::process_info::ProcessInfo;

const SR: f32 = 48_000.0; // pulses_to_samples(p, 120, 48000) == floor(p * 25)
const BPM: f32 = 120.0;

// The sample boundary the template computes for an event at `position` in a block starting at pulse 0
// (same floor as TS `Math.floor(PPQN.pulsesToSamples(...))`).
fn split(position: f64) -> usize {
    pulses_to_samples(position, BPM, SR) as usize
}

#[derive(Debug, PartialEq)]
enum Step {
    Introduce(u32),
    Audio {s0: usize, s1: usize, discontinuous: bool},
    Note(u64),
    Update(f64),
    Finish
}

struct Recorder {
    events: EventBuffer,
    log: Vec<Step>
}

impl Recorder {
    fn new() -> Self {
        Self {events: EventBuffer::new(), log: Vec::new()}
    }
}

impl EventReceiver for Recorder {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioProcessor for Recorder {
    fn sample_rate(&self) -> f32 {
        SR
    }
    fn process_audio(&mut self, chunk: &Block) {
        self.log.push(Step::Audio {s0: chunk.s0 as usize, s1: chunk.s1 as usize, discontinuous: chunk.flags.discontinuous()});
    }
    fn handle_event(&mut self, event: &Event) {
        match event {
            Event::NoteStart {id, ..} | Event::NoteComplete {id, ..} => self.log.push(Step::Note(*id)),
            Event::Update {..} => unreachable!("updates go to update_parameters")
        }
    }
    fn introduce_block(&mut self, block: &Block) {
        self.log.push(Step::Introduce(block.index));
    }
    fn update_parameters(&mut self, position: f64, _block_time: f64) {
        self.log.push(Step::Update(position));
    }
    fn finish_process(&mut self) {
        self.log.push(Step::Finish);
    }
}

fn block(flags: BlockFlags) -> Block {
    Block {index: 0, p0: 0.0, p1: 5.12, s0: 0, s1: 128, bpm: BPM, flags}
}

fn note_start(id: u64, position: f64) -> Event {
    Event::NoteStart {id, position, duration: 240.0, pitch: 60, cent: 0.0, velocity: 0.8}
}

fn run(recorder: &mut Recorder, block: Block) {
    recorder.process(&ProcessInfo {blocks: &[block]});
}

#[test]
fn no_events_render_the_whole_block_once() {
    let mut recorder = Recorder::new();
    run(&mut recorder, block(BlockFlags::default()));
    assert_eq!(recorder.log, vec![
        Step::Introduce(0),
        Step::Audio {s0: 0, s1: 128, discontinuous: false},
        Step::Finish
    ]);
}

#[test]
fn an_event_splits_the_block_and_is_handled_at_its_boundary() {
    let mut recorder = Recorder::new();
    recorder.events.add(0, note_start(7, 2.56));
    run(&mut recorder, block(BlockFlags::default()));
    let boundary = split(2.56);
    assert_eq!(recorder.log, vec![
        Step::Introduce(0),
        Step::Audio {s0: 0, s1: boundary, discontinuous: false}, // before the note
        Step::Note(7),                                           // handled at the boundary
        Step::Audio {s0: boundary, s1: 128, discontinuous: false}, // after the note
        Step::Finish
    ]);
}

#[test]
fn an_event_at_the_block_start_renders_no_leading_chunk() {
    let mut recorder = Recorder::new();
    recorder.events.add(0, note_start(1, 0.0));
    run(&mut recorder, block(BlockFlags::default()));
    assert_eq!(recorder.log, vec![
        Step::Introduce(0),
        Step::Note(1),
        Step::Audio {s0: 0, s1: 128, discontinuous: false},
        Step::Finish
    ]);
}

#[test]
fn two_events_interleave_render_handle_render() {
    let mut recorder = Recorder::new();
    recorder.events.add(0, note_start(1, 2.56));
    recorder.events.add(0, note_start(2, 3.84));
    run(&mut recorder, block(BlockFlags::default()));
    let (first, second) = (split(2.56), split(3.84));
    assert_eq!(recorder.log, vec![
        Step::Introduce(0),
        Step::Audio {s0: 0, s1: first, discontinuous: false},
        Step::Note(1),
        Step::Audio {s0: first, s1: second, discontinuous: false},
        Step::Note(2),
        Step::Audio {s0: second, s1: 128, discontinuous: false},
        Step::Finish
    ]);
}

#[test]
fn update_events_go_to_update_parameters() {
    let mut recorder = Recorder::new();
    recorder.events.add(0, Event::Update {position: 2.56});
    run(&mut recorder, block(BlockFlags::default()));
    let boundary = split(2.56);
    assert_eq!(recorder.log, vec![
        Step::Introduce(0),
        Step::Audio {s0: 0, s1: boundary, discontinuous: false},
        Step::Update(2.56),
        Step::Audio {s0: boundary, s1: 128, discontinuous: false},
        Step::Finish
    ]);
}

#[test]
fn one_shot_flags_clear_after_the_first_chunk() {
    let mut recorder = Recorder::new();
    let flags = BlockFlags::create(true, true, true, false); // transporting + discontinuous + playing
    recorder.events.add(0, note_start(1, 2.56));
    run(&mut recorder, block(flags));
    let boundary = split(2.56);
    assert_eq!(recorder.log, vec![
        Step::Introduce(0),
        Step::Audio {s0: 0, s1: boundary, discontinuous: true},  // first chunk keeps the one-shot flag
        Step::Note(1),
        Step::Audio {s0: boundary, s1: 128, discontinuous: false}, // cleared afterward
        Step::Finish
    ]);
}

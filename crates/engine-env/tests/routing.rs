//! Audio buffer sharing: a consumer that holds its source's `SharedAudioBuffer` sees the producer's writes
//! (the TS shared-`AudioBuffer` semantics), and a summing node reads several shared sources at once.

use engine_env::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::RENDER_QUANTUM;

struct Producer {
    output: SharedAudioBuffer
}

impl AudioGenerator for Producer {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

struct Effect {
    source: Option<SharedAudioBuffer>
}

impl AudioInput for Effect {
    fn set_audio_source(&mut self, source: SharedAudioBuffer) {
        self.source = Some(source);
    }
}

#[test]
fn a_consumer_sees_writes_to_its_shared_source() {
    let producer = Producer {output: shared_audio_buffer()};
    let mut effect = Effect {source: None};
    effect.set_audio_source(producer.audio_output()); // wiring: store a handle to the producer's output

    producer.audio_output().borrow_mut().left[10] = 0.5; // producer renders
    let source = effect.source.as_ref().expect("wired");
    assert_eq!(source.borrow().left[10], 0.5, "the consumer reads the same buffer");
}

#[test]
fn set_audio_source_replaces_the_previous_source() {
    let first = shared_audio_buffer();
    let second = shared_audio_buffer();
    first.borrow_mut().left[0] = 1.0;
    second.borrow_mut().left[0] = 2.0;
    let mut effect = Effect {source: None};
    effect.set_audio_source(first);
    effect.set_audio_source(second);
    assert_eq!(effect.source.as_ref().unwrap().borrow().left[0], 2.0, "re-wire replaced the source");
}

#[test]
fn a_summing_node_reads_several_shared_sources() {
    let low = shared_audio_buffer();
    let high = shared_audio_buffer();
    low.borrow_mut().left[0] = 0.25;
    high.borrow_mut().left[0] = 0.5;
    let sources = [low, high];

    let mut mixed = AudioBuffer::new();
    mixed.clear_range(0, RENDER_QUANTUM);
    for source in &sources {
        mixed.add_range(&source.borrow(), 0, RENDER_QUANTUM);
    }
    assert_eq!(mixed.left[0], 0.75, "the bus summed both shared sources");
}

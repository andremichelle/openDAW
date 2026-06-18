//! SineDevice driven through the AudioProcessor template: a note-on (placed in the event input by
//! block + ppqn position) produces audio and a voice, the onset is sample-accurate (silent before its
//! offset), and a note-off's release eventually reclaims the voice.

use device_sine::SineDevice;
use engine_env::audio_generator::AudioGenerator;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::event::Event;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;

const SR: f32 = 48_000.0; // pulses_to_samples(p, 120, 48000) == floor(p * 25), so 2.56 -> 64
const BPM: f32 = 120.0;

fn block() -> Block {
    Block {index: 0, p0: 0.0, p1: 5.12, s0: 0, s1: 128, bpm: BPM, flags: BlockFlags::create(true, false, true, false)}
}

fn note_start(id: u64, position: f64, pitch: u8) -> Event {
    Event::NoteStart {id, position, duration: 240.0, pitch, cent: 0.0, velocity: 1.0}
}

fn left_energy(device: &SineDevice) -> f32 {
    device.audio_output().borrow().left.iter().map(|sample| sample * sample).sum()
}

#[test]
fn a_note_on_produces_audio_and_a_voice() {
    let mut device = SineDevice::new(SR);
    device.event_input().add(0, note_start(0, 0.0, 69));
    device.process(&ProcessInfo {blocks: &[block()]});
    assert_eq!(device.voice_count(), 1);
    assert!(left_energy(&device) > 0.0, "the buffer is no longer silent");
}

#[test]
fn the_onset_is_sample_accurate() {
    let mut device = SineDevice::new(SR);
    device.event_input().add(0, note_start(0, 2.56, 69)); // -> sample 64
    device.process(&ProcessInfo {blocks: &[block()]});
    let output = device.audio_output();
    let output = output.borrow();
    assert!(output.left[..64].iter().all(|sample| *sample == 0.0), "silent before the onset");
    assert!(output.left[64..].iter().any(|sample| sample.abs() > 0.0), "sounding after it");
}

#[test]
fn a_note_off_releases_the_voice_after_its_tail() {
    let mut device = SineDevice::new(SR);
    device.event_input().add(0, note_start(0, 0.0, 69));
    device.process(&ProcessInfo {blocks: &[block()]});
    device.event_input().add(0, Event::NoteComplete {id: 0, position: 0.0, pitch: 69});
    device.process(&ProcessInfo {blocks: &[block()]});
    // render past the 200 ms release tail (200 quanta = ~0.53 s at 48k).
    for _ in 0..200 {
        device.process(&ProcessInfo {blocks: &[block()]});
    }
    assert_eq!(device.voice_count(), 0, "the voice is reclaimed once its release finishes");
}

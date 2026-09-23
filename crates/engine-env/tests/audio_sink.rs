//! The audio sink: the tap is always a copy of the input, the chain output is the input at the `pass` level
//! (-inf dB = silence, 0 dB = a full copy, ramped between), and both go silent once the source is detached.

extern crate alloc;

use alloc::rc::Rc;
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::audio_sink::AudioSinkProcessor;
use engine_env::aux_send::SendParams;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::channel_strip::StripAutomation;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use engine_env::RENDER_QUANTUM;

const SR: f32 = 48_000.0;

fn sink(params: &Rc<SendParams>, automation: Rc<StripAutomation>) -> AudioSinkProcessor {
    AudioSinkProcessor::new(params.clone(), automation, SR)
}

fn ramp_input() -> SharedAudioBuffer {
    let input = shared_audio_buffer();
    {
        let mut buffer = input.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            buffer.left[index] = index as f32;
            buffer.right[index] = -(index as f32);
        }
    }
    input
}

// `pass` in dB; the params default (`SendParams::new`) is 0 dB, the box default is -inf (the engine copies it in).
fn sink_with_input(pass_db: f32) -> (AudioSinkProcessor, Rc<SendParams>) {
    let params = Rc::new(SendParams::new());
    params.gain_db.set(pass_db);
    let mut sink = sink(&params, Rc::new(StripAutomation::new()));
    sink.set_audio_source(ramp_input());
    (sink, params)
}

fn is_silent(buffer: &SharedAudioBuffer) -> bool {
    let buffer = buffer.borrow();
    buffer.left.iter().chain(buffer.right.iter()).all(|sample| *sample == 0.0)
}

fn is_ramp(buffer: &SharedAudioBuffer) -> bool {
    let buffer = buffer.borrow();
    (0..RENDER_QUANTUM).all(|index| buffer.left[index] == index as f32 && buffer.right[index] == -(index as f32))
}

#[test]
fn tap_copies_the_input_and_the_chain_gets_silence_at_minus_inf() {
    let (mut sink, _) = sink_with_input(f32::NEG_INFINITY);
    sink.process(&ProcessInfo {blocks: &[]});
    assert!(is_ramp(&sink.tap_output()), "the tap is the full input");
    assert!(is_silent(&sink.audio_output()), "-inf dB: the chain continues silent");
}

#[test]
fn zero_db_copies_the_input_to_the_chain_as_well() {
    let (mut sink, _) = sink_with_input(0.0);
    sink.process(&ProcessInfo {blocks: &[]});
    assert!(is_ramp(&sink.tap_output()));
    assert!(is_ramp(&sink.audio_output()), "0 dB: the chain gets the same copy");
}

#[test]
fn a_partial_pass_level_scales_the_chain_output_only() {
    let (mut sink, _) = sink_with_input(-6.0);
    sink.process(&ProcessInfo {blocks: &[]});
    let output = sink.audio_output();
    let buffer = output.borrow();
    let expected = 100.0 * math::db_to_gain(-6.0);
    assert!((buffer.left[100] - expected).abs() < 1.0e-3, "-6 dB on the chain, got {}", buffer.left[100]);
    assert!(is_ramp(&sink.tap_output()), "the bus still gets unity");
}

#[test]
fn a_pass_edit_ramps_instead_of_jumping() {
    let (mut sink, params) = sink_with_input(0.0);
    sink.process(&ProcessInfo {blocks: &[]});
    params.gain_db.set(f32::NEG_INFINITY);
    sink.process(&ProcessInfo {blocks: &[]});
    let output = sink.audio_output();
    let buffer = output.borrow();
    assert!(buffer.left[1] > 0.0 && buffer.left[1] < 1.0, "de-clicked: the first samples still carry signal, got {}", buffer.left[1]);
    let mut sink_settled = sink;
    drop(buffer);
    for _ in 0..64 { sink_settled.process(&ProcessInfo {blocks: &[]}); }
    assert!(is_silent(&sink_settled.audio_output()), "and it settles at silence");
    assert!(is_ramp(&sink_settled.tap_output()), "the tap keeps feeding the bus");
}

#[test]
fn an_automated_pass_level_retargets_at_the_update_clock_inside_the_quantum() {
    // Block p0 = 8, 5.12 pulses over 128 samples (120 bpm, 48 kHz): the 10-pulse grid lands at sample 50,
    // unity before it, ramping toward -inf after it.
    let params = Rc::new(SendParams::new());
    let automation = Rc::new(StripAutomation::new());
    *automation.volume.borrow_mut() = Some(Rc::new(|position: f64, _transporting: bool| if position < 10.0 {0.0} else {f32::NEG_INFINITY}));
    let mut sink = sink(&params, automation);
    let input = shared_audio_buffer();
    {
        let mut buffer = input.borrow_mut();
        for index in 0..RENDER_QUANTUM { buffer.left[index] = 1.0; buffer.right[index] = 1.0; }
    }
    sink.set_audio_source(input);
    let block = Block {index: 0, flags: BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::PLAYING), p0: 8.0, p1: 13.12, s0: 0, s1: RENDER_QUANTUM as u32, bpm: 120.0};
    sink.process(&ProcessInfo {blocks: &[block]});
    let output = sink.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[49] - 1.0).abs() < 1.0e-6, "the last pre-boundary sample is still unity");
    assert!(buffer.left[60] < 1.0 - 1.0e-3, "after the boundary the level ramps down");
    assert!(buffer.left[127] < buffer.left[60], "and keeps falling");
}

#[test]
fn a_detached_source_silences_both_outputs() {
    let (mut sink, _) = sink_with_input(0.0);
    sink.process(&ProcessInfo {blocks: &[]});
    sink.clear_audio_source();
    sink.process(&ProcessInfo {blocks: &[]});
    assert!(is_silent(&sink.tap_output()), "the bus must not sum a frozen quantum forever");
    assert!(is_silent(&sink.audio_output()));
}

#[test]
fn no_source_is_silent_from_the_start() {
    let mut sink = sink(&Rc::new(SendParams::new()), Rc::new(StripAutomation::new()));
    sink.process(&ProcessInfo {blocks: &[]});
    assert!(is_silent(&sink.tap_output()));
    assert!(is_silent(&sink.audio_output()));
}

#[test]
fn the_tap_and_the_output_are_distinct_buffers() {
    let sink = sink(&Rc::new(SendParams::new()), Rc::new(StripAutomation::new()));
    assert!(!Rc::ptr_eq(&sink.tap_output(), &sink.audio_output()), "the bus sums the tap by identity, never the chain output");
}

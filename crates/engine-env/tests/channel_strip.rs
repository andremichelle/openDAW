//! The channel strip: volume (dB -> gain) + pan + mute applied to the input, with de-clicking ramps. And
//! the LinearRamp itself: jump on a hard set, linear interpolation to the target on a smooth set.

use alloc::rc::Rc;
extern crate alloc;

use engine_env::audio_buffer::shared_audio_buffer;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::channel_strip::{ChannelStripProcessor, StripParams};
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use engine_env::ramp::LinearRamp;
use engine_env::RENDER_QUANTUM;

const SR: f32 = 48_000.0;

#[test]
fn ramp_jumps_on_hard_set_and_interpolates_on_smooth_set() {
    let mut ramp = LinearRamp::new(SR, 0.005); // 240 samples
    ramp.set(1.0, false);
    assert_eq!(ramp.get(), 1.0, "a hard set jumps immediately");
    assert!(!ramp.is_interpolating());
    ramp.set(0.0, true);
    assert!(ramp.is_interpolating(), "a smooth set ramps");
    assert!(ramp.get() > 0.5, "not there yet after one block boundary");
    for _ in 0..240 { ramp.move_and_get(); }
    assert_eq!(ramp.get(), 0.0, "reaches the target after `length` samples");
    assert!(!ramp.is_interpolating());
}

fn strip_with_input(level: f32) -> (ChannelStripProcessor, Rc<StripParams>) {
    let params = Rc::new(StripParams::new());
    let mut strip = ChannelStripProcessor::new(params.clone(), SR);
    let input = shared_audio_buffer();
    {
        let mut buffer = input.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            buffer.left[index] = level;
            buffer.right[index] = level;
        }
    }
    strip.set_audio_source(input);
    (strip, params)
}

#[test]
fn unity_gain_passes_the_input_through() {
    let (mut strip, _params) = strip_with_input(1.0);
    strip.process(&ProcessInfo {blocks: &[]}); // first block: gains jump (processing == false)
    let output = strip.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[RENDER_QUANTUM - 1] - 1.0).abs() < 1.0e-6, "0 dB, centre pan -> unity");
    assert!((buffer.right[RENDER_QUANTUM - 1] - 1.0).abs() < 1.0e-6);
}

#[test]
fn mute_ramps_down_to_silence() {
    let (mut strip, params) = strip_with_input(1.0);
    strip.process(&ProcessInfo {blocks: &[]}); // settle at unity
    params.mute.set(true);
    strip.process(&ProcessInfo {blocks: &[]}); // ramps 1 -> 0 across the block (240 < 128? see note)
    strip.process(&ProcessInfo {blocks: &[]}); // a second block: the 5 ms ramp (240 spls) has completed
    let output = strip.audio_output();
    let buffer = output.borrow();
    assert!(buffer.left[RENDER_QUANTUM - 1].abs() < 1.0e-6, "mute reaches silence");
}

#[test]
fn full_left_pan_silences_the_right() {
    let (mut strip, params) = strip_with_input(1.0);
    params.panning.set(-1.0); // hard left
    strip.process(&ProcessInfo {blocks: &[]}); // first block jumps to the pan target
    let output = strip.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[RENDER_QUANTUM - 1] - 1.0).abs() < 1.0e-6, "left keeps full gain");
    assert!(buffer.right[RENDER_QUANTUM - 1].abs() < 1.0e-6, "right is silenced");
}

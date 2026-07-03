//! The aux send: automated sendGain resolves at the update clock inside the quantum (mirroring the channel
//! strip / TS `AudioProcessor` splitting), while static params keep the whole-quantum fast path.

use alloc::rc::Rc;
extern crate alloc;

use engine_env::audio_buffer::shared_audio_buffer;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::aux_send::{AuxSendProcessor, SendParams};
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::channel_strip::StripAutomation;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use engine_env::RENDER_QUANTUM;

const SR: f32 = 48_000.0;

fn send_with_input(automation: Rc<StripAutomation>) -> AuxSendProcessor {
    let mut send = AuxSendProcessor::new(Rc::new(SendParams::new()), automation, SR);
    let input = shared_audio_buffer();
    {
        let mut buffer = input.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            buffer.left[index] = 1.0;
            buffer.right[index] = 1.0;
        }
    }
    send.set_audio_source(input);
    send
}

#[test]
fn static_params_pass_unity_through() {
    let mut send = send_with_input(Rc::new(StripAutomation::new()));
    send.process(&ProcessInfo {blocks: &[]});
    let output = send.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[RENDER_QUANTUM - 1] - 1.0).abs() < 1.0e-6, "0 dB, centre pan -> unity");
}

#[test]
fn automated_send_gain_retargets_at_the_update_clock_inside_the_quantum() {
    // Block p0 = 8, 5.12 pulses over 128 samples (120 bpm, 48 kHz): the 10-pulse grid point lands at
    // sample 50, unity before it, ramping toward -72 dB after it.
    let automation = Rc::new(StripAutomation::new());
    *automation.volume.borrow_mut() = Some(Rc::new(|position: f64| if position < 10.0 {0.0} else {-72.0}));
    let mut send = send_with_input(automation);
    let block = Block {index: 0, flags: BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::PLAYING), p0: 8.0, p1: 13.12, s0: 0, s1: RENDER_QUANTUM as u32, bpm: 120.0};
    send.process(&ProcessInfo {blocks: &[block]});
    let output = send.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[10] - 1.0).abs() < 1.0e-6, "before the grid point: unity");
    assert!((buffer.left[49] - 1.0).abs() < 1.0e-6, "the last pre-boundary sample is still unity");
    assert!(buffer.left[60] < 1.0 - 1.0e-3, "after the 10-pulse boundary the gain ramps down");
    assert!(buffer.left[127] < buffer.left[60], "and keeps falling across the rest of the quantum");
}

//! EFFECTS-mode input monitoring (TS `MonitoringMixProcessor` + `EngineProcessor.#monitoringMap`): the
//! worklet stages up to [`MONITOR_CHANNELS`] live input channels into [`crate::MONITOR_INPUT`] before each
//! render; a unit in the monitoring map carries a [`MonitorMix`] node that ADDS its mapped channels into the
//! unit's chain-START buffer (post instrument / player / sum, PRE-FX — the exact TS injection point), so the
//! input runs through the unit's effect chain and strip. After the render the engine copies each mapped
//! unit's STRIP output (TS `unit.audioOutput()`) into [`crate::MONITOR_OUTPUT`], which the worklet forwards
//! on its SECOND output back to the main-thread monitor gain/pan (the `MonitoringRouter` return).

use engine_env::audio_buffer::SharedAudioBuffer;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use engine_env::RENDER_QUANTUM;

pub const MONITOR_CHANNELS: usize = 8; // TS MonitoringRouter.MAX_MONITORING_CHANNELS

/// One monitoring map entry (TS `MonitoringMapEntry`): the unit's uuid and its staged input channel
/// indices (`right` = -1 for a mono source, which then feeds both target channels).
#[derive(Clone, Copy)]
pub struct MonitorEntry {
    pub uuid: [u8; 16],
    pub left: i32,
    pub right: i32
}

/// The in-chain injector: adds the staged input channels into `target` IN PLACE (TS
/// `MonitoringMixProcessor.process`: `targetL[i] += inputL[i]`). Ordered after the buffer's producer and
/// before its consumers, so the effects see instrument + live input summed.
pub struct MonitorMix {
    target: SharedAudioBuffer,
    left: i32,
    right: i32,
    events: EventBuffer
}

impl MonitorMix {
    pub fn new(target: SharedAudioBuffer, left: i32, right: i32) -> Self {
        Self {target, left, right, events: EventBuffer::new()}
    }
}

impl EventReceiver for MonitorMix {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl Processor for MonitorMix {
    fn reset(&mut self) {}

    fn process(&mut self, _info: &ProcessInfo) {
        let staging = unsafe { crate::MONITOR_INPUT.get() };
        let left_channel = self.left as usize;
        if self.left < 0 || left_channel >= MONITOR_CHANNELS {
            return;
        }
        let right_channel = if (0..MONITOR_CHANNELS as i32).contains(&self.right) {self.right as usize} else {left_channel};
        let mut target = self.target.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            target.left[index] += staging[left_channel * RENDER_QUANTUM + index];
            target.right[index] += staging[right_channel * RENDER_QUANTUM + index];
        }
    }
}

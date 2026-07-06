//! FROZEN-unit playback (TS `FrozenPlaybackProcessor`): a unit whose audio was pre-rendered (the freeze =
//! a one-stem offline render with `skipChannelStrip`) plays that PCM transport-aligned instead of running
//! its instrument + effects. The read position re-seats from the TEMPO MAP on any discontinuity
//! (`intervalToSeconds(0, p0) * dataSampleRate`), so seeks, loops and tempo automation stay sample-exact;
//! the unit's LIVE channel strip (fader / mute / panning) still applies after it (the freeze rendered
//! everything up to, but not including, the strip).

use alloc::rc::Rc;
use alloc::vec::Vec;
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::block_flags::BlockFlags;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use crate::tempo_map::SharedTempoMap;

/// One unit's frozen PCM: planar left then right (`frame_count` each; a mono freeze duplicates), at the
/// rate it was rendered with (the engine rate — the reader advances one frame per engine sample, like TS).
pub struct FrozenData {
    pub frames: Vec<f32>,
    pub frame_count: usize,
    pub sample_rate: f32
}

pub struct FrozenPlayback {
    data: Rc<FrozenData>,
    tempo_map: SharedTempoMap,
    output: SharedAudioBuffer,
    read_position: i64,
    events: EventBuffer
}

impl FrozenPlayback {
    pub fn new(data: Rc<FrozenData>, tempo_map: SharedTempoMap) -> Self {
        Self {data, tempo_map, output: shared_audio_buffer(), read_position: -1, events: EventBuffer::new()}
    }

    pub fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl EventReceiver for FrozenPlayback {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl Processor for FrozenPlayback {
    fn reset(&mut self) {
        self.read_position = -1;
        self.output.borrow_mut().clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        let mut output = self.output.borrow_mut();
        output.clear();
        let frame_count = self.data.frame_count as i64;
        let left = &self.data.frames[..self.data.frame_count];
        let right = &self.data.frames[self.data.frame_count..];
        for block in info.blocks {
            let playing = BlockFlags::TRANSPORTING | BlockFlags::PLAYING;
            if block.flags.0 & playing != playing {
                continue;
            }
            if block.flags.0 & BlockFlags::DISCONTINUOUS != 0 || self.read_position < 0 {
                let seconds = self.tempo_map.borrow().interval_to_seconds(0.0, block.p0);
                self.read_position = (seconds * self.data.sample_rate as f64 + 0.5) as i64;
            }
            let mut read = self.read_position;
            for index in block.s0 as usize..block.s1 as usize {
                if read >= 0 && read < frame_count {
                    output.left[index] = left[read as usize];
                    output.right[index] = right[read as usize];
                }
                read += 1;
            }
            self.read_position = read;
        }
    }
}

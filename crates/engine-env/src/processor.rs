//! A graph node (`Processor` in TS): renders one quantum's blocks and can be reset. Extends
//! `EventReceiver` because every processor has an event input.

use alloc::vec::Vec;
use crate::compensation::CompensationLimits;
use crate::engine_context::NodeId;
use crate::event_receiver::EventReceiver;
use crate::process_info::ProcessInfo;

pub trait Processor: EventReceiver {
    fn reset(&mut self);
    fn process(&mut self, info: &ProcessInfo);
    fn latency(&self) -> u32 {
        0
    }
    /// A node that sums or mixes inputs names them here, in the order `set_junction_delays` receives them.
    fn junction_sources(&self) -> Option<Vec<NodeId>> {
        None
    }
    fn set_junction_delays(&mut self, _delays: &[u32], _limits: CompensationLimits) {}
    /// A node reading sidechains aligns its main input and every sidechain to the latest of them.
    fn aligns_inputs(&self) -> bool {
        false
    }
    fn set_input_delays(&mut self, _main: u32, _sidechains: &[(NodeId, u32)], _limits: CompensationLimits) {}
    /// Frames this node's input is late, so its automation follows the audio it processes.
    fn set_automation_delay(&mut self, _frames: u32) {}
}

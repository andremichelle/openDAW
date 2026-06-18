//! A graph node (`Processor` in TS): renders one quantum's blocks and can be reset. Extends
//! `EventReceiver` because every processor has an event input.

use crate::event_receiver::EventReceiver;
use crate::process_info::ProcessInfo;

pub trait Processor: EventReceiver {
    fn reset(&mut self);
    fn process(&mut self, info: &ProcessInfo);
}

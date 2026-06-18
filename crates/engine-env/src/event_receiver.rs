//! A node that receives runtime events (`EventReceiver` in TS): `event_input` is the per-block queue
//! that upstream sources and the update clock write into.

use crate::event_buffer::EventBuffer;

pub trait EventReceiver {
    fn event_input(&mut self) -> &mut EventBuffer;
}

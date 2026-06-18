//! The runtime per-block event, ported from the TS `Event` union (`lib/dsp/events.ts` base +
//! core-processors `NoteEventSource` / `UpdateClock`). Note-on, note-off, and update-clock ticks all
//! flow through one `EventBuffer` and are dispatched together per block, so in Rust they are one enum
//! matched by every processor. This is the runtime stream, distinct from the value crate's `Event`
//! trait (the sorted timeline-collection element).
//!
//! Each event carries its `position` in pulses; the `AudioProcessor` template converts that to a
//! sample offset within the block (mirroring TS, which does the same from `event.position`).

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    /// A note begins. `id` matches the later `NoteComplete`. (TS `Id<NoteEvent>`, type `note-event`.)
    NoteStart {id: u64, position: f64, duration: f64, pitch: u8, cent: f32, velocity: f32},
    /// A note ends. (TS `NoteCompleteEvent`, type `note-complete-event`.)
    NoteComplete {id: u64, position: f64, pitch: u8},
    /// An update-clock tick driving parameter-automation polling. (TS `UpdateEvent`, type `update-event`.)
    Update {position: f64}
}

impl Event {
    pub fn position(&self) -> f64 {
        match self {
            Event::NoteStart {position, ..} | Event::NoteComplete {position, ..} | Event::Update {position} => *position
        }
    }
}

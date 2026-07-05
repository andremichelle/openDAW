//! A loopable note region on the timeline (the span the note sequencer reads): a region at `position`
//! of `duration` pulses whose content loops every `loop_duration` from `loop_offset`, plus its `mute`
//! flag (a muted region emits no notes — TS `NoteSequencer.#processRegions` skips it). Mirrors the
//! lib-dsp `LoopableRegion` fields the sequencer needs; the loop math is `value::region::locate_loops`.

#[derive(Clone, Copy, Debug)]
pub struct NoteRegion {
    pub position: f64,
    pub duration: f64,
    pub loop_offset: f64,
    pub loop_duration: f64,
    pub mute: bool
}

impl NoteRegion {
    pub fn complete(&self) -> f64 {
        self.position + self.duration
    }
}

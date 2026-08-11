//! Resolves the internal pattern and live note input into ONE ordered stream for the single voice.
//!
//! The 303 has one voice and its state is order-dependent - accent-cap depletion, slide-into-next-
//! note, envelope recharge between notes. Two sources writing the voice directly would reproduce,
//! as architecture, the exact defects the ar-303 calibration removed. So everything funnels here
//! first, and only this module talks to `Voice303`.
//!
//! Policy (decided with the user): last-note priority, overlapping notes slide to the new note,
//! velocity above a threshold accents.

/// Distinguishes the two sources. Kept even though the merge treats them as peers, because the
/// pattern supplies accent/slide EXPLICITLY and live notes infer them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {Pattern, Live}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VoiceCommand {
    NoteOn {pitch: f64, accent: bool, slide: bool},
    NoteOff
}

#[derive(Clone, Copy, Debug)]
struct Held {id: u64, pitch: f64, accent: bool}

/// MIDI velocity 100 of 127, the measured accent threshold of the reference sequencer. Live notes
/// arrive normalised, so the comparison happens in 0..1.
pub const ACCENT_VELOCITY: f32 = 100.0 / 127.0;

/// Every internal-pattern note uses this id, which makes the pattern monophonic against ITSELF
/// while still stacking against live input.
///
/// A slide chain is ONE note whose pitch glides, not a pile of overlapping notes. If each step
/// pushed its own entry, the chain would leave phantom held notes behind and the release at the end
/// of the chain would fall back to a step that stopped sounding seconds earlier. Reusing one id
/// makes each step replace its predecessor through the same path that absorbs a duplicate note-on.
pub const PATTERN_NOTE_ID: u64 = 0;

/// Deep enough for ten fingers plus the pattern with room to spare. A fixed array, not a Vec: the
/// deployed cdylib is no_std and heap-free.
pub const MAX_HELD: usize = 16;

pub struct NoteMerger {
    held: [Held; MAX_HELD],
    held_count: usize,
    sounding: Option<u64>,
    accent_velocity: f32
}

impl Default for NoteMerger {
    fn default() -> Self {Self::new()}
}

impl NoteMerger {
    pub fn new() -> Self {Self::with_accent_velocity(ACCENT_VELOCITY)}

    pub fn with_accent_velocity(accent_velocity: f32) -> Self {
        Self {held: [Held {id: 0, pitch: 0.0, accent: false}; MAX_HELD],
              held_count: 0, sounding: None, accent_velocity}
    }

    fn position(&self, id: u64) -> Option<usize> {
        self.held[..self.held_count].iter().position(|note| note.id == id)
    }

    fn remove_at(&mut self, index: usize) {
        for i in index..self.held_count - 1 {self.held[i] = self.held[i + 1];}
        self.held_count -= 1;
    }

    pub fn is_sounding(&self) -> bool {self.sounding.is_some()}

    pub fn held_count(&self) -> usize {self.held_count}

    /// A note begins. `accent`/`slide` are `Some` only for pattern steps, which carry their own
    /// bits; passing `None` (live input) derives accent from velocity and slide from legato.
    ///
    /// Deriving slide from legato is not a shortcut, it is what the hardware does: a slide is
    /// simply the gate never closing, which is why `Voice303::note_on` only glides when the gate is
    /// already on. But pattern steps must still pass their explicit bit - a tie chain holds the
    /// gate open across steps that the pattern marks as NOT sliding, and inferring there would
    /// turn every step of a chain into a slide and destroy the accent contrast the model was
    /// calibrated around.
    pub fn note_on(&mut self, id: u64, pitch: f64, velocity: f32, _source: Source,
                   accent: Option<bool>, slide: Option<bool>) -> VoiceCommand {
        let legato = self.held_count > 0;
        let accent = accent.unwrap_or(velocity >= self.accent_velocity);
        let slide = slide.unwrap_or(legato);
        // A repeated id replaces its entry rather than stacking a duplicate, so a source that
        // re-sends a note-on without its note-off cannot leak a phantom held note that keeps the
        // voice gated forever.
        if let Some(index) = self.position(id) {self.remove_at(index);}
        // Oldest-first eviction if someone holds more than MAX_HELD: dropping the note that has
        // been down longest is what a mono synth's priority stack would lose anyway, and it keeps
        // the newest notes (the ones that will sound) intact.
        if self.held_count == MAX_HELD {self.remove_at(0);}
        self.held[self.held_count] = Held {id, pitch, accent};
        self.held_count += 1;
        self.sounding = Some(id);
        VoiceCommand::NoteOn {pitch, accent, slide}
    }

    /// A note ends. Returns `None` when the note was not the sounding one: releasing a note that is
    /// merely held under a newer one must not disturb the voice.
    pub fn note_off(&mut self, id: u64) -> Option<VoiceCommand> {
        let index = self.position(id)?;
        self.remove_at(index);
        if self.sounding != Some(id) {return None}
        match self.held[..self.held_count].last() {
            // Fall back to the most recent still-held note. Slide, because the gate never closed -
            // the same reasoning as legato above.
            Some(note) => {
                let (pitch, accent, id) = (note.pitch, note.accent, note.id);
                self.sounding = Some(id);
                Some(VoiceCommand::NoteOn {pitch, accent, slide: true})
            }
            None => {
                self.sounding = None;
                Some(VoiceCommand::NoteOff)
            }
        }
    }

    /// Drop everything without sounding anything. For transport stop / device reset, where the
    /// voice is silenced separately.
    pub fn reset(&mut self) {
        self.held_count = 0;
        self.sounding = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(pitch: f64, accent: bool, slide: bool) -> VoiceCommand {
        VoiceCommand::NoteOn {pitch, accent, slide}
    }

    #[test]
    fn single_live_note_gates_and_releases() {
        let mut merger = NoteMerger::new();
        assert_eq!(merger.note_on(1, 36.0, 0.5, Source::Live, None, None), on(36.0, false, false));
        assert_eq!(merger.note_off(1), Some(VoiceCommand::NoteOff));
        assert!(!merger.is_sounding());
    }

    #[test]
    fn velocity_above_threshold_accents() {
        let mut merger = NoteMerger::new();
        assert_eq!(merger.note_on(1, 36.0, 0.78, Source::Live, None, None), on(36.0, false, false));
        merger.note_off(1);
        assert_eq!(merger.note_on(2, 36.0, 0.79, Source::Live, None, None), on(36.0, true, false));
    }

    #[test]
    fn overlapping_live_notes_slide() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.5, Source::Live, None, None);
        assert_eq!(merger.note_on(2, 43.0, 0.5, Source::Live, None, None), on(43.0, false, true));
    }

    #[test]
    fn releasing_the_top_note_slides_back_to_the_one_still_held() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.5, Source::Live, None, None);
        merger.note_on(2, 43.0, 0.5, Source::Live, None, None);
        assert_eq!(merger.note_off(2), Some(on(36.0, false, true)));
        assert_eq!(merger.note_off(1), Some(VoiceCommand::NoteOff));
    }

    #[test]
    fn releasing_an_underlying_note_does_not_disturb_the_voice() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.5, Source::Live, None, None);
        merger.note_on(2, 43.0, 0.5, Source::Live, None, None);
        assert_eq!(merger.note_off(1), None);
        // ...and the released note must not come back when the top one ends
        assert_eq!(merger.note_off(2), Some(VoiceCommand::NoteOff));
    }

    #[test]
    fn pattern_bits_win_over_inference() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.0, Source::Pattern, Some(true), Some(false));
        // legato would infer slide=true here; the pattern says otherwise and must be obeyed, or a
        // tie chain turns every step into a slide
        assert_eq!(merger.note_on(2, 38.0, 0.0, Source::Pattern, Some(false), Some(false)),
                   on(38.0, false, false));
    }

    #[test]
    fn a_live_note_over_a_running_pattern_takes_the_voice() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.0, Source::Pattern, Some(false), Some(false));
        assert_eq!(merger.note_on(2, 48.0, 1.0, Source::Live, None, None), on(48.0, true, true));
        // the pattern note is still held underneath, so releasing the live note returns to it
        assert_eq!(merger.note_off(2), Some(on(36.0, false, true)));
    }

    #[test]
    fn repeated_note_on_does_not_leak_a_phantom_held_note() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.5, Source::Live, None, None);
        merger.note_on(1, 40.0, 0.5, Source::Live, None, None);
        assert_eq!(merger.held_count(), 1);
        assert_eq!(merger.note_off(1), Some(VoiceCommand::NoteOff));
    }

    #[test]
    fn a_slide_chain_does_not_stack_pattern_notes() {
        let mut merger = NoteMerger::new();
        for (pitch, slide) in [(36.0, false), (43.0, true), (48.0, true)] {
            merger.note_on(PATTERN_NOTE_ID, pitch, 0.0, Source::Pattern, Some(false), Some(slide));
        }
        assert_eq!(merger.held_count(), 1, "a chain is one gliding note, not three held notes");
        assert_eq!(merger.note_off(PATTERN_NOTE_ID), Some(VoiceCommand::NoteOff));
    }

    #[test]
    fn a_pattern_chain_under_a_live_note_still_returns_to_the_live_note() {
        let mut merger = NoteMerger::new();
        merger.note_on(7, 60.0, 0.2, Source::Live, None, None);
        merger.note_on(PATTERN_NOTE_ID, 36.0, 0.0, Source::Pattern, Some(false), Some(false));
        merger.note_on(PATTERN_NOTE_ID, 43.0, 0.0, Source::Pattern, Some(false), Some(true));
        assert_eq!(merger.held_count(), 2);
        assert_eq!(merger.note_off(PATTERN_NOTE_ID), Some(on(60.0, false, true)));
    }

    #[test]
    fn unknown_note_off_is_ignored() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.5, Source::Live, None, None);
        assert_eq!(merger.note_off(99), None);
        assert!(merger.is_sounding());
    }

    #[test]
    fn reset_clears_without_sounding() {
        let mut merger = NoteMerger::new();
        merger.note_on(1, 36.0, 0.5, Source::Live, None, None);
        merger.reset();
        assert!(!merger.is_sounding());
        assert_eq!(merger.held_count(), 0);
        assert_eq!(merger.note_off(1), None);
    }
}

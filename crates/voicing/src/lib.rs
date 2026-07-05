//! Shareable polyphony for synth devices, a heap-free port of the TS `voicing` framework (Voice / Voicing /
//! strategies / unison). A synth implements the [`Voice`] trait (its per-note DSP); the framework owns the
//! FIXED voice storage in the device's (zeroed) state block and allocates / steals / frees by index, with no
//! `new` per note and no allocator. Const-generic over the polyphony so a device picks its voice/stack counts.
//!
//! Built over the one [`Voice`] trait: the two [`VoicingStrategy`] implementations, [`PolyphonicStrategy`] (a
//! fixed pool with free-slot / steal / glide-from-released) and [`MonophonicStrategy`] (one voice plus a
//! held-note stack with legato glide); [`VoiceUnison`] (N detuned/spread sub-voices played as one note, itself
//! a [`Voice`] so it nests into either strategy); and [`Voicing`], the runtime dispatcher that switches between
//! the two strategies by [`VoicingMode`].

#![cfg_attr(not(test), no_std)]

use abi::{Block, EventRecord};

/// One synth voice's per-note DSP, driven by a [`VoicingStrategy`]. The framework calls `start` when a note is
/// assigned to this voice, `stop` on note-off (enter the release), `force_stop` when the voice is stolen, and
/// `process` each chunk; `process` returns `true` once the voice has fully decayed so the strategy can reclaim
/// it. `start_glide` / `current_frequency` support portamento (legato and voice reuse).
pub trait Voice {
    /// The device-wide, live parameters a voice reads each chunk (osc gains, cutoff, LFO, …). Shared by every
    /// voice and passed to [`process`](Voice::process); the device owns it. `()` for a voice with none.
    type Shared;
    /// Assign a note: `frequency` Hz, normalised `gain` (0..1), stereo `spread` (-1..1, for a unison
    /// sub-voice), the per-note `unison` voice count (used by [`VoiceUnison`]; plain voices ignore it), and the
    /// device's live `shared` params (read at note-on for the envelope, keyboard tracking, sample rate, …).
    fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, spread: f32, unison: usize, shared: &Self::Shared);
    /// Note-off: release the envelope (the voice keeps sounding until it decays).
    fn stop(&mut self);
    /// Cut the voice immediately (the slot is being stolen).
    fn force_stop(&mut self);
    /// Glide the pitch to `target_frequency` over `glide_duration` pulses.
    fn start_glide(&mut self, target_frequency: f32, glide_duration: f64);
    /// Whether the note is still held (gate on).
    fn gate(&self) -> bool;
    /// The current (possibly gliding) frequency, for legato / reuse.
    fn current_frequency(&self) -> f32;
    /// Render additively into the stereo `output` for one chunk, reading the device's live `shared` params;
    /// return `true` when fully finished (silent and released), so the pool frees the slot.
    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &Self::Shared) -> bool;
}

/// A note-allocation strategy over a fixed set of [`Voice`]s (a port of TS `VoicingStrategy`), implemented by
/// [`PolyphonicStrategy`] and [`MonophonicStrategy`] and driven uniformly by the [`Voicing`] dispatcher. The
/// per-note `frequency`, `gain`, `glide_duration` (pulses) and `unison` count are computed by the device and
/// passed in; `process` renders one chunk additively and returns `true` when the strategy is idle (all voices
/// finished). `force_stop` cuts every sounding note and clears the strategy's note bookkeeping but leaves the
/// voices to decay out on the following chunks; `reset` clears everything immediately (a transport stop).
pub trait VoicingStrategy {
    /// The per-note voice this strategy drives (its [`Voice::Shared`] is what `process` reads).
    type Voice: Voice;
    fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, glide_duration: f64, unison: usize, shared: &<Self::Voice as Voice>::Shared);
    fn stop(&mut self, note_id: i32, glide_duration: f64);
    fn force_stop(&mut self);
    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &<Self::Voice as Voice>::Shared) -> bool;
    fn reset(&mut self);
}

/// One pool slot: a voice plus the note id it is playing and whether it is in use.
struct Slot<V> {
    voice: V,
    note_id: i32,
    active: bool
}

/// A fixed pool of `VOICES` voices with polyphonic allocation (a port of TS `PolyphonicStrategy`). Lives in the
/// device's zeroed state (a zeroed pool is all-inactive). On note-on it takes a free slot, else steals a
/// released (un-gated) one, else the first slot; on note-off it releases the matching voice; each chunk it
/// renders the active voices and frees any that report finished. A new note glides in from the frequency of a
/// still-decaying released voice when one exists (mirroring the TS `availableForGlide` behaviour).
pub struct PolyphonicStrategy<V, const VOICES: usize> {
    slots: [Slot<V>; VOICES]
}

impl<V: Voice + Default, const VOICES: usize> Default for PolyphonicStrategy<V, VOICES> {
    fn default() -> Self {
        Self {slots: core::array::from_fn(|_| Slot {voice: V::default(), note_id: 0, active: false})}
    }
}

impl<V: Voice + Default, const VOICES: usize> PolyphonicStrategy<V, VOICES> {
    pub fn new() -> Self {
        Self::default()
    }

    fn allocate(&mut self) -> usize {
        if let Some(index) = self.slots.iter().position(|slot| !slot.active) {
            return index;
        }
        if let Some(index) = self.slots.iter().position(|slot| !slot.voice.gate()) {
            self.slots[index].voice.force_stop();
            return index;
        }
        self.slots[0].voice.force_stop();
        0
    }

    /// The number of slots currently in use.
    pub fn active_count(&self) -> usize {
        self.slots.iter().filter(|slot| slot.active).count()
    }
}

impl<V: Voice + Default, const VOICES: usize> VoicingStrategy for PolyphonicStrategy<V, VOICES> {
    type Voice = V;

    fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, glide_duration: f64, unison: usize, shared: &V::Shared) {
        let from = self.slots.iter().find(|slot| slot.active && !slot.voice.gate())
            .map(|slot| slot.voice.current_frequency());
        let index = self.allocate();
        self.slots[index].voice.start(event, from.unwrap_or(frequency), gain, 0.0, unison, shared);
        if from.is_some() {
            self.slots[index].voice.start_glide(frequency, glide_duration);
        }
        self.slots[index].note_id = event.id as i32;
        self.slots[index].active = true;
    }

    fn stop(&mut self, note_id: i32, _glide_duration: f64) {
        for slot in &mut self.slots {
            if slot.active && slot.note_id == note_id && slot.voice.gate() {
                slot.voice.stop();
            }
        }
    }

    fn force_stop(&mut self) {
        for slot in &mut self.slots {
            if slot.active {
                slot.voice.force_stop();
            }
        }
    }

    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &V::Shared) -> bool {
        let [out_left, out_right] = output;
        for slot in &mut self.slots {
            if slot.active && slot.voice.process([&mut *out_left, &mut *out_right], block, shared) {
                slot.active = false;
            }
        }
        self.slots.iter().all(|slot| !slot.active)
    }

    fn reset(&mut self) {
        for slot in &mut self.slots {
            if slot.active {
                slot.voice.force_stop();
                slot.active = false;
            }
        }
    }
}

/// `U` detuned/spread sub-voices played as ONE note (a port of TS `VoiceUnison`), and itself a [`Voice`] so it
/// drops into the pool as the per-slot voice. `start` activates `unison` (clamped to `U`) sub-voices, each at
/// a stereo spread fanned across the field, with the gain energy-normalised by `1/sqrt(count)`; glide and gate
/// fan out to the active sub-voices, and the unison is finished once all of them are.
pub struct VoiceUnison<V, const U: usize> {
    voices: [V; U],
    active: usize,
    gated: bool
}

impl<V: Voice + Default, const U: usize> Default for VoiceUnison<V, U> {
    fn default() -> Self {
        Self {voices: core::array::from_fn(|_| V::default()), active: 0, gated: false}
    }
}

impl<V: Voice + Default, const U: usize> VoiceUnison<V, U> {
    /// The FIRST sub-voice of the group (TS `unisono.processing().at(0)`) — the group's telemetry
    /// representative (e.g. the Vaporisateur's envelope playhead). `None` while the group is inactive.
    pub fn first(&self) -> Option<&V> {
        if self.active > 0 { Some(&self.voices[0]) } else { None }
    }
}

impl<V: Voice + Default, const U: usize> Voice for VoiceUnison<V, U> {
    type Shared = V::Shared;

    fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, spread: f32, unison: usize, shared: &V::Shared) {
        self.active = unison.clamp(1, U);
        self.gated = true;
        for voice in &mut self.voices {
            voice.force_stop(); // clear any stale sub-voice from a previous (wider) note before reuse
        }
        let normalized_gain = gain / libm::sqrtf(self.active as f32);
        for index in 0..self.active {
            let sub_spread = if self.active == 1 {
                spread
            } else {
                let fan = (index as f32 / (self.active - 1) as f32) * 2.0 - 1.0; // -1..+1 fanned across the voices
                (1.0 - libm::fabsf(spread)) * fan + spread
            };
            self.voices[index].start(event, frequency, normalized_gain, sub_spread, 1, shared);
        }
    }

    fn stop(&mut self) {
        self.gated = false;
        for voice in self.voices.iter_mut().take(self.active) {
            voice.stop();
        }
    }

    fn force_stop(&mut self) {
        self.gated = false;
        for voice in &mut self.voices {
            voice.force_stop();
        }
    }

    fn start_glide(&mut self, target_frequency: f32, glide_duration: f64) {
        for voice in self.voices.iter_mut().take(self.active) {
            voice.start_glide(target_frequency, glide_duration);
        }
    }

    fn gate(&self) -> bool {
        self.gated
    }

    fn current_frequency(&self) -> f32 {
        if self.active == 0 {0.0} else {self.voices[0].current_frequency()}
    }

    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &Self::Shared) -> bool {
        let [out_left, out_right] = output;
        let mut finished = true;
        for voice in self.voices.iter_mut().take(self.active) {
            if !voice.process([&mut *out_left, &mut *out_right], block, shared) {
                finished = false;
            }
        }
        finished
    }
}

/// One held key: its note id and frequency, kept so releasing the top note can glide back to the one beneath.
#[derive(Clone, Copy, Default)]
struct HeldNote {
    id: i32,
    frequency: f32
}

/// Monophonic voicing (a port of TS `MonophonicStrategy`): ONE sounding voice plus a `STACK`-deep stack of
/// held notes, with legato glide. A new note while a key is held glides the voice to it (no retrigger);
/// releasing the top note glides back to the next held note; releasing the last note releases the voice; a
/// note arriving while the voice is in its release re-triggers it, gliding from the dying pitch.
pub struct MonophonicStrategy<V, const STACK: usize> {
    voice: V,
    held: [HeldNote; STACK],
    depth: usize,
    active: bool
}

impl<V: Voice + Default, const STACK: usize> Default for MonophonicStrategy<V, STACK> {
    fn default() -> Self {
        Self {voice: V::default(), held: [HeldNote::default(); STACK], depth: 0, active: false}
    }
}

impl<V: Voice + Default, const STACK: usize> MonophonicStrategy<V, STACK> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a voice is currently sounding.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// The voice's current (possibly gliding) frequency.
    pub fn current_frequency(&self) -> f32 {
        self.voice.current_frequency()
    }
}

impl<V: Voice + Default, const STACK: usize> VoicingStrategy for MonophonicStrategy<V, STACK> {
    type Voice = V;

    fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, glide_duration: f64, unison: usize, shared: &V::Shared) {
        if self.depth < STACK {
            self.held[self.depth] = HeldNote {id: event.id as i32, frequency};
            self.depth += 1;
        }
        if self.active && self.voice.gate() {
            self.voice.start_glide(frequency, glide_duration); // legato: glide, no retrigger
            return;
        }
        // (re)start: glide from the dying voice's pitch when there was one, else start straight on the note.
        let from = if self.active {Some(self.voice.current_frequency())} else {None};
        self.voice.force_stop();
        self.voice.start(event, from.unwrap_or(frequency), gain, 0.0, unison, shared);
        if from.is_some() {
            self.voice.start_glide(frequency, glide_duration);
        }
        self.active = true;
    }

    fn stop(&mut self, note_id: i32, glide_duration: f64) {
        let Some(position) = self.held[..self.depth].iter().position(|note| note.id == note_id) else {
            return;
        };
        let was_top = position == self.depth - 1;
        for index in position..self.depth - 1 {
            self.held[index] = self.held[index + 1];
        }
        self.depth -= 1;
        if self.depth == 0 {
            if self.active {
                self.voice.stop();
            }
        } else if was_top {
            self.voice.start_glide(self.held[self.depth - 1].frequency, glide_duration);
        }
    }

    fn force_stop(&mut self) {
        self.voice.force_stop();
        self.depth = 0;
    }

    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &V::Shared) -> bool {
        if self.active && self.voice.process(output, block, shared) {
            self.active = false;
        }
        !self.active
    }

    fn reset(&mut self) {
        self.voice.force_stop();
        self.active = false;
        self.depth = 0;
    }
}

/// The voicing mode a synth switches between at runtime, mirroring the TS `VoicingMode` enum (Monophonic = 0,
/// Polyphonic = 1). Monophonic is the zero discriminant, so a zeroed device state defaults to monophonic.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum VoicingMode {
    #[default]
    Monophonic,
    Polyphonic
}

impl VoicingMode {
    /// The mode at `index` (1 = polyphonic, anything else monophonic), for a device's integer mode parameter.
    pub fn from_index(index: i32) -> Self {
        match index {
            1 => VoicingMode::Polyphonic,
            _ => VoicingMode::Monophonic
        }
    }
}

/// The runtime voicing dispatcher (a heap-free port of TS `Voicing`): owns BOTH strategies in the device's
/// zeroed state and a `mode` selecting the active one. New notes route to the active strategy; on a mode switch
/// the outgoing strategy is force-stopped and keeps decaying (both strategies are processed every chunk), the
/// heap-free equivalent of the TS expiring-strategy list. `VOICES` is the polyphonic voice count, `STACK` the
/// monophonic held-note depth.
pub struct Voicing<V, const VOICES: usize, const STACK: usize> {
    polyphonic: PolyphonicStrategy<V, VOICES>,
    monophonic: MonophonicStrategy<V, STACK>,
    mode: VoicingMode
}

impl<V: Voice + Default, const VOICES: usize, const STACK: usize> Default for Voicing<V, VOICES, STACK> {
    fn default() -> Self {
        Self {polyphonic: PolyphonicStrategy::new(), monophonic: MonophonicStrategy::new(), mode: VoicingMode::default()}
    }
}

impl<V: Voice + Default, const VOICES: usize, const STACK: usize> Voicing<V, VOICES, STACK> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mode(&self) -> VoicingMode {
        self.mode
    }

    /// Switch the active strategy. The outgoing strategy is force-stopped (its voices decay out on the
    /// following chunks); a no-op when already in `mode`.
    pub fn set_mode(&mut self, mode: VoicingMode) {
        if mode == self.mode {
            return;
        }
        match self.mode {
            VoicingMode::Polyphonic => self.polyphonic.force_stop(),
            VoicingMode::Monophonic => self.monophonic.force_stop()
        }
        self.mode = mode;
    }

    /// Route a note-on to the active strategy (see [`VoicingStrategy::start`] for the parameters).
    pub fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, glide_duration: f64, unison: usize, shared: &V::Shared) {
        match self.mode {
            VoicingMode::Polyphonic => self.polyphonic.start(event, frequency, gain, glide_duration, unison, shared),
            VoicingMode::Monophonic => self.monophonic.start(event, frequency, gain, glide_duration, unison, shared)
        }
    }

    /// Route a note-off to the active strategy.
    pub fn stop(&mut self, note_id: i32, glide_duration: f64) {
        match self.mode {
            VoicingMode::Polyphonic => self.polyphonic.stop(note_id, glide_duration),
            VoicingMode::Monophonic => self.monophonic.stop(note_id, glide_duration)
        }
    }

    /// Render both strategies additively into `output`, the active one plus any decaying outgoing voices.
    pub fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &V::Shared) {
        let [out_left, out_right] = output;
        self.polyphonic.process([&mut *out_left, &mut *out_right], block, shared);
        self.monophonic.process([&mut *out_left, &mut *out_right], block, shared);
    }

    /// Clear both strategies immediately (a transport stop).
    pub fn reset(&mut self) {
        self.polyphonic.reset();
        self.monophonic.reset();
    }

    /// Visit the ACTIVE strategy's sounding voices (TS `strategy.processing()`), for telemetry (e.g. the
    /// Vaporisateur's per-voice envelope playheads).
    pub fn for_each_active(&self, visit: &mut dyn FnMut(&V)) {
        match self.mode {
            VoicingMode::Polyphonic => {
                for slot in &self.polyphonic.slots {
                    if slot.active {
                        visit(&slot.voice);
                    }
                }
            }
            VoicingMode::Monophonic => {
                if self.monophonic.active {
                    visit(&self.monophonic.voice);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MonophonicStrategy, Voice, VoiceUnison, Voicing, VoicingMode, VoicingStrategy, PolyphonicStrategy};
    use abi::{Block, BlockFlags, EventRecord, EVENT_NOTE_ON};

    // A deterministic mock voice: it outputs its gain while gated, then fades over MOCK_RELEASE chunks once
    // released, reporting finished when the fade completes (or immediately when force-stopped).
    const MOCK_RELEASE: i32 = 4;

    #[derive(Default)]
    struct MockVoice {
        gain: f32,
        gated: bool,
        release: i32
    }

    impl Voice for MockVoice {
        type Shared = ();
        fn start(&mut self, _event: &EventRecord, _frequency: f32, gain: f32, _spread: f32, _unison: usize, _shared: &()) {
            self.gain = gain;
            self.gated = true;
            self.release = MOCK_RELEASE;
        }
        fn stop(&mut self) {
            self.gated = false;
        }
        fn force_stop(&mut self) {
            self.gated = false;
            self.release = 0;
        }
        fn start_glide(&mut self, _target_frequency: f32, _glide_duration: f64) {}
        fn gate(&self) -> bool {
            self.gated
        }
        fn current_frequency(&self) -> f32 {
            0.0
        }
        fn process(&mut self, output: [&mut [f32]; 2], _block: &Block, _shared: &()) -> bool {
            let [left, right] = output;
            if !self.gated && self.release > 0 {
                self.release -= 1;
            }
            let level = if self.gated {self.gain} else {self.gain * self.release as f32 / MOCK_RELEASE as f32};
            for index in 0..left.len() {
                left[index] += level;
                right[index] += level;
            }
            !self.gated && self.release == 0
        }
    }

    fn note(id: u32) -> EventRecord {
        EventRecord {position: 0.0, offset: 0, kind: EVENT_NOTE_ON, id, pitch: 60, velocity: 0.8, cent: 0.0, duration: 0.0}
    }

    fn block() -> Block {
        Block {index: 0, flags: BlockFlags(0), p0: 0.0, p1: 0.0, s0: 0, s1: 8, bpm: 120.0}
    }

    fn render(voicing: &mut PolyphonicStrategy<MockVoice, 4>) -> [f32; 8] {
        let (mut left, mut right) = ([0.0f32; 8], [0.0f32; 8]);
        voicing.process([&mut left, &mut right], &block(), &());
        left
    }

    #[test]
    fn a_note_on_sounds_on_a_free_slot() {
        let mut voicing = PolyphonicStrategy::<MockVoice, 4>::new();
        voicing.start(&note(1), 440.0, 0.8, 0.0, 1, &());
        assert_eq!(voicing.active_count(), 1);
        assert!(render(&mut voicing)[0] > 0.0, "the voice is sounding");
    }

    #[test]
    fn multiple_notes_take_multiple_slots() {
        let mut voicing = PolyphonicStrategy::<MockVoice, 4>::new();
        voicing.start(&note(1), 440.0, 0.5, 0.0, 1, &());
        voicing.start(&note(2), 550.0, 0.5, 0.0, 1, &());
        voicing.start(&note(3), 660.0, 0.5, 0.0, 1, &());
        assert_eq!(voicing.active_count(), 3);
        assert!((render(&mut voicing)[0] - 1.5).abs() < 1.0e-6, "three voices sum");
    }

    #[test]
    fn a_released_note_decays_then_frees_its_slot() {
        let mut voicing = PolyphonicStrategy::<MockVoice, 4>::new();
        voicing.start(&note(1), 440.0, 0.8, 0.0, 1, &());
        voicing.stop(1, 0.0);
        assert_eq!(voicing.active_count(), 1, "still sounding through the release");
        for _ in 0..MOCK_RELEASE {
            render(&mut voicing);
        }
        assert_eq!(voicing.active_count(), 0, "the slot is freed once the release completes");
    }

    #[test]
    fn a_full_pool_steals_a_released_voice() {
        let mut voicing = PolyphonicStrategy::<MockVoice, 4>::new();
        for id in 0..4 {
            voicing.start(&note(id), 440.0, 0.5, 0.0, 1, &());
        }
        assert_eq!(voicing.active_count(), 4, "the pool is full");
        voicing.stop(0, 0.0); // release one (still active, but un-gated)
        voicing.start(&note(99), 880.0, 0.5, 0.0, 1, &()); // no free slot -> steals the released one
        assert_eq!(voicing.active_count(), 4, "stays at capacity, no allocation");
    }

    #[test]
    fn reset_frees_every_slot() {
        let mut voicing = PolyphonicStrategy::<MockVoice, 4>::new();
        voicing.start(&note(1), 440.0, 0.5, 0.0, 1, &());
        voicing.start(&note(2), 550.0, 0.5, 0.0, 1, &());
        voicing.reset();
        assert_eq!(voicing.active_count(), 0);
    }

    // ---- VoiceUnison ----

    // A voice whose output IS the spread it was started with, so a unison's summed output reveals how it fans
    // the spreads across its sub-voices.
    #[derive(Default)]
    struct SpreadMock {
        spread: f32,
        gated: bool
    }

    impl Voice for SpreadMock {
        type Shared = ();
        fn start(&mut self, _event: &EventRecord, _frequency: f32, _gain: f32, spread: f32, _unison: usize, _shared: &()) {
            self.spread = spread;
            self.gated = true;
        }
        fn stop(&mut self) {self.gated = false;}
        fn force_stop(&mut self) {self.gated = false; self.spread = 0.0;}
        fn start_glide(&mut self, _target_frequency: f32, _glide_duration: f64) {}
        fn gate(&self) -> bool {self.gated}
        fn current_frequency(&self) -> f32 {0.0}
        fn process(&mut self, output: [&mut [f32]; 2], _block: &Block, _shared: &()) -> bool {
            let [left, right] = output;
            for index in 0..left.len() {
                left[index] += self.spread;
                right[index] += self.spread;
            }
            false
        }
    }

    fn first_sample<V: Voice<Shared = ()>>(voice: &mut V) -> f32 {
        let (mut left, mut right) = ([0.0f32; 4], [0.0f32; 4]);
        voice.process([&mut left, &mut right], &block(), &());
        left[0]
    }

    #[test]
    fn unison_energy_normalises_the_gain() {
        let mut single = VoiceUnison::<MockVoice, 5>::default();
        single.start(&note(1), 440.0, 0.9, 0.0, 1, &());
        assert!((first_sample(&mut single) - 0.9).abs() < 1.0e-6, "one voice keeps the gain");
        let mut triple = VoiceUnison::<MockVoice, 5>::default();
        triple.start(&note(1), 440.0, 0.9, 0.0, 3, &());
        // three voices each at 0.9/sqrt(3) sum to 0.9*sqrt(3) (constant power, not 3x louder).
        assert!((first_sample(&mut triple) - 0.9 * libm::sqrtf(3.0)).abs() < 1.0e-4);
    }

    #[test]
    fn unison_fans_the_spread_symmetrically() {
        let mut centred = VoiceUnison::<SpreadMock, 5>::default();
        centred.start(&note(1), 440.0, 1.0, 0.0, 3, &());
        assert!(first_sample(&mut centred).abs() < 1.0e-6, "spreads -1, 0, +1 sum to 0 around centre");
        let mut biased = VoiceUnison::<SpreadMock, 5>::default();
        biased.start(&note(1), 440.0, 1.0, 0.5, 3, &());
        // spreads (1-0.5)*[-1,0,1] + 0.5 = [0, 0.5, 1.0], summing to 1.5.
        assert!((first_sample(&mut biased) - 1.5).abs() < 1.0e-5);
    }

    #[test]
    fn unison_clamps_the_count_and_finishes_together() {
        let mut unison = VoiceUnison::<MockVoice, 3>::default();
        unison.start(&note(1), 440.0, 1.0, 0.0, 9, &()); // 9 clamped to the max of 3
        assert!(unison.gate());
        unison.force_stop();
        assert!(!unison.gate());
        assert!(unison.process([&mut [0.0; 4], &mut [0.0; 4]], &block(), &()), "all sub-voices finished");
    }

    // ---- MonophonicStrategy ----

    // A voice that exposes its current frequency: start sets it, a glide jumps it to the target (so a test can
    // read where the mono voice ended up), and it fades like MockVoice once released.
    #[derive(Default)]
    struct FreqMock {
        current: f32,
        gated: bool,
        release: i32
    }

    impl Voice for FreqMock {
        type Shared = ();
        fn start(&mut self, _event: &EventRecord, frequency: f32, _gain: f32, _spread: f32, _unison: usize, _shared: &()) {
            self.current = frequency;
            self.gated = true;
            self.release = MOCK_RELEASE;
        }
        fn stop(&mut self) {self.gated = false;}
        fn force_stop(&mut self) {self.gated = false; self.release = 0;}
        fn start_glide(&mut self, target_frequency: f32, _glide_duration: f64) {self.current = target_frequency;}
        fn gate(&self) -> bool {self.gated}
        fn current_frequency(&self) -> f32 {self.current}
        fn process(&mut self, output: [&mut [f32]; 2], _block: &Block, _shared: &()) -> bool {
            let [left, right] = output;
            if !self.gated && self.release > 0 {
                self.release -= 1;
            }
            for index in 0..left.len() {
                left[index] += if self.gated || self.release > 0 {1.0} else {0.0};
            }
            let _ = right;
            !self.gated && self.release == 0
        }
    }

    const GLIDE: f64 = 480.0;

    #[test]
    fn mono_legato_glides_without_retrigger() {
        let mut mono = MonophonicStrategy::<FreqMock, 8>::new();
        mono.start(&note(1), 100.0, 0.8, GLIDE, 1, &());
        assert!((mono.current_frequency() - 100.0).abs() < 1.0e-6);
        mono.start(&note(2), 200.0, 0.8, GLIDE, 1, &()); // key 1 still held -> glide, no new attack
        assert!((mono.current_frequency() - 200.0).abs() < 1.0e-6, "glided to the new note");
        assert!(mono.is_active());
    }

    #[test]
    fn mono_release_top_glides_back_to_the_held_note() {
        let mut mono = MonophonicStrategy::<FreqMock, 8>::new();
        mono.start(&note(1), 100.0, 0.8, GLIDE, 1, &());
        mono.start(&note(2), 200.0, 0.8, GLIDE, 1, &());
        mono.stop(2, GLIDE); // release the top; key 1 still held
        assert!((mono.current_frequency() - 100.0).abs() < 1.0e-6, "glides back to the lower held note");
        assert!(mono.is_active());
    }

    #[test]
    fn mono_releasing_the_last_note_lets_the_voice_decay() {
        let mut mono = MonophonicStrategy::<FreqMock, 8>::new();
        mono.start(&note(1), 100.0, 0.8, GLIDE, 1, &());
        mono.stop(1, GLIDE); // last key up -> release
        for _ in 0..MOCK_RELEASE {
            mono.process([&mut [0.0; 4], &mut [0.0; 4]], &block(), &());
        }
        assert!(!mono.is_active(), "the voice decayed and freed");
    }

    #[test]
    fn mono_retriggers_from_a_releasing_voice() {
        let mut mono = MonophonicStrategy::<FreqMock, 8>::new();
        mono.start(&note(1), 100.0, 0.8, GLIDE, 1, &());
        mono.stop(1, GLIDE); // releasing (gate off, not yet finished)
        mono.start(&note(3), 300.0, 0.8, GLIDE, 1, &()); // a new note re-triggers, gliding from the dying pitch to 300
        assert!((mono.current_frequency() - 300.0).abs() < 1.0e-6);
        assert!(mono.is_active());
    }

    #[test]
    fn mono_unison_glides_back_through_a_chord() {
        // A unison voice on a monophonic stack: three notes start (a held chord glides up), then release from
        // the top, and the voice should glide BACK down the still-held notes (the project.od behaviour). This
        // checks the glide-back survives the VoiceUnison wrapper, not just a bare voice.
        let mut mono = MonophonicStrategy::<VoiceUnison<FreqMock, 3>, 8>::new();
        mono.start(&note(1), 100.0, 1.0, GLIDE, 3, &());
        mono.start(&note(2), 200.0, 1.0, GLIDE, 3, &());
        mono.start(&note(3), 300.0, 1.0, GLIDE, 3, &());
        assert!((mono.current_frequency() - 300.0).abs() < 1.0e-6, "voice sits at the top of the chord");
        mono.stop(3, GLIDE);
        assert!((mono.current_frequency() - 200.0).abs() < 1.0e-6, "releasing the top glides back to the held note");
        mono.stop(2, GLIDE);
        assert!((mono.current_frequency() - 100.0).abs() < 1.0e-6, "and back again to the lowest held note");
        assert!(mono.is_active(), "still sounding while the last note is held");
        mono.stop(1, GLIDE);
    }

    // ---- Voicing dispatcher ----

    fn dispatch_render(voicing: &mut Voicing<MockVoice, 4, 8>) -> f32 {
        let (mut left, mut right) = ([0.0f32; 8], [0.0f32; 8]);
        voicing.process([&mut left, &mut right], &block(), &());
        left[0]
    }

    #[test]
    fn dispatcher_defaults_to_monophonic_and_routes_one_voice() {
        let mut voicing = Voicing::<MockVoice, 4, 8>::new();
        assert_eq!(voicing.mode(), VoicingMode::Monophonic);
        voicing.start(&note(1), 440.0, 0.5, 0.0, 1, &());
        voicing.start(&note(2), 550.0, 0.5, 0.0, 1, &()); // legato onto the same single voice
        assert!((dispatch_render(&mut voicing) - 0.5).abs() < 1.0e-6, "monophonic sounds one voice");
    }

    #[test]
    fn dispatcher_polyphonic_sums_independent_voices() {
        let mut voicing = Voicing::<MockVoice, 4, 8>::new();
        voicing.set_mode(VoicingMode::Polyphonic);
        voicing.start(&note(1), 440.0, 0.5, 0.0, 1, &());
        voicing.start(&note(2), 550.0, 0.5, 0.0, 1, &());
        assert!((dispatch_render(&mut voicing) - 1.0).abs() < 1.0e-6, "two polyphonic voices sum");
    }

    #[test]
    fn dispatcher_switch_cuts_the_outgoing_strategy() {
        let mut voicing = Voicing::<MockVoice, 4, 8>::new();
        voicing.set_mode(VoicingMode::Polyphonic);
        voicing.start(&note(1), 440.0, 0.5, 0.0, 1, &());
        voicing.set_mode(VoicingMode::Monophonic); // force-stops the polyphonic voice
        assert!(dispatch_render(&mut voicing).abs() < 1.0e-6, "the cut voice is silent");
        voicing.start(&note(2), 550.0, 0.5, 0.0, 1, &()); // a fresh monophonic note now sounds
        assert!((dispatch_render(&mut voicing) - 0.5).abs() < 1.0e-6);
    }
}

//! Legacy-Nano rendering parity. The ORACLE below is a frozen, verbatim copy of the original Nano (one sample,
//! a volume `[10]` and a release `[20]` parameter, a fixed 3 ms attack, a 64-voice pool, parameters read live
//! every block). Every scenario drives the device through its real path (`init` -> parameter / sample
//! catch-up -> event dispatch -> render) and the oracle through the identical block / event schedule, and
//! demands BIT-EXACT output. Whatever Nano becomes, a project saved with the legacy Nano must sound the same.
//!
//! The device is only ever pushed the legacy schema's two fields. A legacy project stores nothing else, so
//! every other parameter a later Nano grows must default to the legacy behaviour (3 ms attack, root key 60,
//! the whole sample, forward, no loop).

use abi::{EventRecord, Instrument, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_nano::{render, Nano, NanoState};
use math::db_to_gain;
use math::value_mapping::{Decibel, Exponential};

const BLOCK: usize = 128;
const SR: f32 = 48_000.0;
const VOLUME_PATH: [u16; 1] = [10];
const RELEASE_PATH: [u16; 1] = [20];

// ---- the frozen legacy Nano ----

const LEGACY_ATTACK_SECONDS: f32 = 0.003;
const LEGACY_MAX_VOICES: usize = 64;
const LEGACY_VOLUME_MAPPING: Decibel = Decibel::default_volume();
const LEGACY_RELEASE_MAPPING: Exponential = Exponential {min: 0.001, max: 8.0};

#[derive(Clone, Copy, Default)]
struct LegacyVoice {
    active: bool,
    id: u32,
    speed: f32,
    velocity: f32,
    position: f64,
    attack: u32,
    env_position: u32,
    decay_position: u32,
    releasing: bool
}

impl LegacyVoice {
    fn start(&mut self, id: u32, pitch: u32, cent: f32, velocity: f32, sample_rate: f32) {
        self.active = true;
        self.id = id;
        self.speed = libm::exp2f((pitch as f32 + cent / 100.0) / 12.0 - 5.0);
        self.velocity = velocity;
        self.position = 0.0;
        self.attack = (LEGACY_ATTACK_SECONDS * sample_rate) as u32;
        self.env_position = 0;
        self.decay_position = 0;
        self.releasing = false;
    }

    fn stop(&mut self) {
        self.releasing = true;
        self.decay_position = self.env_position;
    }

    fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32], left: &[f32], right: &[f32], rate_ratio: f64, gain: f32, release: u32) -> bool {
        let num_frames = left.len();
        if num_frames < 2 {
            return true;
        }
        let release = release.max(1);
        let release_inverse = 1.0 / release as f32;
        let gain = gain * self.velocity;
        for index in 0..out_left.len() {
            let int_position = self.position as usize;
            if int_position >= num_frames - 1 {
                return true;
            }
            let frac = (self.position - int_position as f64) as f32;
            let att = if self.env_position < self.attack {self.env_position as f32 / self.attack as f32} else {1.0};
            let release_factor = if self.releasing {
                (1.0 - (self.env_position - self.decay_position) as f32 * release_inverse).min(1.0)
            } else {
                1.0
            };
            let shaped = release_factor * att;
            let env = shaped * shaped;
            let sample_left = left[int_position] * (1.0 - frac) + left[int_position + 1] * frac;
            let sample_right = right[int_position] * (1.0 - frac) + right[int_position + 1] * frac;
            out_left[index] += sample_left * gain * env;
            out_right[index] += sample_right * gain * env;
            self.position += self.speed as f64 * rate_ratio;
            self.env_position += 1;
            if self.releasing && self.env_position - self.decay_position > release {
                return true;
            }
        }
        false
    }
}

#[derive(Clone, Copy)]
struct Sample {
    handle: u32,
    left: &'static [f32],
    right: &'static [f32],
    sample_rate: f32
}

struct LegacyNano {
    voices: [LegacyVoice; LEGACY_MAX_VOICES],
    gain: f32,
    release: u32,
    sample_rate: f32,
    sample: Option<Sample>
}

impl LegacyNano {
    fn new(sample_rate: f32) -> Self {
        Self {voices: [LegacyVoice::default(); LEGACY_MAX_VOICES], gain: 1.0, release: sample_rate as u32, sample_rate, sample: None}
    }

    fn set_volume(&mut self, value: ParamValue) {
        self.gain = db_to_gain(abi::float_value(value, &LEGACY_VOLUME_MAPPING));
    }

    fn set_release(&mut self, value: ParamValue) {
        self.release = (abi::float_value(value, &LEGACY_RELEASE_MAPPING) * self.sample_rate) as u32;
    }

    fn handle_event(&mut self, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let sample_rate = self.sample_rate;
            if let Some(slot) = self.voices.iter_mut().find(|voice| !voice.active) {
                slot.start(event.id, event.pitch, event.cent, event.velocity, sample_rate);
            }
        } else if let Some(voice) = self.voices.iter_mut().find(|voice| voice.active && voice.id == event.id) {
            voice.stop();
        }
    }

    fn process_audio(&mut self, out_left: &mut [f32], out_right: &mut [f32]) {
        let Some(sample) = self.sample else {
            for voice in self.voices.iter_mut() {
                voice.active = false;
            }
            return;
        };
        let rate_ratio = sample.sample_rate as f64 / self.sample_rate as f64;
        let (gain, release) = (self.gain, self.release);
        for voice in self.voices.iter_mut() {
            if voice.active && voice.process(out_left, out_right, sample.left, sample.right, rate_ratio, gain, release) {
                voice.active = false;
            }
        }
    }

    fn reset(&mut self) {
        for voice in self.voices.iter_mut() {
            voice.active = false;
        }
    }

    // the same chunking the SDK's dispatch_range applies: render up to each event, apply it, continue
    fn render(&mut self, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32]) {
        out_left.fill(0.0);
        out_right.fill(0.0);
        let frames = out_left.len();
        let mut cursor = 0usize;
        for event in events {
            let offset = (event.offset as usize).min(frames);
            if offset > cursor {
                self.process_audio(&mut out_left[cursor..offset], &mut out_right[cursor..offset]);
                cursor = offset;
            }
            self.handle_event(event);
        }
        if cursor < frames {
            self.process_audio(&mut out_left[cursor..], &mut out_right[cursor..]);
        }
    }
}

// ---- test material ----

fn register(handle: u32, planes: &[Vec<f32>], sample_rate: f32) -> Sample {
    let frames = planes[0].len();
    let planar: &'static [f32] = Box::leak(planes.concat().into_boxed_slice());
    abi::set_native_sample(handle, planar, planes.len() as u32, sample_rate);
    let left = &planar[..frames];
    let right = if planes.len() > 1 {&planar[frames..2 * frames]} else {left};
    Sample {handle, left, right, sample_rate}
}

// A decaying three-partial tone with seeded noise: enough spectral content that any read-head or envelope
// drift shows up as a sample difference.
fn tone(frames: usize, sample_rate: f32, seed: u32) -> Vec<f32> {
    let mut lcg = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    (0..frames).map(|index| {
        lcg = lcg.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let noise = (lcg >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
        let time = index as f32 / sample_rate;
        let decay = libm::expf(-time * 1.5);
        let partials = libm::sinf(2.0 * math::PI * 220.0 * time)
            + 0.5 * libm::sinf(2.0 * math::PI * 331.0 * time + 0.3)
            + 0.25 * libm::sinf(2.0 * math::PI * 887.0 * time + 1.1);
        (partials * 0.5 + noise * 0.05) * decay
    }).collect()
}

fn dc(frames: usize) -> Vec<f32> {
    vec![1.0f32; frames]
}

fn peak(buffer: &[f32]) -> f32 {
    buffer.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
}

fn note_on(id: u32, offset: u32, pitch: u32, cent: f32, velocity: f32) -> EventRecord {
    EventRecord {position: 0.0, offset, kind: EVENT_NOTE_ON, id, pitch, velocity, cent, duration: 0.0}
}

fn note_off(id: u32, offset: u32) -> EventRecord {
    EventRecord {position: 0.0, offset, kind: EVENT_NOTE_OFF, id, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn assert_identical(label: &str, actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len(), "{label}: length");
    if let Some(index) = (0..actual.len()).find(|index| actual[*index].to_bits() != expected[*index].to_bits()) {
        panic!("{label}: frame {index} differs, device {} vs legacy {} (|diff| {})",
               actual[index], expected[index], (actual[index] - expected[index]).abs());
    }
}

/// The device and the oracle side by side, fed the same catch-up, events and blocks.
struct Rig {
    state: NanoState,
    oracle: LegacyNano,
    sample_rate: f32,
    pending: Vec<EventRecord>,
    blocks_rendered: usize
}

struct Rendered {
    left: Vec<f32>,
    right: Vec<f32>
}

impl Rig {
    // mirrors the engine: init, then the schema defaults of the legacy fields, then the sample catch-up
    fn new(sample: Sample, sample_rate: f32) -> Self {
        let mut state: NanoState = unsafe {core::mem::zeroed()};
        Nano::init(&mut state, sample_rate);
        let mut rig = Self {state, oracle: LegacyNano::new(sample_rate), sample_rate, pending: Vec::new(), blocks_rendered: 0};
        rig.set(&VOLUME_PATH, ParamValue::Float(-3.0));
        rig.set(&RELEASE_PATH, ParamValue::Float(0.1));
        rig.bind(sample);
        rig
    }

    fn set(&mut self, path: &[u16], value: ParamValue) {
        Nano::parameter_changed(&mut self.state, abi::native_parameter_id(path), value);
        match path {
            [10] => self.oracle.set_volume(value),
            [20] => self.oracle.set_release(value),
            _ => panic!("no legacy parameter at {path:?}")
        }
    }

    fn bind(&mut self, sample: Sample) {
        Nano::sample_changed(&mut self.state, abi::observe_sample(&[15]), Some(sample.handle));
        self.oracle.sample = Some(sample);
    }

    fn unbind(&mut self) {
        Nano::sample_changed(&mut self.state, abi::observe_sample(&[15]), None);
        self.oracle.sample = None;
    }

    fn reset(&mut self) {
        Nano::reset(&mut self.state);
        self.oracle.reset();
    }

    fn event(&mut self, event: EventRecord) {
        self.pending.push(event);
    }

    fn take_events(&mut self) -> Vec<EventRecord> {
        let mut events = core::mem::take(&mut self.pending);
        events.sort_by_key(|event| (event.offset, if event.kind == EVENT_NOTE_ON {1} else {0}));
        events
    }

    fn render_block(&mut self, events: &[EventRecord], frames: usize) -> Rendered {
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let (mut legacy_left, mut legacy_right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        render(&mut self.state, events, &mut left, &mut right, self.sample_rate);
        self.oracle.render(events, &mut legacy_left, &mut legacy_right);
        let label = format!("block {} ({frames} frames, {} events)", self.blocks_rendered, events.len());
        assert_identical(&format!("{label} left"), &left, &legacy_left);
        assert_identical(&format!("{label} right"), &right, &legacy_right);
        self.blocks_rendered += 1;
        Rendered {left, right}
    }

    /// Render `count` blocks of `frames`; the pending events land in the first one.
    fn render_blocks(&mut self, count: usize, frames: usize) -> Rendered {
        let mut out = Rendered {left: Vec::new(), right: Vec::new()};
        let events = self.take_events();
        for index in 0..count {
            let block = self.render_block(if index == 0 {&events} else {&[]}, frames);
            out.left.extend_from_slice(&block.left);
            out.right.extend_from_slice(&block.right);
        }
        out
    }

    /// Render a schedule of (absolute frame, event) over the given block partition.
    fn render_schedule(&mut self, schedule: &[(usize, EventRecord)], partition: &[usize]) -> Rendered {
        let mut out = Rendered {left: Vec::new(), right: Vec::new()};
        let mut start = 0usize;
        for frames in partition {
            let end = start + frames;
            let mut events: Vec<EventRecord> = schedule.iter()
                .filter(|(frame, _)| (start..end).contains(frame))
                .map(|(frame, event)| EventRecord {offset: (frame - start) as u32, ..*event})
                .collect();
            events.sort_by_key(|event| (event.offset, if event.kind == EVENT_NOTE_ON {1} else {0}));
            let block = self.render_block(&events, *frames);
            out.left.extend_from_slice(&block.left);
            out.right.extend_from_slice(&block.right);
            start = end;
        }
        out
    }
}

// ---- scenarios ----

#[test]
fn one_note_at_the_native_rate_matches_frame_for_frame() {
    let sample = register(1, &[tone(48_000, SR, 1)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    let held = rig.render_blocks(150, BLOCK);
    assert!(peak(&held.left) > 0.1, "the note sounds");
    rig.event(note_off(1, 40));
    let tail = rig.render_blocks(80, BLOCK);
    assert!(peak(&tail.left[..4_000]) > 0.0, "the release still sounds");
    assert_eq!(peak(&tail.left[5_000..]), 0.0, "silent once the 100 ms release elapsed");
}

#[test]
fn transposed_notes_with_cents_and_velocities_land_sample_accurately() {
    let sample = register(2, &[tone(48_000, SR, 2)], SR);
    let mut rig = Rig::new(sample, SR);
    let notes: [(u32, u32, f32, f32, u32); 7] = [
        (1, 48, 0.0, 1.0, 13), (2, 55, -37.0, 0.7, 77), (3, 67, 12.5, 0.4, 127), (4, 72, 0.0, 1.0, 0),
        (5, 84, 99.0, 0.9, 64), (6, 36, -50.0, 0.6, 1), (7, 60, 0.0, 0.0, 30)
    ];
    for (id, pitch, cent, velocity, offset) in notes {
        rig.event(note_on(id, offset, pitch, cent, velocity));
        let block = rig.render_blocks(1, BLOCK);
        if id == 1 {
            assert_eq!(peak(&block.left[..offset as usize]), 0.0, "silent before the first onset");
            assert!(peak(&block.left[offset as usize..]) > 0.0, "sounding from the onset");
        }
        rig.render_blocks(19, BLOCK);
    }
    for (id, _, _, _, offset) in notes {
        rig.event(note_off(id, (offset * 3) % BLOCK as u32));
        rig.render_blocks(10, BLOCK);
    }
    let tail = rig.render_blocks(60, BLOCK);
    assert_eq!(peak(&tail.left[6_000..]), 0.0, "everything released");
}

#[test]
fn an_eight_voice_chord_sums_identically() {
    let sample = register(3, &[tone(48_000, SR, 3)], SR);
    let mut rig = Rig::new(sample, SR);
    let pitches = [48u32, 52, 55, 59, 60, 64, 67, 71];
    for (index, pitch) in pitches.iter().enumerate() {
        rig.event(note_on(index as u32, 0, *pitch, 0.0, 0.3 + index as f32 * 0.1));
    }
    let held = rig.render_blocks(100, BLOCK);
    assert!(peak(&held.left) > 0.5, "eight voices sum loud");
    for (index, _) in pitches.iter().enumerate() {
        rig.event(note_off(index as u32, (index as u32 * 17) % BLOCK as u32));
        rig.render_blocks(5, BLOCK);
    }
    rig.render_blocks(60, BLOCK);
}

#[test]
fn a_stereo_sample_keeps_its_channels_apart() {
    let sample = register(4, &[tone(24_000, SR, 4), tone(24_000, SR, 5)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    let held = rig.render_blocks(100, BLOCK);
    assert!(held.left != held.right, "left and right carry their own plane");
    rig.event(note_off(1, 0));
    rig.render_blocks(60, BLOCK);
}

#[test]
fn a_sample_rate_mismatch_resamples_identically() {
    for (handle, sample_rate, engine_rate) in [(5u32, 44_100.0f32, 48_000.0f32), (6, 48_000.0, 44_100.0), (7, 22_050.0, 48_000.0), (8, 96_000.0, 48_000.0)] {
        let sample = register(handle, &[tone(sample_rate as usize, sample_rate, handle)], sample_rate);
        let mut rig = Rig::new(sample, engine_rate);
        rig.event(note_on(1, 5, 60, 0.0, 1.0));
        rig.event(note_on(2, 70, 67, 20.0, 0.8));
        let held = rig.render_blocks(120, BLOCK);
        assert!(peak(&held.left) > 0.1, "sounds at {sample_rate} Hz in a {engine_rate} Hz engine");
        rig.event(note_off(1, 3));
        rig.event(note_off(2, 90));
        rig.render_blocks(80, BLOCK);
    }
}

#[test]
fn the_release_is_honoured_as_a_real_value_and_as_automation() {
    let sample = register(9, &[tone(48_000, SR, 9)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.set(&RELEASE_PATH, ParamValue::Float(0.02));
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    rig.render_blocks(40, BLOCK);
    rig.event(note_off(1, 0));
    let tail = rig.render_blocks(20, BLOCK);
    assert!(peak(&tail.left[..900]) > 0.0, "20 ms of release");
    assert_eq!(peak(&tail.left[1_000..]), 0.0, "gone after 20 ms");
    rig.set(&RELEASE_PATH, ParamValue::Unit(0.3));
    rig.event(note_on(2, 0, 60, 0.0, 1.0));
    rig.render_blocks(40, BLOCK);
    rig.event(note_off(2, 0));
    let tail = rig.render_blocks(20, BLOCK);
    assert!(peak(&tail.left[..700]) > 0.0, "the mapped automation value releases over ~15 ms");
    assert_eq!(peak(&tail.left[800..]), 0.0, "and is gone after");
}

#[test]
fn the_volume_is_honoured_as_a_real_value_and_as_automation() {
    let sample = register(10, &[dc(48_000)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.set(&VOLUME_PATH, ParamValue::Float(-12.0));
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    let quiet = rig.render_blocks(10, BLOCK);
    assert!((peak(&quiet.left) - db_to_gain(-12.0)).abs() < 1.0e-6, "-12 dB on a DC sample");
    rig.reset();
    rig.set(&VOLUME_PATH, ParamValue::Unit(1.0));
    rig.event(note_on(2, 0, 60, 0.0, 1.0));
    let loud = rig.render_blocks(10, BLOCK);
    assert!(peak(&loud.left) > peak(&quiet.left), "unit 1.0 maps above -12 dB");
}

#[test]
fn a_release_change_while_a_note_holds_applies_live() {
    let sample = register(11, &[tone(96_000, SR, 11)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    rig.render_blocks(50, BLOCK);
    rig.set(&RELEASE_PATH, ParamValue::Float(2.0));
    rig.event(note_off(1, 0));
    let tail = rig.render_blocks(100, BLOCK);
    assert!(peak(&tail.left[12_000..]) > 0.0, "the 2 s release set AFTER note-on still sounds at 0.27 s");
    rig.reset();
    rig.event(note_on(2, 0, 60, 0.0, 1.0));
    rig.render_blocks(50, BLOCK);
    rig.set(&RELEASE_PATH, ParamValue::Float(0.01));
    rig.event(note_off(2, 0));
    let tail = rig.render_blocks(10, BLOCK);
    assert_eq!(peak(&tail.left[500..]), 0.0, "the 10 ms release set AFTER note-on cuts the tail");
}

#[test]
fn a_volume_change_while_a_note_holds_applies_live() {
    let sample = register(12, &[dc(48_000)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    let before = rig.render_blocks(10, BLOCK);
    rig.set(&VOLUME_PATH, ParamValue::Float(-40.0));
    let after = rig.render_blocks(10, BLOCK);
    assert!(peak(&after.left) < peak(&before.left) * 0.02, "the new volume applies on the next block");
}

// The ONE intentional divergence: the legacy voice kept the attack ramping through the release, so a note
// released inside its 3 ms attack swelled after note-off. The voice now decays from the level it reached.
#[test]
fn a_note_off_inside_the_attack_never_swells() {
    let sample = register(13, &[dc(48_000)], SR);
    let mut state: NanoState = unsafe {core::mem::zeroed()};
    Nano::init(&mut state, SR);
    Nano::parameter_changed(&mut state, abi::native_parameter_id(&VOLUME_PATH), ParamValue::Float(0.0));
    Nano::parameter_changed(&mut state, abi::native_parameter_id(&RELEASE_PATH), ParamValue::Float(0.1));
    Nano::sample_changed(&mut state, abi::observe_sample(&[15]), Some(sample.handle));
    let (mut left, mut right) = (vec![0.0f32; 4 * BLOCK], vec![0.0f32; 4 * BLOCK]);
    render(&mut state, &[note_on(1, 0, 60, 0.0, 1.0), note_off(1, 48)], &mut left, &mut right, SR);
    assert!(left[47] > 0.05, "the attack had started ({})", left[47]);
    assert!(left[48] > left[47] && left[48] - left[47] < 0.01, "the release starts one attack step above the last attack sample");
    assert!(left[49..].iter().all(|value| *value <= left[48]), "never louder than at note-off");
    assert!(left[300] < left[48], "decays from the reached level");
}

#[test]
fn the_sample_end_frees_the_voice() {
    let sample = register(14, &[tone(2_000, SR, 14)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    let out = rig.render_blocks(30, BLOCK);
    assert!(peak(&out.left[..1_990]) > 0.0, "plays the short sample");
    assert_eq!(peak(&out.left[1_999..]), 0.0, "silent past the last frame");
    rig.event(note_on(2, 0, 60, 0.0, 1.0));
    let again = rig.render_blocks(10, BLOCK);
    assert!(peak(&again.left) > 0.0, "a fresh note plays again");
}

#[test]
fn the_pool_caps_at_sixty_four_voices() {
    let sample = register(15, &[tone(48_000, SR, 15)], SR);
    let mut rig = Rig::new(sample, SR);
    for id in 0..70u32 {
        rig.event(note_on(id, 0, 40 + id, 0.0, 0.2));
    }
    rig.render_blocks(10, BLOCK);
    for id in 0..70u32 {
        rig.event(note_off(id, id % BLOCK as u32));
    }
    let tail = rig.render_blocks(60, BLOCK);
    assert_eq!(peak(&tail.left[6_000..]), 0.0, "every voice released");
}

#[test]
fn unbinding_the_sample_drops_the_voices() {
    let sample = register(16, &[tone(48_000, SR, 16)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    rig.render_blocks(20, BLOCK);
    rig.unbind();
    let silent = rig.render_blocks(20, BLOCK);
    assert_eq!(peak(&silent.left), 0.0, "silent without a sample");
    rig.bind(sample);
    let still = rig.render_blocks(20, BLOCK);
    assert_eq!(peak(&still.left), 0.0, "the dropped voice does not resume");
    rig.event(note_on(2, 0, 60, 0.0, 1.0));
    let fresh = rig.render_blocks(20, BLOCK);
    assert!(peak(&fresh.left) > 0.0, "a new note plays");
}

#[test]
fn a_note_before_any_sample_is_bound_is_dropped() {
    let sample = register(17, &[tone(48_000, SR, 17)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.unbind();
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    rig.render_blocks(10, BLOCK);
    rig.bind(sample);
    let still = rig.render_blocks(20, BLOCK);
    assert_eq!(peak(&still.left), 0.0, "the note played into no sample never sounds");
}

#[test]
fn reset_drops_every_voice() {
    let sample = register(18, &[tone(48_000, SR, 18)], SR);
    let mut rig = Rig::new(sample, SR);
    for id in 0..4u32 {
        rig.event(note_on(id, 0, 60 + id, 0.0, 1.0));
    }
    rig.render_blocks(20, BLOCK);
    rig.reset();
    let silent = rig.render_blocks(20, BLOCK);
    assert_eq!(peak(&silent.left), 0.0, "silent after a transport stop");
}

#[test]
fn the_render_is_block_size_independent() {
    let sample = register(19, &[tone(48_000, SR, 19)], SR);
    let schedule = [
        (0usize, note_on(1, 0, 60, 0.0, 1.0)), (1_000, note_on(2, 0, 67, -20.0, 0.7)), (2_345, note_off(1, 0)),
        (2_345, note_on(3, 0, 55, 0.0, 0.5)), (9_001, note_off(2, 0)), (12_000, note_off(3, 0))
    ];
    let total = 188 * BLOCK;
    let uniform: Vec<usize> = vec![BLOCK; total / BLOCK];
    let mut irregular = Vec::new();
    let mut sum = 0usize;
    for frames in [1usize, 37, 500, 64, 1_000, 3, 128, 999].iter().cycle() {
        let frames = (*frames).min(total - sum);
        irregular.push(frames);
        sum += frames;
        if sum == total {
            break;
        }
    }
    let mut first = Rig::new(sample, SR);
    let mut second = Rig::new(sample, SR);
    let a = first.render_schedule(&schedule, &uniform);
    let b = second.render_schedule(&schedule, &irregular);
    assert!(peak(&a.left) > 0.1, "the schedule sounds");
    assert_identical("irregular vs uniform blocks", &b.left, &a.left);
}

#[test]
fn a_duplicate_note_id_releases_only_the_first_voice() {
    let sample = register(20, &[tone(48_000, SR, 20)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    rig.event(note_on(1, 64, 67, 0.0, 1.0));
    rig.render_blocks(30, BLOCK);
    rig.event(note_off(1, 0));
    let tail = rig.render_blocks(60, BLOCK);
    assert!(peak(&tail.left[7_000..]) > 0.0, "the second voice keeps sounding");
}

#[test]
fn a_note_off_for_an_unknown_id_is_ignored() {
    let sample = register(21, &[tone(48_000, SR, 21)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 60, 0.0, 1.0));
    rig.event(note_off(99, 10));
    let held = rig.render_blocks(100, BLOCK);
    assert!(peak(&held.left[12_000..]) > 0.0, "still holding");
}

#[test]
fn a_long_note_keeps_read_head_precision() {
    let sample = register(22, &[tone(384_000, SR, 22)], SR);
    let mut rig = Rig::new(sample, SR);
    rig.event(note_on(1, 0, 61, 0.0, 1.0));
    let held = rig.render_blocks(1_875, BLOCK);
    assert!(peak(&held.left[230_000..]) > 0.0, "still reading after 5 s");
    rig.event(note_off(1, 0));
    rig.render_blocks(400, BLOCK);
}

//! The Guitar device: patterns strum the chord track or a custom shape, played notes land on the strings.

use abi::{float_value, int_value, Block, BlockFlags, EventRecord, FieldValue, Instrument, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
use libm::{ceil, round};
use math::value_mapping::{Decibel, Linear, LinearInteger};

use dsp::simple_limiter::SimpleLimiter;

use crate::body::{Body, BODY_COUNT};
use crate::fretting::{self, Tab, MUTED, STRINGS};
use crate::string::{self, GuitarString, Pick, Pluck, Touch, MAX_DELAY};
use crate::strum::{self, STEP_COUNT};

const STROKE_MARK: u32 = 0xC000_0000;
const QUEUE: usize = 256;
const NO_KEY: u32 = u32::MAX;
const BAR_MARKS: usize = 4; // the recent jump targets, a loop restart finds its bar number at once
const PENDING: usize = 16;
const SCRATCH: usize = 128;
const KEYS_MIN_FRET: i32 = 0;
const KEYS_MAX_FRET: i32 = 19;
const HUMANIZE: f32 = 0.012;
// WASM CONTRACT: the bend amounts mirror `GuitarPatterns.Bends` in studio-adapters (step-bends key 7)
const BENDS: [f32; 5] = [0.0, 0.25, 0.5, 1.0, 2.0];
// 3 bits per string from the low E
const BEND_MASK: i32 = (1 << 18) - 1;
const MAKEUP: f32 = 2.5118864; // +8 dB
const CLIP_KNEE: f32 = 0.7;

const MODE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 1};
const RATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
const SLOT_MAPPING: LinearInteger = LinearInteger {min: 0, max: SLOTS as i32 - 1};
const CHORD_MAPPING: LinearInteger = LinearInteger {min: 0, max: SHAPES as i32};
const POSITION_MAPPING: LinearInteger = LinearInteger {min: 0, max: 5};
const TUNING_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const BODY_MAPPING: LinearInteger = LinearInteger {min: 0, max: BODY_COUNT as i32 - 1};
const PICK_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const UNIPOLAR: Linear = Linear::unipolar();
const BIPOLAR: Linear = Linear::bipolar();
const VOLUME_MAPPING: Decibel = Decibel::default_volume();

pub mod param {
    pub const MODE: usize = 0;
    pub const RATE: usize = 1;
    pub const SPEED: usize = 2;
    pub const SPEED_VARIATION: usize = 3;
    pub const VELOCITY: usize = 4;
    pub const VELOCITY_VARIATION: usize = 5;
    pub const POSITION: usize = 6;
    pub const TUNING: usize = 7;
    pub const BODY: usize = 8;
    pub const DAMPING: usize = 9;
    pub const DAMPING_VARIATION: usize = 10;
    pub const PLUCK: usize = 11;
    pub const PLUCK_VARIATION: usize = 12;
    pub const TENSION: usize = 13;
    pub const SPOT: usize = 14;
    pub const SPREAD: usize = 15;
    pub const VOLUME: usize = 16;
    pub const PICK: usize = 17;
    pub const TILT: usize = 18;
    pub const SLOT: usize = 19;
    pub const CHORD: usize = 20;
    pub const COUNT: usize = 21;
}

// WASM CONTRACT: GuitarDeviceBox field keys (studio-boxes)
const PARAM_FIELDS: [u16; param::COUNT] = [10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 36, 28, 29, 37, 39, 41, 43];
const PATTERNS_FIELD: u16 = 42;
const LANE_KEYS: [u16; 5] = [1, 2, 3, 4, 7];
const LENGTH_KEY: u16 = 5;
pub const SLOTS: usize = 16;
pub const SHAPES: usize = 16;
const SHAPES_FIELD: u16 = 44;
const GROOVE_FIELD: u16 = 38;

const CHORDS_MODE: i32 = 0;

#[derive(Clone, Copy)]
struct Scheduled {
    due: u64,
    string: u8,
    pitch: f32,
    velocity: f32,
    touch: Touch,
    up: bool,
    seed: u32,
    key: u32,
    bend: f32,
    bend_length: u32
}

#[derive(Clone, Copy)]
struct Pending {
    id: u32,
    pitch: i32,
    velocity: f32
}

pub struct Settings {
    pub mode: i32,
    pub rate: i32,
    pub speed: f32,
    pub speed_variation: f32,
    pub velocity: f32,
    pub velocity_variation: f32,
    pub position: i32,
    pub tuning: i32,
    pub damping: f32,
    pub damping_variation: f32,
    pub pluck: f32,
    pub pluck_variation: f32,
    pub tension: f32,
    pub spot: f32,
    pub character: f32,
    pub pick: i32,
    pub spread: f32,
    pub tilt: f32,
    pub chord: i32,
    pub gain: f32
}

#[derive(Clone, Copy)]
struct Pattern {
    kinds: [i32; STEP_COUNT],
    masks: [i32; STEP_COUNT],
    velocities: [f32; STEP_COUNT],
    speeds: [f32; STEP_COUNT],
    bends: [i32; STEP_COUNT],
    length: usize
}

impl Pattern {
    const EMPTY: Pattern = Pattern {
        kinds: [strum::REST; STEP_COUNT], masks: [0b111111; STEP_COUNT], velocities: [0.8; STEP_COUNT],
        speeds: [0.5; STEP_COUNT], bends: [0; STEP_COUNT], length: 16
    };
}

pub struct State {
    strings: [GuitarString; STRINGS],
    body: Body,
    character: [f32; MAX_DELAY],
    pub settings: Settings,
    patterns: [Pattern; SLOTS],
    slot: usize,
    bpm: f32,
    bar: (f64, f64, i64),
    bar_marks: [(f64, i64); BAR_MARKS],
    bar_mark: usize,
    shapes: [Tab; SHAPES],
    queue: [Scheduled; QUEUE],
    queued: usize,
    pending: [Pending; PENDING],
    pending_count: usize,
    keys: [u32; STRINGS],
    now: u64,
    tab: Tab,
    display: Tab,
    fretted: Tab,
    tab_key: (i32, i32, i32, i32),
    chord_root: i32,
    step: i32,
    lit: i32,
    transporting: bool,
    dc: [(f32, f32); 2],
    pickup: [[f32; 4]; 2],
    limiter: SimpleLimiter,
    sample_rate: f32,
    ids: [u32; param::COUNT],
    lane_ids: [[u32; 5]; SLOTS],
    length_ids: [u32; SLOTS],
    shapes_id: u32,
    groove: abi::GrooveFollower,
    broadcast: u32
}

impl State {
    pub fn init_in_place(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        for string in &mut self.strings {
            string.init(sample_rate);
        }
        self.body.init(sample_rate);
        self.limiter.prepare(sample_rate);
        self.settings = Settings {
            mode: CHORDS_MODE, rate: 1, speed: 0.3, speed_variation: 0.2, velocity: 0.8, velocity_variation: 0.75,
            position: 0, tuning: 0, damping: 0.33, damping_variation: 0.5, pluck: 0.5,
            pluck_variation: 0.5, tension: 0.0, spot: 0.2, character: 0.5, pick: 3, spread: 0.6, tilt: 0.0, chord: 0,
            gain: dsp::db_to_gain(-6.0)
        };
        let mut noise = 65535u32;
        for value in self.character.iter_mut() {
            noise = noise.wrapping_mul(1664525).wrapping_add(1013904223);
            *value = (noise >> 8) as f32 / 8388608.0 - 1.0;
        }
        self.patterns = [Pattern::EMPTY; SLOTS];
        self.slot = 0;
        self.bpm = 120.0;
        self.bar = (-1.0, 0.0, 0);
        self.bar_marks = [(-1.0, 0); BAR_MARKS];
        self.bar_mark = 0;
        self.shapes = [[MUTED; STRINGS]; SHAPES];
        self.tab = [MUTED; STRINGS];
        self.display = [MUTED; STRINGS];
        self.fretted = [MUTED; STRINGS];
        self.tab_key = (-1, 0, 0, 0);
        self.chord_root = -1;
        self.step = -1;
        self.transporting = false;
        self.keys = [NO_KEY; STRINGS];
    }

    pub fn display(&self) -> Tab {self.display}

    pub fn lit(&self) -> i32 {self.lit}

    pub fn sounding(&self) -> i32 {
        (0..STRINGS).filter(|string| self.strings[*string].is_sounding()).fold(0, |mask, string| mask | 1 << string)
    }

    pub fn scheduled_velocities(&self) -> impl Iterator<Item = f32> + '_ {
        self.queue[..self.queued].iter().map(|item| item.velocity)
    }

    pub fn scheduled_bends(&self) -> impl Iterator<Item = (u8, f32)> + '_ {
        self.queue[..self.queued].iter().map(|item| (item.string, item.bend))
    }

    pub fn set_lane(&mut self, slot: usize, lane: usize, values: &[i32]) {
        let pattern = &mut self.patterns[slot];
        for (step, value) in values.iter().take(STEP_COUNT).enumerate() {
            match lane {
                0 => pattern.kinds[step] = (*value).clamp(strum::REST, strum::CHOP),
                1 => pattern.masks[step] = *value & 0b111111,
                2 => pattern.velocities[step] = (*value).clamp(0, 100) as f32 / 100.0,
                3 => pattern.speeds[step] = (*value).clamp(0, 100) as f32 / 100.0,
                _ => pattern.bends[step] = *value & BEND_MASK
            }
        }
    }

    pub fn set_length(&mut self, slot: usize, length: i32) {
        self.patterns[slot].length = length.clamp(1, STEP_COUNT as i32) as usize;
    }

    fn custom_shape(&self) -> Option<Tab> {
        let index = self.settings.chord;
        if index < 1 || index > SHAPES as i32 {
            return None;
        }
        let tab = self.shapes[index as usize - 1];
        if tab.iter().any(|fret| *fret >= 0) {Some(tab)} else {None}
    }

    // The number of `bar` on the signature track: the next bar counts on, a jump looks up or counts back to zero.
    fn bar_index(&mut self, bar: &abi::Bar, bar_at: fn(f64) -> abi::Bar) -> i64 {
        let (start, length, index) = self.bar;
        if bar.start == start {
            return index;
        }
        let counted = if start >= 0.0 && (bar.start - (start + length)).abs() < 1.0e-6 {
            index + 1
        } else {
            let counted = match self.bar_marks.iter().find(|(mark, _)| *mark == bar.start) {
                Some(&(_, cached)) => cached,
                None => {
                    let (mut at, mut count) = (bar.start, 0);
                    while at > 1.0e-6 {
                        let previous = bar_at(at - 1.0).start;
                        if previous >= at {
                            break;
                        }
                        at = previous;
                        count += 1;
                    }
                    count
                }
            };
            self.bar_marks[self.bar_mark] = (bar.start, counted);
            self.bar_mark = (self.bar_mark + 1) % BAR_MARKS;
            counted
        };
        self.bar = (bar.start, bar.length, counted);
        counted
    }

    pub fn set_shapes(&mut self, values: &[i32]) {
        for (shape, packed) in self.shapes.iter_mut().zip(values.iter()) {
            *shape = fretting::unpack_shape(*packed);
        }
    }

    fn chord_tab(&mut self, root: i32, voicing: i32) -> Tab {
        let key = (root, voicing, self.settings.tuning, self.settings.position);
        if key != self.tab_key {
            self.tab_key = key;
            self.tab = fretting::tab(root, voicing, self.settings.tuning as usize, self.settings.position as usize);
        }
        self.tab
    }

    fn spacing(&self, factor: f32, seed: u32, salt: i64) -> f32 {
        let jitter = 1.0 + strum::bipolar(seed, salt, 11) * self.settings.speed_variation * 0.6;
        (0.003 + 0.12 * self.settings.speed * self.settings.speed) * factor * jitter.max(0.1) * self.sample_rate
    }

    fn enqueue(&mut self, item: Scheduled) {
        if self.queued < QUEUE {
            self.queue[self.queued] = item;
            self.queued += 1;
        }
    }

    fn release_all(&mut self) {
        for string in &mut self.strings {
            string.release();
        }
        self.queued = 0;
        self.keys = [NO_KEY; STRINGS];
    }

    // Silences what the pattern plays, notes played on the strings keep ringing.
    fn release_strummed(&mut self) {
        for string in 0..STRINGS {
            if self.keys[string] == NO_KEY {
                self.strings[string].release();
            }
        }
        let mut kept = 0;
        for index in 0..self.queued {
            if self.queue[index].key != NO_KEY {
                self.queue[kept] = self.queue[index];
                kept += 1;
            }
        }
        self.queued = kept;
    }

    // One stroke of the pattern at the current sample: the chord at its position, its strings, their plucks.
    fn stroke(&mut self, event: &EventRecord) {
        let kind = event.pitch as i32;
        if kind == strum::STOP {
            self.release_strummed();
            return;
        }
        let custom = self.custom_shape();
        let tab = if let Some(tab) = custom {
            self.chord_root = -1;
            tab
        } else {
            let Some((root, voicing)) = abi::harmony_at(event.position).chord else {
                self.chord_root = -1;
                self.release_strummed();
                return;
            };
            self.chord_root = root;
            self.chord_tab(root, voicing)
        };
        self.display = tab;
        let packed = event.duration as i32;
        let mask = packed & 0b111111;
        let bends = (packed >> 6) & BEND_MASK;
        let step_samples = strum::step_length(self.settings.rate) / 960.0 * 60.0 / self.bpm.max(1.0) as f64 * self.sample_rate as f64;
        let (strings, count) = strum::order(kind, mask, &tab);
        for string in 0..STRINGS {
            let moved = tab[string] < 0 || tab[string] != self.fretted[string];
            if moved && self.keys[string] == NO_KEY && !strings[..count].contains(&string) {
                self.strings[string].release();
            }
        }
        self.fretted = tab;
        let mut bent = [0i32; STRINGS];
        if matches!(kind, strum::DOWN | strum::UP | strum::MUTE | strum::CHOP) {
            for (string, amount) in bent.iter_mut().enumerate() {
                *amount = (bends >> (string * 3)) & 7;
            }
        } else if kind == strum::PICK {
            for wanted in (0..STRINGS).rev().filter(|wanted| mask & (1 << wanted) != 0) {
                if let Some(string) = strum::nearest_sounding(wanted, &tab) {
                    bent[string] = (bends >> (wanted * 3)) & 7;
                }
            }
        }
        let tilted = matches!(kind, strum::DOWN | strum::UP | strum::MUTE | strum::CHUCK | strum::CHOP);
        let seed = event.id;
        let factor = if kind == strum::CHUCK {0.35} else {0.25 + event.cent * 1.5};
        let touch = match kind {
            strum::MUTE => Touch::Palm,
            strum::CHUCK => Touch::Chuck,
            strum::CHOP => Touch::Chop,
            _ => Touch::Open
        };
        self.lit = 0;
        let level = event.velocity * (1.0 + strum::bipolar(seed, 0, 1) * self.settings.velocity_variation * 0.5);
        let mut delay = (0.5 + 0.5 * strum::bipolar(seed, 0, 13)) * self.settings.speed_variation * HUMANIZE * self.sample_rate;
        for (index, string) in strings[..count].iter().enumerate() {
            if index > 0 && kind != strum::PICK {
                delay += self.spacing(factor, seed, index as i64);
            }
            let pitch = fretting::pitch(self.settings.tuning as usize, *string, tab[*string]) as f32;
            self.enqueue(Scheduled {
                due: self.now + delay as u64, string: *string as u8, pitch, touch, up: kind == strum::UP,
                velocity: if tilted {level * strum::tilt_gain(*string, self.settings.tilt)} else {level},
                seed: strum::hash(seed, *string as i64, 3), key: NO_KEY,
                bend: BENDS[(bent[*string] as usize).min(BENDS.len() - 1)],
                bend_length: (step_samples - delay as f64).max(step_samples * 0.5) as u32
            });
            self.keys[*string] = NO_KEY;
            self.lit |= 1 << *string;
        }
    }

    // The notes that arrived together go to free strings near the Position, strummed from low to high.
    fn assign_pending(&mut self) {
        if self.pending_count == 0 {
            return;
        }
        let mut notes = self.pending;
        let count = self.pending_count;
        self.pending_count = 0;
        notes[..count].sort_unstable_by_key(|note| note.pitch);
        let tuning = self.settings.tuning as usize;
        let low = fretting::POSITION_FRETS[self.settings.position.clamp(0, 5) as usize];
        let mut taken = [false; STRINGS];
        let mut chosen = [(0usize, 0i32, 0u32, 0.0f32); PENDING];
        let mut placed = 0;
        for note in &notes[..count] {
            let fret_on = |string: usize| note.pitch - fretting::TUNINGS[tuning][string];
            let playable = |string: usize| (KEYS_MIN_FRET..=KEYS_MAX_FRET).contains(&fret_on(string));
            let in_window = |string: usize| fret_on(string) == 0 || (low - 1..=low + 4).contains(&fret_on(string));
            let string = (0..STRINGS).find(|string| !taken[*string] && playable(*string) && in_window(*string))
                .or_else(|| (0..STRINGS).filter(|string| !taken[*string] && playable(*string)).min_by_key(|string| fret_on(*string)))
                .or_else(|| (0..STRINGS).filter(|string| playable(*string)).min_by_key(|string| fret_on(*string)));
            let Some(string) = string else {continue};
            taken[string] = true;
            chosen[placed] = (string, note.pitch, note.id, note.velocity);
            placed += 1;
        }
        chosen[..placed].sort_unstable_by_key(|entry| entry.0);
        self.lit = 0;
        let mut delay = 0.0f32;
        for (index, (string, pitch, id, velocity)) in chosen[..placed].iter().copied().enumerate() {
            if index > 0 {
                delay += self.spacing(1.0, id, index as i64);
            }
            self.keys[string] = id;
            self.display[string] = (pitch - fretting::TUNINGS[tuning][string]) as i8;
            let seed = strum::hash(id, string as i64, 5);
            let varied = 1.0 + strum::bipolar(seed, 0, 1) * self.settings.velocity_variation * 0.5;
            self.enqueue(Scheduled {
                due: self.now + delay as u64, string: string as u8, pitch: pitch as f32,
                velocity: velocity * (0.4 + self.settings.velocity * 0.8) * varied, touch: Touch::Open, up: false, seed, key: id,
                bend: 0.0, bend_length: 0
            });
            self.lit |= 1 << string;
        }
    }

    // The original variation laws: the damping variation only ever opens the string, the plug filter spreads around its value.
    fn fire(&mut self, item: Scheduled) {
        let settings = &self.settings;
        let bipolar = |salt: u32| strum::bipolar(item.seed, 0, salt);
        let unit = |salt: u32| 0.5 + 0.5 * bipolar(salt);
        let brightness = self.body.strings();
        let decay = string::overtone_decay(settings.damping, item.pitch) * (1.0 - 0.5 * unit(2) * settings.damping_variation)
            / (brightness * brightness * brightness);
        let plug = 0.1 + 0.8 * settings.pluck;
        let spread = settings.pluck_variation * 0.5;
        let (low, high) = (plug - (plug - 0.1) * spread, plug + (0.9 - plug) * spread);
        let pluck = Pluck {
            pitch: item.pitch,
            velocity: item.velocity.clamp(0.02, 1.2),
            decay,
            plug: ((low + unit(4) * (high - low)) * brightness).min(0.95),
            position: 0.04 + 0.46 * settings.spot + bipolar(6) * 0.03 * settings.character,
            tension: settings.tension,
            character: settings.character,
            touch: item.touch,
            pick: Pick::from_index(settings.pick),
            up: item.up,
            noise_seed: item.seed,
            bend: item.bend,
            bend_length: item.bend_length
        };
        let base_frequency = abi::base_frequency();
        let string = item.string as usize;
        self.strings[string].pluck(&pluck, &self.body, &self.character, base_frequency);
        if item.key != NO_KEY && self.keys[string] != item.key {
            self.strings[string].release();
        }
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut mono = [0.0f32; SCRATCH];
        let spread = self.settings.spread;
        let body = &self.body;
        for (index, string) in self.strings.iter_mut().enumerate() {
            let length = left.len();
            mono[..length].fill(0.0);
            if !string.render(&mut mono[..length], body) {
                continue;
            }
            let pan = spread * (index as f32 - 2.5) * 0.32;
            let (gain_left, gain_right) = ((1.0 - pan) * 0.5, (1.0 + pan) * 0.5);
            for sample in 0..length {
                left[sample] += mono[sample] * gain_left;
                right[sample] += mono[sample] * gain_right;
            }
        }
    }

    fn broadcast(&self) {
        let slot = abi::broadcast_ptr(self.broadcast);
        if slot == 0 {
            return;
        }
        let values = unsafe {core::slice::from_raw_parts_mut(slot as *mut i32, 9)};
        values[0] = self.step;
        values[1] = self.chord_root;
        for string in 0..STRINGS {
            values[2 + string] = self.display[string] as i32;
        }
        values[8] = self.lit;
    }
}

/// The strokes of `[from, to)` as internal note-ons, the pattern restarts with every bar.
pub fn generate(state: &mut State, from: f64, to: f64, flags: BlockFlags, bar_at: fn(f64) -> abi::Bar,
                out: &mut [EventRecord]) -> usize {
    let transporting = flags.transporting();
    if state.transporting && !transporting && state.settings.mode == CHORDS_MODE {
        state.release_all();
    }
    if transporting && !state.transporting {
        state.bar_marks = [(-1.0, 0); BAR_MARKS];
    }
    state.transporting = transporting;
    if state.settings.mode != CHORDS_MODE || !transporting {
        state.step = -1;
        state.broadcast();
        return 0;
    }
    let step_length = strum::step_length(state.settings.rate);
    let (straight_from, straight_to) = state.groove.straight(from, to, flags.discontinuous());
    let mut bar = bar_at(straight_from);
    let mut next = (ceil((straight_from - bar.start) / step_length) as i64).max(0);
    let mut count = 0;
    loop {
        let local = next;
        let grid = bar.start + local as f64 * step_length;
        if grid >= bar.start + bar.length - 1.0e-6 {
            bar = bar_at(bar.start + bar.length);
            next = 0;
            continue;
        }
        if grid >= straight_to {
            break;
        }
        next += 1;
        if count >= out.len() {
            continue;
        }
        let position = state.groove.warp(grid);
        let grid_index = round(grid / step_length) as i64;
        let per_bar = ceil(bar.length / step_length - 1.0e-6).max(1.0) as i64;
        let bars = state.bar_index(&bar, bar_at);
        let pattern = &state.patterns[state.slot];
        let span = (round(pattern.length as f64 / per_bar as f64) as i64).max(1);
        let step = (bars.rem_euclid(span) * per_bar + local).rem_euclid(pattern.length as i64) as usize;
        state.step = step as i32;
        let kind = pattern.kinds[step];
        if kind == strum::REST {
            continue;
        }
        let level = (pattern.velocities[step] * (0.4 + state.settings.velocity * 0.8)).min(1.2);
        out[count] = EventRecord {
            position, offset: 0, kind: EVENT_NOTE_ON, id: STROKE_MARK | (grid_index as u32 & 0x3FFF_FFFF), pitch: kind as u32,
            velocity: level, cent: pattern.speeds[step], duration: (pattern.masks[step] | pattern.bends[step] << 6) as f64
        };
        count += 1;
    }
    state.broadcast();
    count
}

pub fn handle(state: &mut State, event: &EventRecord) {
    if event.kind == EVENT_NOTE_ON && event.id & STROKE_MARK == STROKE_MARK {
        state.stroke(event);
        state.broadcast();
    } else if event.kind == EVENT_NOTE_ON {
        if state.pending_count < PENDING {
            state.pending[state.pending_count] = Pending {id: event.id, pitch: event.pitch as i32, velocity: event.velocity};
            state.pending_count += 1;
        }
    } else if event.kind == EVENT_NOTE_OFF {
        if let Some(index) = state.pending[..state.pending_count].iter().position(|note| note.id == event.id) {
            state.pending.copy_within(index + 1..state.pending_count, index);
            state.pending_count -= 1;
        }
        for string in 0..STRINGS {
            if state.keys[string] == event.id && event.id != NO_KEY {
                state.keys[string] = NO_KEY;
                if !state.queue[..state.queued].iter().any(|item| item.key == event.id) {
                    state.strings[string].release();
                }
            }
        }
    }
}

// unchanged below the knee, the pick's few sample spikes bend into full scale
#[inline]
fn soft_clip(input: f32) -> f32 {
    let magnitude = input.abs();
    if magnitude <= CLIP_KNEE {
        return input;
    }
    let bent = CLIP_KNEE + (1.0 - CLIP_KNEE) * libm::tanhf((magnitude - CLIP_KNEE) / (1.0 - CLIP_KNEE));
    bent.copysign(input)
}

#[inline]
fn dc_block(state: &mut (f32, f32), input: f32) -> f32 {
    let output = input - state.0 + 0.995 * state.1;
    *state = (input, output);
    output
}

// The pickup's resonant lowpass (a biquad, direct form 1) in place.
fn resonate(coefficients: &[f32; 5], memory: &mut [f32; 4], signal: &mut [f32]) {
    let [b0, b1, b2, a1, a2] = *coefficients;
    for sample in signal.iter_mut() {
        let [x1, x2, y1, y2] = *memory;
        let output = b0 * *sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        *memory = [*sample, x1, output, y1];
        *sample = output;
    }
}

pub fn render(state: &mut State, output: [&mut [f32]; 2]) {
    state.assign_pending();
    let [out_left, out_right] = output;
    let length = out_left.len().min(out_right.len());
    let mut done = 0;
    while done < length {
        let mut index = 0;
        while index < state.queued {
            if state.queue[index].due <= state.now {
                let item = state.queue[index];
                state.queue[index] = state.queue[state.queued - 1];
                state.queued -= 1;
                state.fire(item);
            } else {
                index += 1;
            }
        }
        let next = state.queue[..state.queued].iter().map(|item| item.due).min().unwrap_or(u64::MAX);
        let chunk = ((length - done) as u64).min(next - state.now).min(SCRATCH as u64).max(1) as usize;
        let mut left = [0.0f32; SCRATCH];
        let mut right = [0.0f32; SCRATCH];
        state.render(&mut left[..chunk], &mut right[..chunk]);
        if let Some(coefficients) = state.body.resonance() {
            resonate(&coefficients, &mut state.pickup[0], &mut left[..chunk]);
            resonate(&coefficients, &mut state.pickup[1], &mut right[..chunk]);
        }
        for sample in 0..chunk {
            left[sample] = dc_block(&mut state.dc[0], left[sample]) * MAKEUP;
            right[sample] = dc_block(&mut state.dc[1], right[sample]) * MAKEUP;
        }
        state.limiter.replace(&mut left, &mut right, 0, chunk);
        let gain = state.settings.gain;
        for sample in 0..chunk {
            out_left[done + sample] += soft_clip(left[sample]) * gain;
            out_right[done + sample] += soft_clip(right[sample]) * gain;
        }
        state.now += chunk as u64;
        done += chunk;
    }
}

pub fn apply_parameter(state: &mut State, index: usize, value: ParamValue) {
    let settings = &mut state.settings;
    match index {
        param::MODE => settings.mode = int_value(value, &MODE_MAPPING),
        param::RATE => settings.rate = int_value(value, &RATE_MAPPING),
        param::SPEED => settings.speed = float_value(value, &UNIPOLAR),
        param::SPEED_VARIATION => settings.speed_variation = float_value(value, &UNIPOLAR),
        param::VELOCITY => settings.velocity = float_value(value, &UNIPOLAR),
        param::VELOCITY_VARIATION => settings.velocity_variation = float_value(value, &UNIPOLAR),
        param::POSITION => settings.position = int_value(value, &POSITION_MAPPING),
        param::TUNING => settings.tuning = int_value(value, &TUNING_MAPPING),
        param::BODY => state.body.select(int_value(value, &BODY_MAPPING).max(0) as usize),
        param::DAMPING => settings.damping = float_value(value, &UNIPOLAR),
        param::DAMPING_VARIATION => settings.damping_variation = float_value(value, &UNIPOLAR),
        param::PLUCK => settings.pluck = float_value(value, &UNIPOLAR),
        param::PLUCK_VARIATION => settings.pluck_variation = float_value(value, &UNIPOLAR),
        param::TENSION => settings.tension = float_value(value, &UNIPOLAR),
        param::SPOT => settings.spot = float_value(value, &UNIPOLAR),
        param::SPREAD => settings.spread = float_value(value, &UNIPOLAR),
        param::VOLUME => settings.gain = dsp::db_to_gain(float_value(value, &VOLUME_MAPPING)),
        param::PICK => settings.pick = int_value(value, &PICK_MAPPING),
        param::TILT => settings.tilt = float_value(value, &BIPOLAR),
        param::CHORD => settings.chord = int_value(value, &CHORD_MAPPING).clamp(0, SHAPES as i32),
        param::SLOT => state.slot = int_value(value, &SLOT_MAPPING).clamp(0, SLOTS as i32 - 1) as usize,
        _ => {}
    }
}

pub struct Device;

impl Instrument for Device {
    type State = State;

    fn init(state: &mut State, sample_rate: f32) {
        state.init_in_place(sample_rate);
        for index in 0..param::COUNT {
            state.ids[index] = abi::bind_parameter(&[PARAM_FIELDS[index]]);
        }
        for slot in 0..SLOTS {
            for (lane, key) in LANE_KEYS.iter().enumerate() {
                state.lane_ids[slot][lane] = abi::observe_field(&[PATTERNS_FIELD, slot as u16, *key]);
            }
            state.length_ids[slot] = abi::observe_field(&[PATTERNS_FIELD, slot as u16, LENGTH_KEY]);
        }
        state.shapes_id = abi::observe_field(&[SHAPES_FIELD]);
        state.groove = abi::GrooveFollower::observe(&[GROOVE_FIELD]);
        state.broadcast = abi::bind_broadcast_int_array(&[0], 9);
    }

    fn handle_event(state: &mut State, event: &EventRecord) {
        handle(state, event);
    }

    const GENERATES: bool = true;

    fn generate_events(state: &mut State, from: f64, to: f64, flags: BlockFlags, out: &mut [EventRecord]) -> usize {
        generate(state, from, to, flags, abi::bar_at, out)
    }

    fn process_audio(state: &mut State, output: [&mut [f32]; 2], block: &Block) {
        state.bpm = block.bpm;
        render(state, output);
    }

    fn parameter_changed(state: &mut State, id: u32, value: ParamValue) {
        if let Some(index) = state.ids.iter().position(|bound| *bound == id) {
            apply_parameter(state, index, value);
        }
    }

    fn field_changed(state: &mut State, id: u32, value: FieldValue) {
        if id == state.shapes_id {
            if let FieldValue::Ints(values) = value {
                state.set_shapes(values);
            }
            return;
        }
        if let Some(slot) = state.length_ids.iter().position(|bound| *bound == id) {
            if let FieldValue::Int(length) = value {
                state.set_length(slot, length);
            }
            return;
        }
        for slot in 0..SLOTS {
            if let Some(lane) = state.lane_ids[slot].iter().position(|bound| *bound == id) {
                if let FieldValue::Ints(values) = value {
                    state.set_lane(slot, lane, values);
                }
                return;
            }
        }
    }

    fn reset(state: &mut State) {
        for string in &mut state.strings {
            string.reset();
        }
        state.dc = [(0.0, 0.0); 2];
        state.pickup = [[0.0; 4]; 2];
        state.limiter.clear();
        state.queued = 0;
        state.pending_count = 0;
        state.keys = [NO_KEY; STRINGS];
        state.step = -1;
        state.transporting = false;
        state.lit = 0;
        state.display = [MUTED; STRINGS];
        state.fretted = [MUTED; STRINGS];
    }
}

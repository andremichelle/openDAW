//! One Korpus 2 voice behind the shared `voicing::Voice` contract: an exciter (strike, breath,
//! bow, pick or wind) sounding object A — driven modal bank, bowed modal bank, plucked string or
//! blown pipe — plus object B, a driven bank the exciter plays alongside A (parallel) or A's sound
//! rings through (serial). Stereo throughout.

use abi::EventRecord;
use libm::{fabsf, floorf, powf, sinf};
use voicing::Voice;

use crate::engine::bow::BowState;
use crate::engine::driven::{build_specs, eigensplit, repel, t60_scale, DrivenBank, Injection, SILENT_SPEC};
use crate::engine::exciter::{Breath, Strike};
use crate::engine::pluck::{PluckState, BODY_LEN};
use crate::engine::tables::{Material, MAX_MODES};
use crate::engine::wind::WindState;

pub const CHUNK_MAX: usize = 128;
const TAIL_SILENCE_BLOCKS: u32 = 16;
const TAIL_THRESHOLD: f32 = 1.0e-4;
const OBJECT_B_OFF: i32 = 6;
const BREATH_DRIVE: f32 = 100.0; // unity-peak modes pass only their sliver of the noise band
const BREATH_BLEED: f32 = 0.004; // chiff + air survive dark objects via a little direct bleed
const COUPLE_REACH: f32 = 25.0;
const SERIAL_B: f32 = 18.0;
const SUSTAINED_SERIAL_B: f32 = 0.1; // a held tone keeps feeding B's resonance; a hit decays out of it
const BOW_B: f32 = 20.0;
const PICK_B: f32 = 0.012;
const WIND_B: f32 = 50.0;
const BOW_SERIAL_AIR: f32 = 9.0;
const WIND_SERIAL_AIR: f32 = 24.0;
const PI: f32 = core::f32::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exciter {
    Strike,
    Breath,
    Bow,
    Pick,
    Wind,
}

impl Exciter {
    pub fn from_index(index: i32) -> Self {
        match index {
            1 => Self::Breath,
            2 => Self::Bow,
            3 => Self::Pick,
            4 => Self::Wind,
            _ => Self::Strike,
        }
    }
}

pub struct KorpusShared {
    pub exciter: Exciter,
    pub intensity: f32,
    pub position: f32,
    pub vibrato: f32,
    pub air: f32,
    pub stroke: f32,
    pub object_a: i32,
    pub damping_a: f32,
    pub tune_a: i32,
    pub width_a: f32,
    pub level_a: f32,
    pub object_b: i32,
    pub damping_b: f32,
    pub tune_b: f32,
    pub width_b: f32,
    pub level_b: f32,
    pub routing: i32,
    pub couple: f32,
    pub sample_rate: f32,
    pub motor_phase: f32,
    pub body: [f32; BODY_LEN],
}

impl KorpusShared {
    pub const fn silent() -> Self {
        Self {exciter: Exciter::Strike, intensity: 0.5, position: 0.35, vibrato: 0.0, air: 0.5, stroke: 0.5,
            object_a: 0, damping_a: 0.5, tune_a: 0, width_a: 0.6, level_a: 0.5, object_b: OBJECT_B_OFF,
            damping_b: 0.5, tune_b: 0.0, width_b: 0.8, level_b: 0.5, routing: 0,
            couple: 0.0, sample_rate: 48_000.0, motor_phase: 0.0, body: [0.0; BODY_LEN]}
    }

    /// Advances the tremolo motor every struck voice shares, so a chord pulses together.
    pub fn advance_motor(&mut self, len: usize) {
        let phase = self.motor_phase + len as f32 * motor_rate(self.vibrato) / self.sample_rate;
        self.motor_phase = phase - floorf(phase);
    }
}

// Vibraphone motor speed in Hz; it spins faster as the Vibrato knob opens.
fn motor_rate(vibrato: f32) -> f32 {
    3.0 + 5.0 * vibrato
}

struct DrivenVoice {
    strike: Strike,
    breath: Breath,
    breathing: bool,
    bank_a: DrivenBank,
}

impl DrivenVoice {
    const fn silent() -> Self {
        Self {strike: Strike::silent(), breath: Breath::silent(), breathing: false,
            bank_a: DrivenBank::silent()}
    }
}

enum EngineState {
    Idle,
    Driven(DrivenVoice),
    Bow(BowState),
    Pluck(PluckState),
    Wind(WindState),
}

// Note-on values of the knobs whose live feedback bends relative to them (width is absolute).
struct NoteOn {
    tune_a: i32,
    tune_b: f32,
    damping_a: f32,
    damping_b: f32,
    level_b: f32,
}

impl NoteOn {
    const fn silent() -> Self {
        Self {tune_a: 0, tune_b: 0.0, damping_a: 0.5, damping_b: 0.5, level_b: 0.5}
    }
}

// Chunk-rate smoothed knob values (freq_* are ratios against the note-on tuning).
struct Live {
    freq_a: f32,
    freq_b: f32,
    damping_a: f32,
    damping_b: f32,
    width_a: f32,
    width_b: f32,
    level_a: f32,
    level_b: f32,
    intensity: f32,
    vibrato: f32,
    air: f32,
    stroke: f32,
}

impl Live {
    const fn silent() -> Self {
        Self {freq_a: 1.0, freq_b: 1.0, damping_a: 0.5, damping_b: 0.5, width_a: 0.6,
            width_b: 0.8, level_a: 0.5, level_b: 0.5, intensity: 0.5, vibrato: 0.0, air: 0.5,
            stroke: 0.5}
    }
}

pub struct KorpusVoice {
    state: EngineState,
    bank_b: DrivenBank,
    has_b: bool,
    serial: bool,
    gain_a: f32,
    gain_b: f32,
    serial_gain: f32,
    release_t60: f32,
    frequency: f32,
    velocity: f32,
    pending_glide: f32,
    gate: bool,
    tail_blocks: u32,
    active: bool,
    on: NoteOn,
    live: Live,
}

impl Default for KorpusVoice {
    fn default() -> Self {
        Self {state: EngineState::Idle, bank_b: DrivenBank::silent(), has_b: false, serial: false,
            gain_a: 1.0, gain_b: 0.38, serial_gain: SERIAL_B, release_t60: 1.0, frequency: 220.0,
            velocity: 0.8, pending_glide: 0.0, gate: false, tail_blocks: 0, active: false,
            on: NoteOn::silent(), live: Live::silent()}
    }
}

fn semitones(steps: i32) -> f32 {
    powf(2.0, steps as f32 / 12.0)
}

// A sounding engine's overtone series: the partials a coupled object B beats against.
fn harmonics(f0: f32, sample_rate: f32, out: &mut [f32; MAX_MODES]) -> usize {
    let mut count = 0;
    while count < MAX_MODES {
        let partial = f0 * (count + 1) as f32;
        if partial >= 0.45 * sample_rate {
            break;
        }
        out[count] = partial;
        count += 1;
    }
    count
}

/// One-pole knob smoothing at chunk rate (~60ms to settle); true while still moving. The stop
/// epsilon is relative so small frequency ratios (tune −24 ⇒ 0.0625) still settle in tune.
fn approach(current: &mut f32, target: f32) -> bool {
    let delta = target - *current;
    if libm::fabsf(delta) < 1.0e-4 * libm::fabsf(target).max(0.05) {
        return false;
    }
    *current += delta * 0.2;
    true
}

impl KorpusVoice {
    /// Realtime knob feedback: smooth the continuous knobs toward `shared` and bend the sounding
    /// engines. Structural knobs (exciter, objects, routing, couple) stay note-on decisions.
    fn update_live(&mut self, shared: &KorpusShared) {
        let on = &self.on;
        let live = &mut self.live;
        let freq_a_moved = approach(&mut live.freq_a, semitones(shared.tune_a - on.tune_a));
        let damping_a_moved = approach(&mut live.damping_a, shared.damping_a);
        let width_a_moved = approach(&mut live.width_a, shared.width_a);
        let intensity_moved = approach(&mut live.intensity, shared.intensity);
        let vibrato_moved = approach(&mut live.vibrato, shared.vibrato);
        let air_moved = approach(&mut live.air, shared.air);
        let stroke_moved = approach(&mut live.stroke, shared.stroke);
        approach(&mut live.level_a, shared.level_a);
        let moved_a = freq_a_moved || damping_a_moved || width_a_moved;
        match &mut self.state {
            EngineState::Idle => {}
            EngineState::Pluck(pluck) =>
                pluck.refresh(live.freq_a, live.damping_a, live.width_a, live.vibrato),
            EngineState::Bow(bow) => {
                if moved_a || intensity_moved || vibrato_moved || air_moved || stroke_moved {
                    bow.refresh(live.intensity,
                        t60_scale(live.damping_a) / t60_scale(on.damping_a),
                        live.width_a, live.freq_a, live.vibrato, live.air, live.stroke);
                }
            }
            EngineState::Wind(wind) => {
                if moved_a || intensity_moved || vibrato_moved || air_moved {
                    wind.refresh(live.intensity, live.damping_a, live.width_a, live.freq_a,
                        live.vibrato, live.air);
                }
            }
            EngineState::Driven(voice) => {
                if moved_a {
                    voice.bank_a.retune(live.freq_a,
                        t60_scale(live.damping_a) / t60_scale(on.damping_a) * self.release_t60,
                        live.width_a, 1.0);
                }
                if voice.breathing && (intensity_moved || damping_a_moved) {
                    voice.breath.adjust(live.intensity, live.damping_a);
                }
            }
        }
        if self.has_b {
            let freq_b_moved = approach(&mut live.freq_b, powf(2.0, (shared.tune_b - on.tune_b) / 12.0));
            let damping_b_moved = approach(&mut live.damping_b, shared.damping_b);
            let width_b_moved = approach(&mut live.width_b, shared.width_b);
            let level_b_moved = approach(&mut live.level_b, shared.level_b);
            if freq_b_moved || damping_b_moved || width_b_moved || level_b_moved {
                self.retune_b();
            }
        }
    }

    /// Rebends object B against its note-on specs from the smoothed live values.
    fn retune_b(&mut self) {
        let (live, on) = (&self.live, &self.on);
        let send = if self.serial {1.0} else {(0.4 + 0.6 * live.level_b) / (0.4 + 0.6 * on.level_b)};
        self.bank_b.retune(live.freq_b,
            t60_scale(live.damping_b) / t60_scale(on.damping_b) * self.release_t60, live.width_b, send);
        if self.serial {
            self.gain_b = self.serial_gain * live.level_b;
        }
    }
}

impl KorpusVoice {
    // The pool starts a note at a decaying voice's pitch and glides away; the models re-seat instead.
    fn seed(&mut self, frequency: f32, velocity: f32, shared: &KorpusShared) {
        self.frequency = frequency;
        let f0_a = frequency * semitones(shared.tune_a);
        let has_b = shared.object_b < OBJECT_B_OFF;
        let serial = shared.routing == 1;
        let k = shared.couple * shared.couple * 8.0;
        // Spec arrays are small (64 × 20B) — safe stack temps even on the wasm side.
        let mut specs_b = [SILENT_SPEC; MAX_MODES];
        let mut count_b = 0;
        if has_b {
            let f0_b = frequency * powf(2.0, shared.tune_b / 12.0);
            count_b = build_specs(Material::from_index(shared.object_b), f0_b, shared.damping_b,
                shared.position, shared.sample_rate, &mut specs_b);
            // The B send is part of the physical drive vector: fold it in BEFORE the
            // coupling rotation (post-rotation scaling buries the lower doublet member).
            if !serial {
                for spec in specs_b[..count_b].iter_mut() {
                    spec.gain_in *= 0.4 + 0.6 * shared.level_b;
                }
            }
        }
        // Path-aware make-up: a lone object carries the whole level; pairs sum.
        let make_up = |pair: f32| if !has_b {1.0} else if serial {0.8} else {pair};
        let sustained_serial = SERIAL_B * SUSTAINED_SERIAL_B;
        let (gain_a, parallel_kind, parallel_gain, serial_gain) = match shared.exciter {
            Exciter::Pick => {
                if !matches!(self.state, EngineState::Pluck(_)) {
                    self.state = EngineState::Pluck(PluckState::silent());
                }
                let EngineState::Pluck(pluck) = &mut self.state else {unreachable!()};
                pluck.pluck(Material::from_index(shared.object_a), f0_a, velocity,
                    shared.intensity, shared.damping_a, shared.position, shared.width_a,
                    shared.vibrato, shared.air, shared.stroke, shared.sample_rate);
                (make_up(0.62), Injection::Strike, PICK_B, SERIAL_B)
            }
            Exciter::Bow => {
                if !matches!(self.state, EngineState::Bow(_)) {
                    self.state = EngineState::Bow(BowState::silent());
                }
                let EngineState::Bow(bow) = &mut self.state else {unreachable!()};
                bow.start(Material::from_index(shared.object_a), f0_a, velocity,
                    shared.intensity, shared.position, shared.damping_a, shared.width_a,
                    shared.vibrato, shared.air, shared.stroke, shared.sample_rate);
                (make_up(0.72), Injection::Noise, BOW_B, sustained_serial)
            }
            Exciter::Wind => {
                if !matches!(self.state, EngineState::Wind(_)) {
                    self.state = EngineState::Wind(WindState::silent());
                }
                let EngineState::Wind(wind) = &mut self.state else {unreachable!()};
                wind.blow(Material::from_index(shared.object_a), f0_a, velocity,
                    shared.intensity, shared.position, shared.damping_a, shared.width_a,
                    shared.vibrato, shared.air, shared.sample_rate);
                (make_up(0.62), Injection::Noise, WIND_B, sustained_serial)
            }
            Exciter::Strike | Exciter::Breath => {
                if !matches!(self.state, EngineState::Driven(_)) {
                    self.state = EngineState::Driven(DrivenVoice::silent());
                }
                let EngineState::Driven(voice) = &mut self.state else {unreachable!()};
                let breathing = shared.exciter == Exciter::Breath;
                let mut specs_a = [SILENT_SPEC; MAX_MODES];
                let count_a = build_specs(Material::from_index(shared.object_a), f0_a,
                    shared.damping_a, shared.position, shared.sample_rate, &mut specs_a);
                for spec in specs_a[..count_a].iter_mut() {
                    spec.gain_out_a = spec.gain_out;
                }
                if has_b && serial {
                    let mut partials = [0.0f32; MAX_MODES];
                    for (partial, spec) in partials.iter_mut().zip(specs_a[..count_a].iter()) {
                        *partial = spec.frequency;
                    }
                    repel(&mut specs_b, count_b, &partials[..count_a], k, COUPLE_REACH);
                } else if has_b {
                    eigensplit(&mut specs_a, count_a, &mut specs_b, count_b, k, COUPLE_REACH);
                }
                let kind_a = if breathing {Injection::Noise} else {Injection::Strike};
                voice.bank_a.build(&specs_a, count_a, kind_a, shared.width_a, shared.sample_rate);
                voice.breathing = breathing;
                if breathing {
                    voice.breath.blow(velocity, shared.intensity, shared.damping_a,
                        shared.sample_rate);
                } else {
                    voice.strike.strike(velocity, shared.intensity, shared.stroke, shared.air,
                        shared.sample_rate);
                }
                let gain_a = if breathing {0.55} else if !has_b {0.62} else if serial {0.5} else {0.38};
                if breathing {(gain_a, Injection::Noise, 0.5, SERIAL_B)}
                    else {(gain_a, Injection::Strike, 0.38, SERIAL_B)}
            }
        };
        if has_b {
            if !matches!(self.state, EngineState::Driven(_)) {
                let mut partials = [0.0f32; MAX_MODES];
                let count = harmonics(f0_a, shared.sample_rate, &mut partials);
                repel(&mut specs_b, count_b, &partials[..count], k, COUPLE_REACH);
            }
            // A held bow or wind tone reaches only coincident modes; its rosin or breath rings the rest.
            let sustained = matches!(self.state, EngineState::Bow(_) | EngineState::Wind(_));
            let kind_b = if serial && !sustained {Injection::Tonal} else {parallel_kind};
            self.bank_b.build(&specs_b, count_b, kind_b, shared.width_b, shared.sample_rate);
            self.gain_b = if serial {serial_gain * shared.level_b} else {parallel_gain};
        }
        self.has_b = has_b;
        self.serial = serial;
        self.serial_gain = serial_gain;
        self.gain_a = gain_a;
        self.release_t60 = 1.0;
        self.on = NoteOn {tune_a: shared.tune_a, tune_b: shared.tune_b, damping_a: shared.damping_a,
            damping_b: shared.damping_b, level_b: shared.level_b};
        self.live = Live {freq_a: 1.0, freq_b: 1.0, damping_a: shared.damping_a,
            damping_b: shared.damping_b, width_a: shared.width_a, width_b: shared.width_b,
            level_a: shared.level_a, level_b: shared.level_b, intensity: shared.intensity,
            vibrato: shared.vibrato, air: shared.air, stroke: shared.stroke};
    }
}

impl Voice for KorpusVoice {
    type Shared = KorpusShared;

    fn start(&mut self, event: &EventRecord, frequency: f32, _gain: f32, _spread: f32,
             _unison: usize, shared: &Self::Shared) {
        self.velocity = (0.15 + 0.85 * event.velocity).clamp(0.0, 1.0);
        self.pending_glide = 0.0;
        self.seed(frequency, self.velocity, shared);
        self.gate = true;
        self.tail_blocks = 0;
        self.active = true;
    }

    fn stop(&mut self) {
        self.gate = false;
        let blown = match &mut self.state {
            EngineState::Pluck(pluck) => {
                pluck.release();
                false
            }
            EngineState::Bow(bow) => {
                bow.release();
                false
            }
            EngineState::Wind(wind) => {
                wind.release();
                true
            }
            EngineState::Driven(voice) => {
                voice.breath.release();
                voice.breathing
            }
            EngineState::Idle => false,
        };
        if !blown {
            return;
        }
        // Blown objects settle fast once the air stops, freeing their pool slot.
        self.release_t60 = 0.3;
        if let EngineState::Driven(voice) = &mut self.state {
            let (live, on) = (&self.live, &self.on);
            voice.bank_a.retune(live.freq_a,
                t60_scale(live.damping_a) / t60_scale(on.damping_a) * self.release_t60,
                live.width_a, 1.0);
        }
        if self.has_b {
            self.retune_b();
        }
    }

    fn force_stop(&mut self) {
        self.gate = false;
        self.active = false;
    }

    fn start_glide(&mut self, target_frequency: f32, _glide_duration: f64) {
        // Applied at the top of the next process(), which has `shared`, before any sample renders.
        self.frequency = target_frequency;
        self.pending_glide = target_frequency;
    }

    fn gate(&self) -> bool {
        self.gate
    }

    fn current_frequency(&self) -> f32 {
        self.frequency
    }

    fn process(&mut self, output: [&mut [f32]; 2], _block: &abi::Block, shared: &Self::Shared) -> bool {
        if !self.active {
            return true;
        }
        if self.pending_glide > 0.0 {
            let frequency = self.pending_glide;
            self.pending_glide = 0.0;
            self.seed(frequency, self.velocity, shared);
        }
        let level_from = 2.0 * self.live.level_a;
        self.update_live(shared);
        let level_to = 2.0 * self.live.level_a;
        let [out_left, out_right] = output;
        let len = out_left.len().min(CHUNK_MAX);
        let level_step = (level_to - level_from) / len as f32;
        let mut voice_l = [0.0f32; CHUNK_MAX];
        let mut voice_r = [0.0f32; CHUNK_MAX];
        let mut drive = [0.0f32; CHUNK_MAX];
        let mut mono = [0.0f32; CHUNK_MAX];
        let mut floor = 0.0f32;
        match &mut self.state {
            EngineState::Idle => return true,
            EngineState::Pluck(pluck) => {
                pluck.render(&shared.body, &mut voice_l[..len], &mut voice_r[..len], &mut drive[..len]);
            }
            EngineState::Bow(bow) => {
                bow.render(&mut voice_l[..len], &mut voice_r[..len], &mut drive[..len]);
            }
            EngineState::Wind(wind) => {
                wind.render(&mut voice_l[..len], &mut voice_r[..len], &mut drive[..len]);
            }
            EngineState::Driven(voice) => {
                if voice.breathing {
                    for sample in drive[..len].iter_mut() {
                        *sample = voice.breath.tick() * BREATH_DRIVE;
                    }
                    floor = voice.breath.level() * 1.0e-3;
                } else {
                    for index in 0..len {
                        drive[index] = voice.strike.tick();
                        let contact = voice.strike.contact() * (level_from + level_step * (index + 1) as f32);
                        voice_l[index] = contact;
                        voice_r[index] = contact;
                    }
                }
                voice.bank_a.render(&drive[..len], &mut voice_l[..len], &mut voice_r[..len],
                    &mut mono[..len], self.gain_a, level_from, level_to);
            }
        }
        let driven = matches!(self.state, EngineState::Driven(_));
        if !driven && self.gain_a != 1.0 {
            for index in 0..len {
                voice_l[index] *= self.gain_a;
                voice_r[index] *= self.gain_a;
            }
        }
        if self.has_b && !driven && self.serial {
            let air = match self.state {
                EngineState::Bow(_) => BOW_SERIAL_AIR,
                EngineState::Wind(_) => WIND_SERIAL_AIR,
                _ => 0.0,
            };
            for index in 0..len {
                mono[index] = 0.5 * (voice_l[index] + voice_r[index]) + air * drive[index];
            }
        }
        // Level A scales what A adds to the mix, never the serial feed B rings from.
        if !driven && (level_from != 1.0 || level_to != 1.0) {
            for index in 0..len {
                let level = level_from + level_step * (index + 1) as f32;
                voice_l[index] *= level;
                voice_r[index] *= level;
            }
        }
        if self.has_b {
            let mut mono_b = [0.0f32; CHUNK_MAX];
            let source: &[f32] = if self.serial {&mono[..len]} else {&drive[..len]};
            self.bank_b.render(source, &mut voice_l[..len], &mut voice_r[..len], &mut mono_b[..len],
                self.gain_b, level_from, level_to);
        }
        if let EngineState::Driven(voice) = &mut self.state {
            if voice.breathing {
                let bleed_gain = BREATH_BLEED * 4.0 * self.live.air * self.live.air;
                for index in 0..len {
                    let bleed = drive[index] * bleed_gain * (level_from + level_step * (index + 1) as f32);
                    let pulse = voice.breath.pulse(0.5 * self.live.vibrato);
                    voice_l[index] = (voice_l[index] + bleed) * pulse;
                    voice_r[index] = (voice_r[index] + bleed) * pulse;
                }
            } else if self.live.vibrato > 0.0 {
                let depth = 0.6 * (3.0 * self.live.vibrato).min(1.0);
                let step = motor_rate(shared.vibrato) / shared.sample_rate;
                for index in 0..len {
                    let gain = 1.0 + depth * sinf(2.0 * PI * (shared.motor_phase + index as f32 * step));
                    voice_l[index] *= gain;
                    voice_r[index] *= gain;
                }
            }
        }
        let mut peak = floor;
        for index in 0..len {
            out_left[index] += voice_l[index];
            out_right[index] += voice_r[index];
            peak = peak.max(fabsf(voice_l[index])).max(fabsf(voice_r[index]));
        }
        // A held note is never done — slow bow/breath attacks are quiet for their first
        // ~50ms and must not be freed mid-swell. Tail detection only runs after release.
        if peak < TAIL_THRESHOLD && !self.gate {
            self.tail_blocks += 1;
            if self.tail_blocks >= TAIL_SILENCE_BLOCKS {
                self.active = false;
                return true;
            }
        } else {
            self.tail_blocks = 0;
        }
        false
    }
}

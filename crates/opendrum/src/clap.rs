//! openDrum Clap: Hands bursts of noise, Gap apart (Last scales the final gap: 1 even like the 808, 0.7 early like
//! the 909), each rising over Attack and falling over Decay, with a short bright Snap at its start. The noise passes a
//! resonant high-pass at Tone (Resonance) and a soft low-pass above it, the lopsided band of both machines. A Room
//! tail starts with the last hand and darkens as it fades. Spread loosens timing, tone and level per hand, Velocity
//! sets how many hands join in.

use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use dsp::RENDER_QUANTUM;
use crate::common::{drive_makeup, Cut, Drive, DRIVE_BIAS};
use crate::common::Play;

pub const VOICES: usize = 8;
pub const MAX_HANDS: usize = 8;
// Level in dB, at or below this the room is off
pub const LEVEL_OFF: f32 = -48.0;

// above this gap (the machines') the burst fade stretches with the gap squared: the wider the gap, the further up
// the previous burst still is when the next one starts
const GAP_REFERENCE: f32 = 0.0116;
// Spread at 1 moves a hand by up to this share of Gap, its tone by up to half an octave, its level by up to 6 dB
const SPREAD_TIME: f32 = 0.35;
const SPREAD_TONE: f32 = 0.5;
const SPREAD_LEVEL: f32 = 0.5;
// after the burst envelope a plain high-pass at this share of Tone removes the lows the fast envelope smears down
const AFTER_HIGH: f32 = 0.6;
// the soft 1-pole low-pass above the resonant peak (a 2-pole one takes too much of the top)
const BRIGHT_RATIO: f32 = 2.0;
// Resonance maps the high-pass Q (fitted: 808 about 4, 909 2 to 2.8)
const Q_LOW: f32 = 0.7;
const Q_HIGH: f32 = 6.0;
// Snap: high-passed noise at each hand's start, gone (-60 dB) after this time
const SNAP_TIME: f32 = 0.004;
const SNAP_HIGH: f32 = 2000.0;
// the room: a band just below Tone whose low-pass closes from OPEN to CLOSED times Tone as it fades
const ROOM_TONE: f32 = 0.95;
const ROOM_Q: f32 = 1.2;
const ROOM_OPEN: f32 = 1.6;
const ROOM_CLOSED: f32 = 1.0;
const ROOM_UPDATE: u32 = 32;
const ROOM_ATTACK: f32 = 0.001;
const ROOM_HOLD: f32 = 0.008;
// in Gate a hit ends this fast when its note ends
const RELEASE: f32 = 0.005;
// the room falls fast, then lingers quietly (the references hold about -30 dB from 100 to 200 ms)
const ROOM_CURVE: f32 = -0.6;
// under the room a quiet second stage fades far longer (the 808 is still at -71 dB after 1.9 s)
const ROOM_TAIL_LEVEL: f32 = 0.16;
const ROOM_TAIL_TIME: f32 = 6.0;
const OUTPUT_GAIN: f32 = 3.0;
const SILENT: f32 = 0.0001;
const DRIVE_DC_BLOCK: f32 = 30.0;
const DRIVE_BIAS_FULL: f32 = 12.0;
// the drive's ceiling in engine level (the 808 clap's bursts peak at 2.6), a power of two so Drive 0 stays bit exact
const DRIVE_CEILING: f32 = 4.0;
// the default hit peaks just under full scale, as the Kick and Tom do (-8.6 dB)
const OUTPUT_TRIM: f32 = 0.3715;

/// Times in seconds, Tone in Hz, Room, Drive and Volume in dB, Hands 1 to 8, Last as a share of Gap, the rest 0 to 1.
/// Tail is the amount of the room's long quiet second stage.
#[derive(Clone, Copy, Debug)]
pub struct ClapParams {
    pub hands: f32,
    pub gap: f32,
    pub last: f32,
    pub spread: f32,
    pub attack: f32,
    pub decay: f32,
    pub snap: f32,
    pub drive: f32,
    pub tone: f32,
    pub resonance: f32,
    pub room: f32,
    pub room_decay: f32,
    pub tail: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for ClapParams {
    fn default() -> Self {
        Self {
            hands: 4.0, gap: 0.0115, last: 1.0, spread: 0.0, attack: 0.0, decay: 0.027, snap: 0.2, drive: 0.0,
            tone: 1000.0, resonance: 0.6, room: -4.0, room_decay: 0.25, tail: 0.0, volume: 0.0, velocity: 0.5, play: Play::Mono
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Hand {
    start: u32,
    level: f32,
    tone: f32
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    id: u32,
    level: f32,
    transpose: f32,
    elapsed: u32,
    hands: [Hand; MAX_HANDS],
    count: usize,
    current: usize,
    burst: f32,
    rise: u32,
    rise_step: f32,
    burst_factor: f32,
    snap: f32,
    snap_factor: f32,
    burst_high: Svf,
    burst_after: Svf,
    burst_after_coefficients: SvfCoefficients,
    burst_coefficients: SvfCoefficients,
    burst_low: f32,
    burst_low_coefficient: f32,
    room: HitEnvelope,
    room_tail: HitEnvelope,
    room_level: f32,
    room_high: Svf,
    snap_high: Svf,
    room_low: Svf,
    room_low_coefficients: SvfCoefficients,
    noise: WhiteNoise,
    cut: Cut
}

impl Voice {
    fn start(&mut self, id: u32, seed: u32, strength: f32, transpose: f32, params: &ClapParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.level = strength;
        self.transpose = transpose;
        self.elapsed = 0;
        self.noise.reset(seed.wrapping_mul(0x85EB_CA6B) ^ 0xC1A9);
        let mut random = WhiteNoise::default();
        random.reset(seed.wrapping_mul(0x9E37_79B9) ^ 0x4A2D);
        let hands = libm::roundf(params.hands.clamp(1.0, MAX_HANDS as f32)) as usize;
        self.count = (libm::ceilf(hands as f32 * strength) as usize).clamp(1, hands);
        let gap = params.gap.max(0.0) * sample_rate;
        let mut time = 0.0;
        for index in 0..self.count {
            if index > 0 {
                let step = if index == self.count - 1 && self.count > 2 {gap * params.last.max(0.0)} else {gap};
                time += step * (1.0 + params.spread * SPREAD_TIME * random.next());
            }
            self.hands[index] = Hand {
                start: if index == 0 {0} else {time.max(0.0) as u32},
                level: 1.0 - params.spread * SPREAD_LEVEL * 0.5 * (random.next() + 1.0),
                tone: libm::exp2f(params.spread * SPREAD_TONE * random.next())
            };
        }
        self.current = usize::MAX;
        self.rise = 0;
        let wider = (params.gap / GAP_REFERENCE).max(1.0);
        let stretch = wider * wider;
        self.burst_factor = libm::expf(libm::logf(0.001) / (params.decay.max(0.0005) * stretch * sample_rate));
        self.snap_factor = libm::expf(libm::logf(0.001) / (SNAP_TIME * sample_rate));
        if restart {
            self.burst_high.reset();
            self.burst_after.reset();
            self.burst_low = 0.0;
            self.room_high.reset();
            self.snap_high.reset();
            self.room_low.reset();
            self.burst = 0.0;
            self.snap = 0.0;
            self.room.stop();
            self.room_tail.stop();
        }
        self.room_tail.set(ROOM_ATTACK, ROOM_HOLD, params.room_decay.max(0.01) * ROOM_TAIL_TIME, sample_rate);
        self.room_tail.set_floor(0.0001);
        self.room.set(ROOM_ATTACK, ROOM_HOLD, params.room_decay.max(0.01), sample_rate);
        self.room.set_curve(ROOM_CURVE);
        self.cut.reset();
    }

    #[inline]
    fn render(&mut self, params: &ClapParams, room_level: f32, room_high: &SvfCoefficients, snap_high: &SvfCoefficients,
              sample_rate: f32) -> f32 {
        let next = if self.current == usize::MAX {0} else {self.current + 1};
        let nyquist_guard = sample_rate * 0.45;
        let key = libm::exp2f(self.transpose / 12.0);
        if next < self.count && self.elapsed >= self.hands[next].start {
            self.current = next;
            let hand = self.hands[next];
            self.rise = (params.attack.max(0.0) * sample_rate) as u32;
            match self.rise {
                0 => self.burst = hand.level,
                rise => self.rise_step = (hand.level - self.burst) / rise as f32
            }
            self.snap = hand.level * params.snap.max(0.0);
            let tone = params.tone * key * hand.tone;
            let q = Q_LOW * libm::powf(Q_HIGH / Q_LOW, params.resonance.clamp(0.0, 1.0));
            self.burst_coefficients = SvfCoefficients::new(tone.min(nyquist_guard), q, sample_rate);
            let after = (tone * AFTER_HIGH).min(nyquist_guard);
            self.burst_after_coefficients = SvfCoefficients::new(after, 0.707, sample_rate);
            let bright = (tone * BRIGHT_RATIO).min(nyquist_guard);
            self.burst_low_coefficient = 1.0 - libm::expf(-2.0 * core::f32::consts::PI * bright / sample_rate);
            if next == self.count - 1 && room_level > 0.0 {
                self.room_level = room_level;
                let tail = room_level * ROOM_TAIL_LEVEL * params.tail.clamp(0.0, 1.0);
                self.room.trigger(room_level);
                if tail > 0.0 {self.room_tail.trigger(tail);}
            }
        }
        let white = self.noise.next();
        let high = self.burst_high.process(white, &self.burst_coefficients).high;
        self.burst_low += (high - self.burst_low) * self.burst_low_coefficient;
        if self.rise > 0 {
            self.burst += self.rise_step;
            self.rise -= 1;
        } else {
            self.burst *= self.burst_factor;
        }
        let snap = self.snap_high.process(white, snap_high).high * self.snap;
        self.snap *= self.snap_factor;
        let room_envelope = self.room.next() + self.room_tail.next();
        if self.elapsed % ROOM_UPDATE == 0 {
            let open = (room_envelope / self.room_level.max(SILENT)).clamp(0.0, 1.0);
            let cutoff = params.tone * key * (ROOM_CLOSED + (ROOM_OPEN - ROOM_CLOSED) * open);
            self.room_low_coefficients = SvfCoefficients::new(cutoff.min(nyquist_guard), 0.707, sample_rate);
        }
        self.elapsed = self.elapsed.saturating_add(1);
        let band = self.room_high.process(white, room_high).high;
        let room = self.room_low.process(band, &self.room_low_coefficients).low * room_envelope;
        let quiet = self.burst < SILENT && self.snap < SILENT && self.rise == 0;
        let room_idle = self.room.is_idle() && self.room_tail.is_idle();
        let cut = self.cut.next();
        let ended = self.current != usize::MAX && self.current + 1 >= self.count && quiet && room_idle;
        if ended || self.cut.is_done() {self.active = false;}
        let burst = self.burst_after.process(self.burst_low * self.burst, &self.burst_after_coefficients).high;
        (burst + snap + room) * self.level * OUTPUT_GAIN * cut
    }
}

pub struct Clap {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32,
    drive: Drive,
    dry: [f32; RENDER_QUANTUM]
}

impl Clap {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0, drive: Drive::new(DRIVE_DC_BLOCK),
            dry: [0.0; RENDER_QUANTUM]}
    }

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad) moves Tone.
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &ClapParams) {
        self.hits = self.hits.wrapping_add(1);
        let strength = 1.0 - params.velocity * (1.0 - velocity.clamp(0.0, 1.0));
        let index = match params.play {
            Play::Poly => self.voices.iter().position(|voice| !voice.active).unwrap_or((self.hits as usize) % VOICES),
            _ => 0
        };
        let (hits, sample_rate) = (self.hits, self.sample_rate);
        self.voices[index].start(id, hits, strength, transpose, params, sample_rate);
    }

    pub fn process(&mut self, params: &ClapParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let room_level = if params.room <= LEVEL_OFF {0.0} else {libm::powf(10.0, params.room / 20.0)};
        let room = SvfCoefficients::new((params.tone * ROOM_TONE).min(sample_rate * 0.45), ROOM_Q, sample_rate);
        let snap = SvfCoefficients::new(SNAP_HIGH.min(sample_rate * 0.45), 0.707, sample_rate);
        let level = libm::powf(10.0, params.volume / 20.0) * DRIVE_CEILING * drive_makeup(params.drive) * OUTPUT_TRIM;
        let bias = DRIVE_BIAS * (params.drive / DRIVE_BIAS_FULL).clamp(0.0, 1.0);
        for chunk in output.chunks_mut(RENDER_QUANTUM) {
            let frames = chunk.len();
            for frame in 0..frames {
                let mix: f32 = self.voices.iter_mut().filter(|voice| voice.active)
                    .map(|voice| voice.render(params, room_level, &room, &snap, sample_rate)).sum();
                self.dry[frame] = mix / DRIVE_CEILING;
            }
            self.drive.process(params.drive, bias, sample_rate, &self.dry, chunk);
            chunk.iter_mut().for_each(|value| *value *= level);
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}

    voice_queries!(ClapParams, RELEASE);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &ClapParams, seconds: f32) -> Vec<f32> {
        let mut clap = Clap::new(RATE);
        clap.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        clap.process(params, &mut output);
        output
    }

    fn rms(samples: &[f32]) -> f32 {libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len().max(1) as f32)}

    fn window(samples: &[f32], ms: f32, length: f32) -> f32 {
        rms(&samples[(ms * RATE / 1000.0) as usize..((ms + length) * RATE / 1000.0) as usize])
    }

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = ClapParams {hands: 1.0, gap: 0.0, last: 0.0, spread: 0.0, attack: 0.0, decay: 0.001, snap: 0.0,
            drive: 0.0, tone: 200.0, resonance: 0.0, room: LEVEL_OFF, room_decay: 0.01, tail: 0.0, volume: -36.0, velocity: 0.0,
            play: Play::Mono};
        let high = ClapParams {hands: 8.0, gap: 0.05, last: 2.0, spread: 1.0, attack: 0.01, decay: 0.2, snap: 1.0,
            drive: 36.0, tone: 12000.0, resonance: 1.0, room: 0.0, room_decay: 2.0, tail: 1.0, volume: 0.0, velocity: 1.0,
            play: Play::Poly};
        for params in [low, high, ClapParams::default()] {
            let samples = render(&params, 2.5);
            assert!(samples.iter().all(|value| value.is_finite()));
            assert!(samples.iter().all(|value| value.abs() < 4.0));
        }
    }

    #[test]
    fn identical_renders() {
        let params = ClapParams {spread: 0.7, ..ClapParams::default()};
        assert_eq!(render(&params, 0.5), render(&params, 0.5));
    }

    #[test]
    fn four_hands_burst_at_the_gaps_and_dip_between() {
        let samples = render(&ClapParams {room: LEVEL_OFF, last: 0.7, ..ClapParams::default()}, 0.1);
        for onset in [0.0, 11.5, 23.0] {
            assert!(window(&samples, onset, 2.0) > window(&samples, onset + 6.0, 2.0) * 4.0, "a burst falls before the next");
        }
        assert!(window(&samples, 31.0, 2.0) > window(&samples, 28.0, 2.0) * 3.0, "the last hand comes early, at 31 ms");
    }

    #[test]
    fn the_room_rings_after_the_last_hand_and_ends_silent() {
        let params = ClapParams {room_decay: 0.2, tail: 0.5, ..ClapParams::default()};
        let (with_room, dry) = (render(&params, 0.4), render(&ClapParams {room: LEVEL_OFF, ..params}, 0.4));
        assert!(window(&with_room, 60.0, 10.0) > window(&dry, 60.0, 10.0) * 10.0);
        let mut clap = Clap::new(RATE);
        clap.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (0.6 * RATE) as usize];
        clap.process(&params, &mut output);
        assert!(!clap.is_silent(), "the quiet second stage rings on past the room decay");
        let mut rest = vec![0.0; (1.2 * RATE) as usize];
        clap.process(&params, &mut rest);
        assert!(clap.is_silent(), "both stages end within 1.8 s");
    }

    #[test]
    fn a_mono_retrigger_lets_the_room_ring_on() {
        let params = ClapParams {attack: 0.005, ..ClapParams::default()};
        let mut clap = Clap::new(RATE);
        clap.note_on(1, 1.0, 0.0, &params);
        let mut first = vec![0.0; (0.2 * RATE) as usize];
        clap.process(&params, &mut first);
        clap.note_on(2, 1.0, 0.0, &params);
        let mut second = vec![0.0; (0.01 * RATE) as usize];
        clap.process(&params, &mut second);
        let before = rms(&first[first.len() - (0.001 * RATE) as usize..]);
        let after = window(&second, 0.0, 1.0);
        assert!(before > 0.0 && after > before * 0.5, "the room carries on, {before} -> {after}");
    }

    #[test]
    fn soft_velocity_brings_fewer_hands() {
        let params = ClapParams {velocity: 1.0, room: LEVEL_OFF, ..ClapParams::default()};
        let mut clap = Clap::new(RATE);
        clap.note_on(1, 0.25, 0.0, &params);
        let mut soft = vec![0.0; (0.1 * RATE) as usize];
        clap.process(&params, &mut soft);
        assert!(window(&soft, 23.0, 2.0) < window(&soft, 0.0, 2.0) * 0.01, "one hand only, nothing at 23 ms");
    }
}

use abi::{Bar, BlockFlags, EventRecord, Harmony, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_guitar::device::{self, param, State};
use device_guitar::strum;

const RATE: f32 = 48_000.0;
const MAJOR: i32 = 0b1001_0001;
// The native harmony is one global test seam, tests that set it take turns.
static HARMONY: std::sync::Mutex<()> = std::sync::Mutex::new(());

const BLANK: EventRecord = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};

fn four_four(pulse: f64) -> Bar {
    Bar {start: (pulse / 3840.0).floor() * 3840.0, length: 3840.0, beat: 960.0}
}

fn three_four(pulse: f64) -> Bar {
    Bar {start: (pulse / 2880.0).floor() * 2880.0, length: 2880.0, beat: 960.0}
}

fn state() -> Box<State> {
    let mut state: Box<State> = unsafe {Box::new_zeroed().assume_init()};
    state.init_in_place(RATE);
    state
}

fn pattern(state: &mut State, kinds: &[i32]) {
    let mut lane = [0i32; 64];
    lane[..kinds.len()].copy_from_slice(kinds);
    state.set_lane(0, &lane);
    state.set_length(kinds.len() as i32);
}

fn playing() -> BlockFlags {
    BlockFlags::create(true, false, true, false)
}

fn strokes(state: &mut State, from: f64, to: f64, bar_at: fn(f64) -> Bar) -> Vec<EventRecord> {
    let mut out = [BLANK; 64];
    let count = device::generate(state, from, to, playing(), bar_at, &mut out);
    out[..count].to_vec()
}

fn render(state: &mut State, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    for (chunk_left, chunk_right) in left.chunks_mut(128).zip(right.chunks_mut(128)) {
        device::render(state, [chunk_left, chunk_right]);
    }
    (left, right)
}

fn rms(signal: &[f32]) -> f32 {
    (signal.iter().map(|value| value * value).sum::<f32>() / signal.len().max(1) as f32).sqrt()
}

#[test]
fn the_pattern_places_its_strokes_on_the_rate_grid() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, 0, 0, 0, strum::UP, 0, 0, 0]);
    let events = strokes(&mut state, 0.0, 3840.0, four_four);
    let found: Vec<(f64, u32)> = events.iter().map(|event| (event.position, event.pitch)).collect();
    assert_eq!(found, vec![(0.0, 1), (960.0, 2), (1920.0, 1), (2880.0, 2)]);
}

#[test]
fn half_and_double_rate() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::UP]);
    device::apply_parameter(&mut state, param::RATE, ParamValue::Int(0));
    assert_eq!(strokes(&mut state, 0.0, 960.0, four_four).len(), 2);
    device::apply_parameter(&mut state, param::RATE, ParamValue::Int(2));
    assert_eq!(strokes(&mut state, 0.0, 960.0, four_four).len(), 8);
}

#[test]
fn swing_delays_the_offbeat_steps() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, strum::UP]);
    device::apply_parameter(&mut state, param::SWING, ParamValue::Float(0.5));
    let positions: Vec<f64> = strokes(&mut state, 0.0, 960.0, four_four).iter().map(|event| event.position).collect();
    assert_eq!(positions, vec![0.0, 300.0, 480.0, 780.0]);
}

#[test]
fn blocks_split_anywhere_yield_the_same_strokes() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN, 0, strum::UP, strum::MUTE]);
    device::apply_parameter(&mut state, param::SWING, ParamValue::Float(0.3));
    let whole: Vec<f64> = strokes(&mut state, 0.0, 7680.0, four_four).iter().map(|event| event.position).collect();
    let mut split = Vec::new();
    let mut from = 0.0;
    while from < 7680.0 {
        let to = (from + 97.3f64).min(7680.0);
        split.extend(strokes(&mut state, from, to, four_four).iter().map(|event| event.position));
        from = to;
    }
    assert_eq!(whole, split);
}

#[test]
fn the_pattern_restarts_with_every_bar() {
    let mut state = state();
    let mut kinds = vec![0; 16];
    kinds[0] = strum::BASS;
    kinds[12] = strum::DOWN;
    pattern(&mut state, &kinds);
    let events = strokes(&mut state, 0.0, 2880.0 * 2.0, three_four);
    let kinds: Vec<u32> = events.iter().map(|event| event.pitch).collect();
    assert_eq!(kinds, vec![strum::BASS as u32, strum::BASS as u32]);
}

#[test]
fn keys_mode_strums_nothing_on_its_own() {
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    device::apply_parameter(&mut state, param::MODE, ParamValue::Int(1));
    assert!(strokes(&mut state, 0.0, 3840.0, four_four).is_empty());
}

#[test]
fn notes_land_on_separate_strings_and_stop_on_release() {
    let mut state = state();
    for (id, pitch) in [(1u32, 48u32), (2, 52), (3, 55)] {
        device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_ON, id, pitch, velocity: 0.9, ..BLANK});
    }
    let (left, _) = render(&mut state, 9600);
    assert!(rms(&left[4800..]) > 1.0e-3);
    let display = state.display();
    let sounding: Vec<usize> = (0..6).filter(|string| display[*string] >= 0).collect();
    assert_eq!(sounding.len(), 3);
    for (id, pitch) in [(1u32, 48u32), (2, 52), (3, 55)] {
        device::handle(&mut state, &EventRecord {kind: EVENT_NOTE_OFF, id, pitch, ..BLANK});
    }
    let (left, _) = render(&mut state, 24000);
    assert!(rms(&left[19200..]) < 1.0e-4);
}

#[test]
fn a_stroke_strums_the_chord_track_and_stays_silent_without_a_chord() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = state();
    pattern(&mut state, &[strum::DOWN]);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    assert_eq!(state.display(), [-1, 3, 2, 0, 1, 0]);
    let (left, right) = render(&mut state, 24000);
    assert!(rms(&left) > 1.0e-3 && rms(&right) > 1.0e-3);
    assert!(left.iter().chain(right.iter()).all(|value| value.is_finite() && value.abs() < 2.0));
    let mut silent = self::state();
    pattern(&mut silent, &[strum::DOWN]);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: None});
    let events = strokes(&mut silent, 0.0, 240.0, four_four);
    device::handle(&mut silent, &events[0]);
    let (left, _) = render(&mut silent, 4800);
    assert_eq!(rms(&left), 0.0);
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn every_body_strums_at_a_similar_level_without_clipping() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut levels = Vec::new();
    for body in 0..8 {
        let (mut peak, mut energy) = (0.0f32, 0.0f32);
        for root in [0, 7, 9, 5] {
            let mut state = state();
            pattern(&mut state, &[strum::DOWN]);
            device::apply_parameter(&mut state, param::BODY, ParamValue::Int(body));
            let minor = if root == 9 {0b1000_1001} else {MAJOR};
            abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((root, minor))});
            let events = strokes(&mut state, 0.0, 240.0, four_four);
            device::handle(&mut state, &events[0]);
            let (left, right) = render(&mut state, 48000);
            peak = left.iter().chain(right.iter()).fold(peak, |peak, value| peak.max(value.abs()));
            energy += rms(&left) * rms(&left);
        }
        assert!(20.0 * peak.log10() < -3.0, "body {body} peaks at {:.1} dB", 20.0 * peak.log10());
        levels.push(10.0 * (energy / 4.0).log10());
    }
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
    let (low, high) = levels.iter().fold((f32::MAX, f32::MIN), |(low, high), level| (low.min(*level), high.max(*level)));
    assert!(high - low < 3.0, "levels {levels:?}");
}

// The spectral centroid of a strum, past its first 50 ms.
fn centroid(signal: &[f32]) -> f32 {
    let (mut weighted, mut total) = (0.0f64, 0.0f64);
    for frequency in (40..6000).step_by(20) {
        let (mut real, mut imaginary) = (0.0f64, 0.0f64);
        for (index, value) in signal[2400..2400 + 8192].iter().enumerate() {
            let phase = 2.0 * std::f64::consts::PI * frequency as f64 * index as f64 / 48000.0;
            real += *value as f64 * phase.cos();
            imaginary += *value as f64 * phase.sin();
        }
        let power = real * real + imaginary * imaginary;
        weighted += power * frequency as f64;
        total += power;
    }
    (weighted / total) as f32
}

fn strum_centroid(kind: i32, setup: impl Fn(&mut State)) -> f32 {
    let mut state = state();
    pattern(&mut state, &[kind]);
    setup(&mut state);
    let events = strokes(&mut state, 0.0, 240.0, four_four);
    device::handle(&mut state, &events[0]);
    centroid(&render(&mut state, 24000).0)
}

#[test]
fn the_bodies_change_the_tone() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let bodies: Vec<f32> = (0..8).map(|body| strum_centroid(strum::DOWN, |state| {
        device::apply_parameter(state, param::BODY, ParamValue::Int(body))
    })).collect();
    let wooden = &bodies[1..6];
    assert!(bodies[7] > bodies[6] * 1.2, "the bridge pickup is brighter than the neck pickup {bodies:?}");
    let spread = |values: &[f32]| values.iter().cloned().fold(f32::MIN, f32::max) / values.iter().cloned().fold(f32::MAX, f32::min);
    assert!(spread(&bodies) > 3.0, "bodies {bodies:?}");
    assert!(spread(wooden) > 2.0, "wooden bodies {wooden:?}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

// The sample where the first string of a single stroke starts to sound.
fn first_onset(state: &mut State) -> usize {
    let (left, _) = render(state, 4800);
    left.iter().position(|value| value.abs() > 1.0e-4).unwrap_or(usize::MAX)
}

#[test]
fn speed_variation_humanizes_the_timing_of_the_strokes() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let onsets = |variation: f32| -> Vec<usize> {
        (0..8).map(|step| {
            let mut state = state();
            pattern(&mut state, &[strum::DOWN]);
            device::apply_parameter(&mut state, param::SPEED_VARIATION, ParamValue::Float(variation));
            let from = step as f64 * 240.0;
            let events = strokes(&mut state, from, from + 240.0, four_four);
            device::handle(&mut state, &events[0]);
            first_onset(&mut state)
        }).collect()
    };
    let steady = onsets(0.0);
    let human = onsets(1.0);
    assert!(steady.iter().max().unwrap() - steady.iter().min().unwrap() <= 2, "steady {steady:?}");
    let spread = human.iter().max().unwrap() - human.iter().min().unwrap();
    assert!(spread > (0.004 * RATE) as usize && spread <= (0.012 * RATE) as usize + 1, "humanized {human:?}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn chucks_and_palm_mutes_are_heard() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let peak = |kind: i32| -> f32 {
        let mut state = state();
        pattern(&mut state, &[kind]);
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        let (left, _) = render(&mut state, 24000);
        20.0 * left.iter().fold(0.0f32, |peak, value| peak.max(value.abs())).log10()
    };
    let (down, chuck, mute) = (peak(strum::DOWN), peak(strum::CHUCK), peak(strum::MUTE));
    assert!(down - chuck < 8.0, "down {down:.1} chuck {chuck:.1}");
    assert!(down - mute < 6.0, "down {down:.1} mute {mute:.1}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn every_string_is_plucked_about_equally_hard() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let levels: Vec<f32> = (0..6).map(|string| {
        let energy: f32 = (0..8).map(|step| {
            let mut state = state();
            pattern(&mut state, &[strum::PICK]);
            state.set_lane(1, &[1 << string; 64]);
            device::apply_parameter(&mut state, param::BODY, ParamValue::Int(0));
            let from = step as f64 * 240.0;
            let events = strokes(&mut state, from, from + 240.0, four_four);
            device::handle(&mut state, &events[0]);
            let (left, _) = render(&mut state, 9600);
            rms(&left) * rms(&left)
        }).sum::<f32>() / 8.0;
        10.0 * energy.log10()
    }).collect();
    let (low, high) = levels.iter().fold((f32::MAX, f32::MIN), |(low, high), level| (low.min(*level), high.max(*level)));
    assert!(high - low < 5.0, "string levels {levels:?}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}

#[test]
fn speed_spreads_the_strum() {
    let _turn = HARMONY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((7, MAJOR))});
    let early = |speed: f32| -> f32 {
        let mut state = state();
        pattern(&mut state, &[strum::DOWN]);
        device::apply_parameter(&mut state, param::SPEED, ParamValue::Float(speed));
        let events = strokes(&mut state, 0.0, 240.0, four_four);
        device::handle(&mut state, &events[0]);
        let (left, _) = render(&mut state, 28800);
        let energy = |range: &[f32]| range.iter().map(|value| value * value).sum::<f32>();
        energy(&left[..2400]) / energy(&left)
    };
    let (fast, slow) = (early(0.0), early(1.0));
    assert!(10.0 * (fast / slow).log10() > 4.0, "fast {fast} slow {slow}");
    abi::set_native_harmony(Harmony {root: 0, bits: 0b1010_1011_0101, chord: Some((0, MAJOR))});
}


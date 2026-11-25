//! Backwards compatibility: with every new field at its default, the enhanced Arpeggio must emit exactly the
//! events of the frozen legacy device (`tests/legacy`), for any legacy parameter set, any input, any block
//! segmentation, seeks, stopped transport and parameter changes between blocks.

mod legacy;

use abi::{native_parameter_id, BlockFlags, EventRecord, ParamValue, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use device_arpeggio::{apply_parameter, process, seed, ArpState};
use legacy::LegacyState;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, bound: u64) -> u64 {self.next() % bound}
    fn chance(&mut self, probability: f64) -> bool {(self.next() % 1_000_000) as f64 / 1_000_000.0 < probability}
    fn unit(&mut self) -> f32 {(self.next() % 1_000_001) as f32 / 1_000_000.0}
}

fn blank() -> EventRecord {
    EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0}
}

fn seeded() -> ArpState {
    let mut state: ArpState = unsafe { core::mem::zeroed() };
    seed(&mut state);
    state
}

#[derive(Clone, Copy, Debug)]
struct Params {mode: i32, octaves: i32, rate: i32, gate: f32, repeat: i32, velocity: f32}

fn random_params(rng: &mut Rng) -> Params {
    const GATES: [f32; 8] = [0.0, 0.001, 0.25, 0.5, 0.73, 1.0, 1.5, 2.0];
    const VELOCITIES: [f32; 5] = [-1.0, -0.5, 0.0, 0.5, 1.0];
    Params {
        mode: rng.below(3) as i32,
        octaves: 1 + rng.below(5) as i32,
        rate: rng.below(17) as i32,
        gate: if rng.chance(0.5) { GATES[rng.below(8) as usize] } else { rng.unit() * 2.0 },
        repeat: if rng.chance(0.6) { 1 } else { 1 + rng.below(16) as i32 },
        velocity: if rng.chance(0.5) { VELOCITIES[rng.below(5) as usize] } else { rng.unit() * 2.0 - 1.0 }
    }
}

fn apply_both(state: &mut ArpState, legacy: &mut LegacyState, params: Params) {
    apply_parameter(state, native_parameter_id(&[10]), ParamValue::Int(params.mode));
    apply_parameter(state, native_parameter_id(&[11]), ParamValue::Int(params.octaves));
    apply_parameter(state, native_parameter_id(&[12]), ParamValue::Int(params.rate));
    apply_parameter(state, native_parameter_id(&[13]), ParamValue::Float(params.gate));
    apply_parameter(state, native_parameter_id(&[14]), ParamValue::Int(params.repeat));
    apply_parameter(state, native_parameter_id(&[15]), ParamValue::Float(params.velocity));
    legacy.mode = params.mode;
    legacy.octaves = params.octaves;
    legacy.set_rate_index(params.rate);
    legacy.gate = params.gate;
    legacy.repeat = params.repeat;
    legacy.set_velocity(params.velocity);
}

fn random_input(rng: &mut Rng, transporting: bool, span: f64) -> Vec<EventRecord> {
    let mut events = Vec::new();
    let notes = 1 + rng.below(8);
    let chord_start = (rng.below(span as u64 / 2)) as f64;
    for id in 0..notes as u32 {
        let start = if rng.chance(0.4) { chord_start } else if rng.chance(0.5) { (rng.below(64) * 60) as f64 } else { rng.below(span as u64) as f64 + rng.unit() as f64 };
        let duration = if !transporting && rng.chance(0.7) { f64::INFINITY } else { 1.0 + rng.below(8000) as f64 };
        let pitch = 24 + rng.below(72) as u32;
        let velocity = rng.unit();
        events.push(EventRecord {position: start, offset: 0, kind: EVENT_NOTE_ON, id, pitch, velocity, cent: 0.0, duration});
        if rng.chance(0.3) {
            let release = start + 1.0 + rng.below(4000) as f64;
            events.push(EventRecord {position: release, offset: 0, kind: EVENT_NOTE_OFF, id, pitch, velocity: 0.0, cent: 0.0, duration: 0.0});
        }
    }
    events.sort_by(|left, right| left.position.partial_cmp(&right.position).unwrap());
    events
}

fn canonical(events: &[EventRecord]) -> Vec<(u64, u32, u32, u32, u32, u64)> {
    let mut list: Vec<_> = events.iter()
        .map(|event| (event.position.to_bits(), event.kind, event.pitch, event.id, event.velocity.to_bits(), event.duration.to_bits()))
        .collect();
    list.sort();
    list
}

fn run_scenario(scenario: u64) {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ scenario.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1);
    let mut params = random_params(&mut rng);
    let mut state = seeded();
    let mut legacy = LegacyState::new(0, 1, 9, 1.0, 1, 0.0);
    apply_both(&mut state, &mut legacy, params);
    let transporting = rng.chance(0.85);
    let span = 3840.0 * (1 + rng.below(4)) as f64;
    let input = random_input(&mut rng, transporting, span);
    let mut from = 0.0f64;
    let end = span + 2000.0;
    let mut blocks = 0;
    while from < end && blocks < 4000 {
        blocks += 1;
        let size = if rng.chance(0.2) { 1 + rng.below(16) } else { 1 + rng.below(1500) } as f64;
        let to = from + size;
        let mut flags = if transporting { BlockFlags::TRANSPORTING } else { 0 };
        if blocks > 1 && rng.chance(0.03) {
            flags |= BlockFlags::DISCONTINUOUS;
        }
        if rng.chance(0.05) {
            params = random_params(&mut rng);
            apply_both(&mut state, &mut legacy, params);
        }
        let slice: Vec<EventRecord> = input.iter().filter(|event| event.position >= from && event.position < to).copied().collect();
        let mut out_new = [blank(); 512];
        let mut out_old = [blank(); 512];
        let written_new = process(&mut state, from, to, flags, &slice, &mut out_new);
        let written_old = legacy::process(&mut legacy, from, to, flags, &slice, &mut out_old);
        assert_eq!(canonical(&out_new[..written_new]), canonical(&out_old[..written_old]),
                   "scenario {scenario} block {blocks} [{from}, {to}) flags {flags} params {params:?}");
        from = if rng.chance(0.02) { rng.below(end as u64) as f64 } else { to };
    }
}

#[test]
fn matches_the_legacy_device_for_twenty_thousand_random_scenarios() {
    for scenario in 0..20_000 {
        run_scenario(scenario);
    }
}

#[test]
fn matches_the_legacy_device_on_the_whole_parameter_grid() {
    let mut scenario = 1_000_000;
    for mode in 0..3 {
        for octaves in 1..=5 {
            for rate in 0..17 {
                for repeat in [1, 2, 3, 16] {
                    let params = Params {mode, octaves, rate, gate: 1.0, repeat, velocity: 0.0};
                    let mut state = seeded();
                    let mut legacy = LegacyState::new(0, 1, 9, 1.0, 1, 0.0);
                    apply_both(&mut state, &mut legacy, params);
                    let mut rng = Rng(scenario);
                    scenario += 1;
                    let input = random_input(&mut rng, true, 7680.0);
                    let mut from = 0.0;
                    while from < 9000.0 {
                        let to = from + 128.0;
                        let slice: Vec<EventRecord> = input.iter().filter(|event| event.position >= from && event.position < to).copied().collect();
                        let mut out_new = [blank(); 512];
                        let mut out_old = [blank(); 512];
                        let written_new = process(&mut state, from, to, BlockFlags::TRANSPORTING, &slice, &mut out_new);
                        let written_old = legacy::process(&mut legacy, from, to, BlockFlags::TRANSPORTING, &slice, &mut out_old);
                        assert_eq!(canonical(&out_new[..written_new]), canonical(&out_old[..written_old]), "{params:?} [{from}, {to})");
                        from = to;
                    }
                }
            }
        }
    }
}

//! ADSR state machine: attack rises to 1, decay falls to the sustain level, sustain holds, release
//! falls to 0 then idles; plus instant (zero-time) stages and force-stop.

use dsp::adsr::Adsr;

const SR: f32 = 48_000.0;

fn advance(env: &mut Adsr, samples: usize) -> f32 {
    let mut value = 0.0;
    for _ in 0..samples {
        value = env.next_value();
    }
    value
}

#[test]
fn runs_attack_decay_sustain_release() {
    let mut env = Adsr::new(SR);
    env.set(0.1, 0.2, 0.5, 0.3); // a=0.1s d=0.2s s=0.5 r=0.3s
    env.gate_on();
    let after_attack = advance(&mut env, (0.1 * SR) as usize);
    assert!(after_attack >= 0.99, "attack reaches ~1, got {after_attack}");
    let after_decay = advance(&mut env, (0.2 * SR) as usize);
    assert!((after_decay - 0.5).abs() < 0.01, "decays to sustain, got {after_decay}");
    assert!((env.next_value() - 0.5).abs() < 0.01, "holds sustain");
    env.gate_off();
    let after_release = advance(&mut env, (0.3 * SR) as usize + 1);
    assert!(after_release < 0.01, "releases to ~0, got {after_release}");
    assert!(env.is_idle(), "idle once released");
}

#[test]
fn zero_attack_and_decay_reach_sustain_immediately() {
    let mut env = Adsr::new(SR);
    env.set(0.0, 0.0, 0.7, 0.1);
    env.gate_on();
    assert_eq!(env.next_value(), 1.0, "instant attack hits full on the first sample");
    assert!((env.next_value() - 0.7).abs() < 1e-6, "instant decay lands on sustain on the next");
}

#[test]
fn force_stop_silences_immediately() {
    let mut env = Adsr::new(SR);
    env.set(0.5, 0.5, 0.8, 0.5);
    env.gate_on();
    advance(&mut env, 100);
    env.force_stop();
    assert_eq!(env.next_value(), 0.0);
    assert!(env.is_idle());
}

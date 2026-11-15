// Restart and Offset: which step of the loops a song step reads, and that both at zero change nothing.

use device_surgeon::engine::{Engine, Slot, MAX_FRAMES};
use device_surgeon::pattern::{Pattern, LOOPS, MAX_STEPS};

const RATE: f32 = 48_000.0;
const BLOCK_PULSES: f64 = 4.0;

fn pattern(restart: u32, offset: i32) -> Pattern {
    let mut pattern = Pattern::random(7);
    pattern.restart = restart;
    pattern.offset = offset;
    pattern
}

fn steps(pattern: &Pattern) -> [u32; LOOPS] {pattern.loops().map(|(_, _, steps)| steps.clamp(1, MAX_STEPS))}

#[test]
fn without_restart_and_offset_a_step_reads_itself() {
    let pattern = pattern(0, 0);
    for step in 0..2000i64 {
        let (position, passes) = pattern.phase(step).unwrap();
        assert_eq!(position, step as u32);
        assert_eq!(passes, steps(&pattern).map(|steps| step as u32 / steps));
    }
    assert!(pattern.phase(-1).is_none());
}

#[test]
fn a_restart_starts_every_loop_again_and_mutation_runs_on() {
    let pattern = pattern(16, 0);
    let mut last = [0; LOOPS];
    for step in 0..640i64 {
        let (position, passes) = pattern.phase(step).unwrap();
        assert_eq!(position, (step % 16) as u32);
        for loop_index in 0..LOOPS {
            assert!(passes[loop_index] >= last[loop_index], "passes never go back, step {step}");
            if step % 16 == 0 && step > 0 {assert!(passes[loop_index] > last[loop_index], "a restart begins a new pass");}
        }
        last = passes;
    }
}

#[test]
fn an_offset_moves_the_steps_and_wraps_inside_a_restart() {
    let late = pattern(0, 3);
    assert_eq!(late.phase(0).unwrap().0, 3);
    let early = pattern(0, -3);
    assert!((0..3).all(|step| early.phase(step).is_none()), "before its first step the song has not reached the loops");
    assert_eq!(early.phase(3).unwrap().0, 0);
    let wrapped = pattern(16, -3);
    assert_eq!(wrapped.phase(0).unwrap().0, 13);
    assert_eq!(wrapped.phase(3).unwrap().0, 0);
    assert_eq!(pattern(16, 20).phase(0).unwrap().0, 4);
    assert_eq!(pattern(1000, 1000).phase(0), pattern(256, 128).phase(0), "limited to 256 and 128");
}

fn render(restart: u32, offset: i32, blocks: usize) -> Vec<u32> {
    let mut engine = Engine::new(RATE);
    for index in 0..engine.patterns.len() {engine.patterns[index] = pattern(restart, offset);}
    engine.select(Slot::Pattern(0));
    let mut output = vec![0.0; blocks * MAX_FRAMES];
    for block in 0..blocks {
        let p0 = block as f64 * BLOCK_PULSES;
        engine.process(p0, p0 + BLOCK_PULSES, true, false, &mut output[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    output.iter().map(|sample| sample.to_bits()).collect()
}

#[test]
fn restart_and_offset_change_what_plays() {
    let plain = render(0, 0, 1200);
    assert_ne!(plain, render(4, 0, 1200));
    assert_ne!(plain, render(0, 5, 1200));
    assert_eq!(plain, render(256, 0, 1200), "a restart after the end of the render changes nothing");
}

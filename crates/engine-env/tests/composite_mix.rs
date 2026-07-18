//! The effect composite's two own DSP nodes: the input distributor (broadcast / stereo split, and the tap a
//! nested sidechain reads) and the dry/wet mix (including the empty-composite bypass and update-clock
//! automation). Everything else a composite is built from — the per-entry strip, the wet sum — is reused, so
//! it is covered by the channel-strip / audio-bus tests.

use alloc::rc::Rc;
extern crate alloc;

use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::channel_strip::StripAutomation;
use engine_env::composite_mix::{DistributorMode, DistributorProcessor, DryWetMixProcessor, DryWetParams};
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use engine_env::RENDER_QUANTUM;

const SR: f32 = 48_000.0;

// A buffer holding a constant (left, right).
fn filled(left: f32, right: f32) -> SharedAudioBuffer {
    let buffer = shared_audio_buffer();
    {
        let mut inner = buffer.borrow_mut();
        for index in 0..RENDER_QUANTUM {
            inner.left[index] = left;
            inner.right[index] = right;
        }
    }
    buffer
}

fn distributor_with(mode: DistributorMode, left: f32, right: f32) -> DistributorProcessor {
    let mut distributor = DistributorProcessor::new(mode);
    distributor.set_audio_source(filled(left, right));
    distributor
}

#[test]
fn broadcast_hands_every_entry_the_same_untouched_signal() {
    let mut distributor = distributor_with(DistributorMode::Broadcast, 0.5, -0.25);
    distributor.process(&ProcessInfo {blocks: &[]});
    // Broadcast shares the tap itself, so every entry reads one buffer — no per-entry copy.
    let first = distributor.branch(0);
    let second = distributor.branch(7); // an index far past any entry count still resolves
    assert!(Rc::ptr_eq(&first, &second), "broadcast entries share one source buffer");
    assert!(Rc::ptr_eq(&first, &distributor.tap()), "and that buffer IS the tap");
    let buffer = first.borrow();
    assert_eq!(buffer.left[0], 0.5);
    assert_eq!(buffer.right[RENDER_QUANTUM - 1], -0.25);
}

#[test]
fn the_tap_owns_its_copy_so_it_survives_a_source_swap() {
    let mut distributor = distributor_with(DistributorMode::Broadcast, 1.0, 1.0);
    let tap = distributor.tap();
    distributor.process(&ProcessInfo {blocks: &[]});
    assert_eq!(tap.borrow().left[0], 1.0);
    // Replacing the plugin UPSTREAM of the composite re-points the distributor's source. The tap buffer's
    // identity must not change — that is what keeps a nested device's sidechain on the composite input alive.
    distributor.set_audio_source(filled(0.25, 0.25));
    distributor.process(&ProcessInfo {blocks: &[]});
    assert!(Rc::ptr_eq(&tap, &distributor.tap()), "the tap is the same buffer after a source swap");
    assert_eq!(tap.borrow().left[0], 0.25, "and it now carries the NEW upstream signal");
}

#[test]
fn a_detached_source_reads_silence_not_the_last_frozen_block() {
    let mut distributor = distributor_with(DistributorMode::Broadcast, 1.0, 1.0);
    distributor.process(&ProcessInfo {blocks: &[]});
    distributor.clear_audio_source();
    distributor.process(&ProcessInfo {blocks: &[]});
    let tap = distributor.tap();
    let buffer = tap.borrow();
    assert_eq!(buffer.left[0], 0.0);
    assert_eq!(buffer.right[0], 0.0);
}

#[test]
fn stereo_splits_the_channels_and_the_untouched_branches_recombine_exactly() {
    let mut distributor = distributor_with(DistributorMode::Stereo, 0.75, -0.5);
    distributor.process(&ProcessInfo {blocks: &[]});
    let left_branch = distributor.branch(0);
    let right_branch = distributor.branch(1);
    assert!(!Rc::ptr_eq(&left_branch, &right_branch), "a split gives each entry its own buffer");
    {
        let left = left_branch.borrow();
        assert_eq!(left.left[0], 0.75, "entry 0 gets the left channel");
        assert_eq!(left.right[0], 0.0, "and silence on the right");
        let right = right_branch.borrow();
        assert_eq!(right.left[0], 0.0, "entry 1 gets silence on the left");
        assert_eq!(right.right[0], -0.5, "and the right channel");
    }
    // Summing the untouched branches must reproduce the input EXACTLY (an empty split == a bypass).
    let left = left_branch.borrow();
    let right = right_branch.borrow();
    for index in 0..RENDER_QUANTUM {
        assert_eq!(left.left[index] + right.left[index], 0.75);
        assert_eq!(left.right[index] + right.right[index], -0.5);
    }
}

#[test]
fn a_stereo_entry_beyond_the_branch_count_reads_silence() {
    let mut distributor = distributor_with(DistributorMode::Stereo, 0.75, -0.5);
    distributor.process(&ProcessInfo {blocks: &[]});
    // An out-of-range entry reads a fixed SILENT buffer, NOT branch 0: summing an aliased branch 0 would double
    // the left channel into the wet sum (+6 dB). A split's entry count is a UI invariant, not engine-enforced.
    let extra = distributor.branch(5);
    assert!(!Rc::ptr_eq(&extra, &distributor.branch(0)), "an extra entry does not alias branch 0");
    let buffer = extra.borrow();
    for index in 0..RENDER_QUANTUM {
        assert_eq!(buffer.left[index], 0.0, "the out-of-range branch is silent (left)");
        assert_eq!(buffer.right[index], 0.0, "the out-of-range branch is silent (right)");
    }
    assert_eq!(distributor.branch(0).borrow().left[0], 0.75, "branch 0 still carries the left channel");
}

// dry = tap, wet = the entries' sum.
fn mixer(params: Rc<DryWetParams>, automation: Rc<StripAutomation>,
         tap: SharedAudioBuffer, wet: SharedAudioBuffer) -> DryWetMixProcessor {
    DryWetMixProcessor::new(params, automation, tap, wet, SR)
}

#[test]
fn leaving_bypass_ramps_the_output_instead_of_jumping() {
    let params = Rc::new(DryWetParams::new()); // dry -inf, wet 0 dB, bypass true (an empty composite)
    let tap = filled(1.0, 1.0);
    let wet = filled(-1.0, -1.0); // the wet sum differs sharply from the input, so a jump would be obvious
    let mut mix = mixer(params.clone(), Rc::new(StripAutomation::new()), tap, wet);
    // Bypassed: the input passes through, and the de-click ramps settle.
    mix.process(&ProcessInfo {blocks: &[]});
    assert_eq!(mix.audio_output().borrow().left[0], 1.0, "an empty composite passes its input through");
    // Add the first branch (bypass off). The output must RAMP from the input toward the wet mix, not JUMP: the
    // first sample stays near the bypass value; before the fix `processing=false` jumped it straight to -1.0.
    params.bypass.set(false);
    mix.process(&ProcessInfo {blocks: &[]});
    let out = mix.audio_output();
    let out = out.borrow();
    assert!((out.left[0] - 1.0).abs() < 0.05,
        "the first active sample stays near the bypass value (ramp start), not the wet mix");
    assert!(out.left[RENDER_QUANTUM - 1] < out.left[0] - 0.1, "and it ramps toward the wet mix");
}

#[test]
fn an_empty_composite_is_an_exact_identity_whatever_dry_and_wet_say() {
    let params = Rc::new(DryWetParams::new());
    params.bypass.set(true);
    // Deliberately hostile settings: dry silent, wet full. Bypass must still pass the input through.
    params.dry_db.set(f32::NEG_INFINITY);
    params.wet_db.set(0.0);
    let mut mix = mixer(params, Rc::new(StripAutomation::new()), filled(0.4, -0.6), filled(9.9, 9.9));
    mix.process(&ProcessInfo {blocks: &[]});
    let output = mix.audio_output();
    let buffer = output.borrow();
    for index in 0..RENDER_QUANTUM {
        assert_eq!(buffer.left[index], 0.4, "an empty stack must not kill the chain");
        assert_eq!(buffer.right[index], -0.6);
    }
}

#[test]
fn the_default_replaces_the_signal_dry_is_silent_and_wet_is_unity() {
    let params = Rc::new(DryWetParams::new()); // the box defaults: dry -inf dB, wet 0 dB
    params.bypass.set(false);
    let mut mix = mixer(params, Rc::new(StripAutomation::new()), filled(1.0, 1.0), filled(0.25, 0.25));
    mix.process(&ProcessInfo {blocks: &[]});
    let output = mix.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[RENDER_QUANTUM - 1] - 0.25).abs() < 1.0e-6, "wet only: the dry input is gone");
    assert!((buffer.right[RENDER_QUANTUM - 1] - 0.25).abs() < 1.0e-6);
}

#[test]
fn raising_dry_sums_the_input_alongside_the_wet_entries() {
    let params = Rc::new(DryWetParams::new());
    params.bypass.set(false);
    params.dry_db.set(0.0); // parallel-fx use: dry at unity next to the wet sum
    params.wet_db.set(0.0);
    let mut mix = mixer(params, Rc::new(StripAutomation::new()), filled(0.5, 0.5), filled(0.25, 0.25));
    mix.process(&ProcessInfo {blocks: &[]});
    let output = mix.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[RENDER_QUANTUM - 1] - 0.75).abs() < 1.0e-6, "dry + wet");
}

#[test]
fn a_silent_wet_leaves_only_the_dry_input() {
    let params = Rc::new(DryWetParams::new());
    params.bypass.set(false);
    params.dry_db.set(0.0);
    params.wet_db.set(f32::NEG_INFINITY);
    let mut mix = mixer(params, Rc::new(StripAutomation::new()), filled(0.5, 0.5), filled(9.9, 9.9));
    mix.process(&ProcessInfo {blocks: &[]});
    let output = mix.audio_output();
    let buffer = output.borrow();
    assert!((buffer.left[RENDER_QUANTUM - 1] - 0.5).abs() < 1.0e-6, "wet fully out");
}

#[test]
fn an_automated_dry_resolves_at_the_update_clock_inside_the_quantum() {
    let params = Rc::new(DryWetParams::new());
    params.bypass.set(false);
    params.wet_db.set(f32::NEG_INFINITY); // isolate dry: the output IS the dry gain applied to the input
    let automation = Rc::new(StripAutomation::new());
    // `volume` carries the dry curve: silent until the update-grid point at pulse 10, unity from there.
    *automation.volume.borrow_mut() = Some(Rc::new(|position: f64| {
        if position < 10.0 {f32::NEG_INFINITY} else {0.0}
    }));
    let mut mix = mixer(params, automation, filled(1.0, 1.0), filled(0.0, 0.0));
    // One render quantum of REAL geometry (as the aux-send test uses): 128 samples at 120 bpm span 5.12
    // pulses, and the 10-pulse update grid falls inside this block, at pulse 10 -> sample 50.
    let block = Block {
        index: 0, flags: BlockFlags(BlockFlags::TRANSPORTING | BlockFlags::PLAYING),
        p0: 8.0, p1: 13.12, s0: 0, s1: RENDER_QUANTUM as u32, bpm: 120.0
    };
    mix.process(&ProcessInfo {blocks: &[block]});
    let output = mix.audio_output();
    let buffer = output.borrow();
    assert!(buffer.left[10].abs() < 1.0e-6, "before the grid point the curve is silent");
    // Resolved ONCE per block (at p0) the whole quantum would stay silent. It must rise after the grid point.
    // It does not reach unity within the block on purpose: the 5 ms de-click ramp (240 samples) outlasts a
    // 128-sample quantum, so this asserts the ramp STARTED — which only re-resolving inside the quantum does.
    assert!(buffer.left[RENDER_QUANTUM - 1] > 0.0,
        "the curve was re-resolved INSIDE the quantum, not once per block");
    assert!(buffer.left[RENDER_QUANTUM - 1] > buffer.left[60],
        "and it is still rising (de-clicked, not a step)");
}

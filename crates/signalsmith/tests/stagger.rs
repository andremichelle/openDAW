// Does phase-staggering voices spread the FFT burst? Each SignalsmithStretch runs one heavy synthesis frame
// every `interval` (=1024) output samples = every 8 render quanta. Phase-locked voices burst in the SAME
// quantum (peak = N frames). Offsetting each voice's frame phase should spread the bursts across quanta
// (peak -> ~1 frame). This measures worst-case per-quantum cost aligned vs staggered.
use std::time::Instant;
use signalsmith::SignalsmithStretch;

const RATE: f32 = 48000.0;
const QUANTUM: usize = 128;
const CYCLE_QUANTA: usize = 8; // interval(1024) / QUANTUM
const VOICES: usize = 3;

fn source(len: usize) -> Vec<f32> {
    // deterministic broadband-ish signal so every band carries energy (worst case for the phase loop)
    (0..len).map(|index| {
        let time = index as f32 / RATE;
        0.3 * (libm::sinf(2.0*3.14159*220.0*time) + libm::sinf(2.0*3.14159*1370.0*time) + libm::sinf(2.0*3.14159*5300.0*time))
    }).collect()
}

fn run(offset_quanta: [usize; VOICES]) -> (f64, f64) {
    let src = source(400_000);
    let mut voices: Vec<SignalsmithStretch> = offset_quanta.iter().map(|quanta| {
        let mut player = SignalsmithStretch::preset_default(2, RATE);
        player.set_phase_offset(quanta * QUANTUM); // the production stagger mechanism
        player.reset_stream(2048.0);
        player
    }).collect();
    let mut ol = vec![0.0f32; QUANTUM];
    let mut or = vec![0.0f32; QUANTUM];
    for voice in voices.iter_mut() { // warm caches past the priming burst
        for _ in 0..CYCLE_QUANTA { voice.process_stream_stereo(&src, &src, &mut ol, &mut or, 1.0, 1.0, 1.0); }
    }
    let measured = 800usize;
    let mut per_quantum = Vec::with_capacity(measured);
    for _ in 0..measured {
        let start = Instant::now();
        for voice in voices.iter_mut() {
            voice.process_stream_stereo(&src, &src, &mut ol, &mut or, 1.0, 1.0, 1.0);
        }
        per_quantum.push(start.elapsed().as_nanos() as f64);
    }
    per_quantum.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let peak = per_quantum[0];
    let top16 = per_quantum[..16].iter().sum::<f64>() / 16.0; // robust peak (drops single OS hiccups)
    (peak, top16)
}

#[test]
#[ignore = "wall-clock benchmark, not a correctness gate: noisy on a busy machine. Run with --ignored."]
fn staggering_spreads_the_fft_burst() {
    // stagger offsets spread over the 8-quantum cycle so no two voices burst in the same quantum
    let (aligned_peak, aligned_top) = run([0, 0, 0]);
    let (stag_peak, stag_top) = run([0, 3, 6]);
    let budget_ns = QUANTUM as f64 / RATE as f64 * 1e9;
    println!("aligned   peak {:.1}% top16 {:.1}%", aligned_peak/budget_ns*100.0, aligned_top/budget_ns*100.0);
    println!("staggered peak {:.1}% top16 {:.1}%", stag_peak/budget_ns*100.0, stag_top/budget_ns*100.0);
    println!("top16 reduction: {:.2}x", aligned_top/stag_top);
    assert!(stag_top < aligned_top * 0.6, "staggering should cut the robust peak substantially");
}

// A phase offset must only DELAY the voice by `offset` samples, never distort it: the offset output, shifted
// back by `offset`, should match the un-offset output. (Compared in the steady state, past the priming ramp.)
#[test]
fn phase_offset_is_a_pure_delay() {
    let src = source(200_000);
    let offset = 3 * QUANTUM; // 384 samples
    let total = 40 * QUANTUM;
    let render = |off: usize| -> Vec<f32> {
        let mut player = SignalsmithStretch::preset_default(2, RATE);
        player.set_phase_offset(off);
        player.reset_stream(2048.0);
        let mut out = vec![0.0f32; total];
        let mut scratch = vec![0.0f32; QUANTUM];
        for chunk in out.chunks_mut(QUANTUM) {
            player.process_stream_stereo(&src, &src, chunk, &mut scratch, 1.0, 1.0, 1.0);
        }
        out
    };
    let base = render(0);
    let shifted = render(offset);
    // compare a steady-state window, aligning `shifted[i+offset]` with `base[i]`
    let (start, end) = (8 * QUANTUM, 30 * QUANTUM);
    let mut num = 0.0f64; let mut den = 0.0f64;
    for i in start..end {
        let diff = (shifted[i + offset] - base[i]) as f64;
        num += diff * diff; den += (base[i] as f64).powi(2);
    }
    let rel = (num / den.max(1e-12)).sqrt();
    println!("phase-offset delay error: {:.2e} (relative RMS)", rel);
    assert!(rel < 1e-3, "phase offset must be a pure delay, got relative error {rel:.2e}");
}


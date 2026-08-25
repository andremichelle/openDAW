// Speed shoot-out for the convolver layouts ("write tests to see what is the fastest").
// Run: cargo test -p dsp --release --test convolution_bench -- --ignored --nocapture
// Reports per-128-frame-quantum cost (mean / p99 / worst) against the 48 kHz budget of 2666 us.

use dsp::convolution::{spectral_mac, Convolver, Level, BLOCK};
use std::time::Instant;

const BUDGET_US_48K: f64 = 128.0 / 48000.0 * 1e6;

fn boxed_zeroed<T>() -> Box<T> {
    let layout = std::alloc::Layout::new::<T>();
    unsafe { Box::from_raw(std::alloc::alloc_zeroed(layout) as *mut T) }
}

struct Rng(u64);

impl Rng {
    fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f32 / (1u64 << 31) as f32) - 1.0
    }
}

fn stats(label: &str, mut times: Vec<f64>) {
    times.sort_by(f64::total_cmp);
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let p99 = times[(times.len() as f64 * 0.99) as usize];
    let worst = *times.last().unwrap();
    println!("{label:<44} mean {mean:8.1} us  p99 {p99:8.1} us  worst {worst:8.1} us  ({:5.1}% budget mean, {:5.1}% worst)",
             mean / BUDGET_US_48K * 100.0, worst / BUDGET_US_48K * 100.0);
}

fn bench_canonical(ir_frames: usize) {
    let mut rng = Rng(1);
    let ir_l: Vec<f32> = (0..ir_frames).map(|_| rng.next_f32()).collect();
    let ir_r: Vec<f32> = (0..ir_frames).map(|_| rng.next_f32()).collect();
    let mut convolver = boxed_zeroed::<Convolver>();
    convolver.init();
    convolver.dry_gain = 0.0;
    convolver.begin_load(&ir_l, &ir_r, true, false, false);
    while convolver.load_step(&ir_l, &ir_r, 64) {}
    let input: Vec<f32> = (0..BLOCK).map(|_| rng.next_f32()).collect();
    let mut out_l = vec![0.0f32; BLOCK];
    let mut out_r = vec![0.0f32; BLOCK];
    let quanta = 6400;
    for _ in 0..256 {
        convolver.process(&input, &input, &mut out_l, &mut out_r, 0, BLOCK);
    }
    let mut times = Vec::with_capacity(quanta);
    for _ in 0..quanta {
        let start = Instant::now();
        convolver.process(&input, &input, &mut out_l, &mut out_r, 0, BLOCK);
        times.push(start.elapsed().as_secs_f64() * 1e6);
    }
    stats(&format!("canonical 128|128/1024/8192  ir {ir_frames}"), times);
}

// The textbook uniform FDL (B = 128, every partition MAC'd every quantum) for comparison.
const UNI_PARTS: usize = 3008;
const UNI_SPEC: usize = 2 * UNI_PARTS * 132;
type UniformLevel = Level<256, 132, 129, UNI_SPEC>;

struct LevelDriver<const FFT: usize, const BINS: usize, const TABLE: usize, const SPEC: usize> {
    level: Box<Level<FFT, BINS, TABLE, SPEC>>,
    window: Box<[[f32; 16384]; 2]>,
    sc_re: Box<[f32; 8192]>,
    sc_im: Box<[f32; 8192]>,
    tail: [[f32; BLOCK]; 2],
    quantum: usize
}

impl<const FFT: usize, const BINS: usize, const TABLE: usize, const SPEC: usize> LevelDriver<FFT, BINS, TABLE, SPEC> {
    fn new(b: usize, d0: usize, eager: bool, ir_frames: usize, rng: &mut Rng) -> Self {
        let mut level = boxed_zeroed::<Level<FFT, BINS, TABLE, SPEC>>();
        level.init(b, d0, eager);
        level.begin_ir(ir_frames);
        let ir: Vec<f32> = (0..ir_frames).map(|_| rng.next_f32()).collect();
        let read = |_channel: usize, index: usize| if index < ir.len() { ir[index] } else { 0.0 };
        let mut fft_in = vec![0.0f32; FFT];
        let mut sc_re = boxed_zeroed::<[f32; 8192]>();
        let mut sc_im = boxed_zeroed::<[f32; 8192]>();
        for part in 0..level.parts() {
            level.load_partition(part, &read, &mut fft_in, &mut sc_re[..], &mut sc_im[..]);
        }
        let mut window = boxed_zeroed::<[[f32; 16384]; 2]>();
        for channel in 0..2 {
            for index in 0..16384 {
                window[channel][index] = rng.next_f32();
            }
        }
        Self {level, window, sc_re, sc_im, tail: [[0.0; BLOCK]; 2], quantum: 0}
    }

    fn quantum(&mut self) {
        self.quantum += 1;
        for channel in 0..2 {
            self.tail[channel].fill(0.0);
        }
        let steps = self.level.partition_size() / BLOCK;
        let step = self.quantum % steps;
        self.level.consume(step, &mut self.tail);
        self.level.on_boundary(step, &self.window, &mut self.sc_re[..], &mut self.sc_im[..]);
    }
}

fn bench_uniform_128(ir_frames: usize) {
    let mut rng = Rng(2);
    let mut driver: LevelDriver<256, 132, 129, UNI_SPEC> = LevelDriver::new(128, 128, true, ir_frames, &mut rng);
    let quanta = 2000;
    for _ in 0..64 {
        driver.quantum();
    }
    let mut times = Vec::with_capacity(quanta);
    for _ in 0..quanta {
        let start = Instant::now();
        driver.quantum();
        times.push(start.elapsed().as_secs_f64() * 1e6);
    }
    stats(&format!("uniform B=128 (textbook FDL)  ir {ir_frames}"), times);
}

// Two-level variant: eager 128 covering 128..16384, then 8192 partitions.
const TWO_L1_SPEC: usize = 2 * 127 * 132;
const TWO_L3_SPEC: usize = 2 * 45 * 8196;

fn bench_two_level(ir_frames: usize) {
    let mut rng = Rng(3);
    let mut low: LevelDriver<256, 132, 129, TWO_L1_SPEC> = LevelDriver::new(128, 128, true, ir_frames.min(16384), &mut rng);
    let mut high: LevelDriver<16384, 8196, 8193, TWO_L3_SPEC> = LevelDriver::new(8192, 16384, false, ir_frames, &mut rng);
    let quanta = 6400;
    for _ in 0..128 {
        low.quantum();
        high.quantum();
    }
    let mut times = Vec::with_capacity(quanta);
    for _ in 0..quanta {
        let start = Instant::now();
        low.quantum();
        high.quantum();
        times.push(start.elapsed().as_secs_f64() * 1e6);
    }
    stats(&format!("two-level 128 + 8192          ir {ir_frames}"), times);
}

// Mid+high variant used by the canonical layout, isolated (no eager L1) for attribution.
const MID_SPEC: usize = 2 * 14 * 1028;

fn bench_mid_level(ir_frames: usize) {
    let mut rng = Rng(4);
    let mut mid: LevelDriver<2048, 1028, 1025, MID_SPEC> = LevelDriver::new(1024, 2048, false, ir_frames, &mut rng);
    let quanta = 2000;
    for _ in 0..64 {
        mid.quantum();
    }
    let mut times = Vec::with_capacity(quanta);
    for _ in 0..quanta {
        let start = Instant::now();
        mid.quantum();
        times.push(start.elapsed().as_secs_f64() * 1e6);
    }
    stats(&format!("isolated mid level b=1024     ir {ir_frames}"), times);
}

#[test]
#[ignore]
fn bench_layouts() {
    println!("budget per quantum @48kHz: {BUDGET_US_48K:.0} us");
    for ir in [4800usize, 24000, 48000, 96000, 192000, 384000] {
        bench_canonical(ir);
    }
    println!();
    for ir in [24000usize, 96000, 384000] {
        bench_uniform_128(ir);
    }
    println!();
    for ir in [24000usize, 96000, 384000] {
        bench_two_level(ir);
    }
    println!();
    bench_mid_level(16384);
}

#[test]
#[ignore]
fn bench_spectral_mac_kernel() {
    // padded-to-4 vs odd-length lanes: measures whether the pad-to-SIMD layout pays
    let mut rng = Rng(5);
    for bins in [129usize, 132, 1025, 1028, 8193, 8196] {
        let x_re: Vec<f32> = (0..bins).map(|_| rng.next_f32()).collect();
        let x_im: Vec<f32> = (0..bins).map(|_| rng.next_f32()).collect();
        let h_re: Vec<f32> = (0..bins).map(|_| rng.next_f32()).collect();
        let h_im: Vec<f32> = (0..bins).map(|_| rng.next_f32()).collect();
        let mut acc_re = vec![0.0f32; bins];
        let mut acc_im = vec![0.0f32; bins];
        let iterations = 200000;
        let start = Instant::now();
        for _ in 0..iterations {
            spectral_mac(&mut acc_re, &mut acc_im, &x_re, &x_im, &h_re, &h_im);
        }
        let elapsed = start.elapsed().as_secs_f64();
        let cmuls = bins as f64 * iterations as f64;
        println!("spectral_mac bins {bins:>5}: {:6.2} ns/call, {:6.2} Gcmul/s (acc {:.3})",
                 elapsed / iterations as f64 * 1e9, cmuls / elapsed / 1e9, acc_re[0]);
    }
}

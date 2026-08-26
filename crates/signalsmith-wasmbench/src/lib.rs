#![no_std]
extern crate alloc;
use alloc::{vec, vec::Vec, boxed::Box};
use core::alloc::{GlobalAlloc, Layout};
use signalsmith::SignalsmithStretch;

const ARENA: usize = 48 * 1024 * 1024;
static mut MEM: [u8; ARENA] = [0; ARENA];
static mut OFF: usize = 0;
struct Bump;
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let a = l.align(); let o = (OFF + a - 1) & !(a - 1); OFF = o + l.size();
        if OFF > ARENA { return core::ptr::null_mut(); }
        core::ptr::addr_of_mut!(MEM).cast::<u8>().add(o)
    }
    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}
#[global_allocator] static A: Bump = Bump;
#[panic_handler] fn ph(_: &core::panic::PanicInfo) -> ! { loop {} }

struct Bench { port: SignalsmithStretch, left: Vec<f32>, right: Vec<f32>, ol: Vec<f32>, or: Vec<f32>, resample: f64, acc: f32 }
static mut B: Option<Box<Bench>> = None;

#[no_mangle]
pub extern "C" fn setup(blocks: u32, resample_x1000: u32) {
    unsafe { OFF = 0; }
    let n = blocks as usize * 128 + 16384;
    let mut left = vec![0.0f32; n]; let mut right = vec![0.0f32; n];
    let mut s = 0x1234_5678u32;
    for i in 0..n {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5; left[i] = (s as f32 / 2_147_483_648.0 - 1.0) * 0.2;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5; right[i] = (s as f32 / 2_147_483_648.0 - 1.0) * 0.2;
    }
    let mut port = SignalsmithStretch::preset_default(2, 48000.0);
    port.reset_stream(2048.0);
    unsafe { B = Some(Box::new(Bench { port, left, right, ol: vec![0.0;128], or: vec![0.0;128], resample: resample_x1000 as f64/1000.0, acc: 0.0 })); }
}

#[no_mangle]
pub extern "C" fn reset() { unsafe { B.as_mut().unwrap().port.reset_stream(2048.0); } }

/// Process ONE 128-sample block. Host times each call to find the per-block peak.
#[no_mangle]
pub extern "C" fn step() -> f32 {
    unsafe {
        let b = B.as_mut().unwrap();
        b.port.process_stream_stereo(&b.left, &b.right, &mut b.ol, &mut b.or, 1.0, 1.0, b.resample);
        b.acc += b.ol[0]; b.acc
    }
}

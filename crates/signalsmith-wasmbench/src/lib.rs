#![no_std]
extern crate alloc;
use alloc::vec;
use core::alloc::{GlobalAlloc, Layout};
use signalsmith::SignalsmithStretch;

const ARENA: usize = 48 * 1024 * 1024;
static mut MEM: [u8; ARENA] = [0; ARENA];
static mut OFF: usize = 0;
struct Bump;
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let a = l.align();
        let o = (OFF + a - 1) & !(a - 1);
        OFF = o + l.size();
        if OFF > ARENA { return core::ptr::null_mut(); }
        core::ptr::addr_of_mut!(MEM).cast::<u8>().add(o)
    }
    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}
#[global_allocator]
static A: Bump = Bump;
#[panic_handler]
fn ph(_: &core::panic::PanicInfo) -> ! { loop {} }

#[no_mangle]
pub extern "C" fn reset_arena() { unsafe { OFF = 0; } }

/// Render `blocks` * 128 samples of broadband stereo noise through the streaming processor. Returns a
/// checksum (prevents dead-code elimination). Host times the call. resample!=1 to exercise the drum case.
#[no_mangle]
pub extern "C" fn bench(blocks: u32, resample_x1000: u32) -> f32 {
    let n = (blocks as usize) * 128 + 16384;
    let mut left = vec![0.0f32; n];
    let mut right = vec![0.0f32; n];
    let mut s = 0x1234_5678u32;
    for i in 0..n {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        left[i] = (s as f32 / 2_147_483_648.0 - 1.0) * 0.2;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        right[i] = (s as f32 / 2_147_483_648.0 - 1.0) * 0.2;
    }
    let resample = resample_x1000 as f64 / 1000.0;
    let mut port = SignalsmithStretch::preset_default(2, 48000.0);
    port.reset_stream(2048.0);
    let mut ol = vec![0.0f32; 128];
    let mut or = vec![0.0f32; 128];
    let mut acc = 0.0f32;
    for _ in 0..blocks {
        port.process_stream_stereo(&left, &right, &mut ol, &mut or, 1.0, 1.0, resample);
        acc += ol[0] + or[0];
    }
    acc
}

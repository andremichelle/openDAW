//! Feature entry point: sine generator (step 1). Thin cdylib over `dsp`.

#![no_std]

use core::panic::PanicInfo;
use dsp::{fast_sin, PI};

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

const MAX_BLOCK: usize = 128;

static mut PHASE: f32 = 0.0;
static mut INC: f32 = 0.0;
static mut OUT: [f32; MAX_BLOCK] = [0.0; MAX_BLOCK];

#[no_mangle]
pub extern "C" fn init(sample_rate: f32, freq: f32) {
    unsafe {
        *(&raw mut INC) = freq / sample_rate;
        *(&raw mut PHASE) = 0.0;
    }
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    (&raw const OUT).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn process(frames: usize) {
    let n = if frames > MAX_BLOCK { MAX_BLOCK } else { frames };
    let out = (&raw mut OUT).cast::<f32>();
    unsafe {
        let inc = *(&raw const INC);
        let mut p = *(&raw const PHASE);
        let mut i = 0;
        while i < n {
            *out.add(i) = 0.2 * fast_sin((p * 2.0 - 1.0) * PI);
            p += inc;
            if p >= 1.0 {
                p -= 1.0;
            }
            i += 1;
        }
        *(&raw mut PHASE) = p;
    }
}

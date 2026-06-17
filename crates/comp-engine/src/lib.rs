//! Comprehensive rack engine. Signal flow per block:
//!   saw -> S, sine -> M
//!   filter#1 (lowpass, cutoff1) in place on S        — instance 1 of comp-filter
//!   filter#2 (lowpass, cutoff2) in place on M        — instance 2 of comp-filter (own state)
//!   ring:  R = S * M * gain                          — comp-ring (2 inputs -> 1 output)
//!   delay: R += feedback * delayed(R)                — comp-delay (heap-allocated line)
//! Output is R. Exercises shared memory, multiple distinct modules, multiple instances of one
//! module, per-instance external state, the multi-input descriptor ABI, and a heap device — all at
//! once. The engine assembles the canonical descriptors (see the `abi` crate for the layout).

#![cfg_attr(not(test), no_std)]

#[cfg(not(test))]
use core::panic::PanicInfo;
use dsp::{fast_sin, PI};

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[link(wasm_import_module = "filter")]
extern "C" {
    #[link_name = "process"]
    fn filter_process(desc_ptr: u32);
}

#[link(wasm_import_module = "ring")]
extern "C" {
    #[link_name = "process"]
    fn ring_process(desc_ptr: u32);
}

#[link(wasm_import_module = "delay")]
extern "C" {
    #[link_name = "process"]
    fn delay_process(desc_ptr: u32);
}

const N: usize = 128;

static mut S: [f32; N] = [0.0; N];
static mut M: [f32; N] = [0.0; N];
static mut R: [f32; N] = [0.0; N];

static mut PHASE_S: f32 = 0.0;
static mut INC_S: f32 = 0.0;
static mut PHASE_M: f32 = 0.0;
static mut INC_M: f32 = 0.0;

static mut FS1: [f32; 1] = [0.0]; // filter instance 1 state (y1)
static mut FS2: [f32; 1] = [0.0]; // filter instance 2 state (y1)
static mut DS: [u32; 4] = [0; 4]; // delay state (initialized, pos, line_ptr, line_len)
static mut RING_SCRATCH: [u32; 1] = [0; 1]; // valid state ptr for the stateless ring device

static mut O_S: [u32; 1] = [0; 1];
static mut O_M: [u32; 1] = [0; 1];
static mut O_R: [u32; 1] = [0; 1];
static mut IN_RING: [u32; 2] = [0; 2];

static mut P_F1: [f32; 1] = [0.0];
static mut P_F2: [f32; 1] = [0.0];
static mut P_RING: [f32; 1] = [0.0];
static mut P_DELAY: [f32; 1] = [0.0];

static mut D_F1: [u32; 8] = [0; 8];
static mut D_F2: [u32; 8] = [0; 8];
static mut D_RING: [u32; 8] = [0; 8];
static mut D_DELAY: [u32; 8] = [0; 8];

unsafe fn addr<T>(ptr: *const T) -> u32 {
    ptr as usize as u32
}

#[allow(clippy::too_many_arguments)]
unsafe fn write_desc(desc: *mut u32, in_offs: u32, in_count: u32, out_offs: u32, out_count: u32,
                     params: u32, param_count: u32, state: u32) {
    *desc.add(1) = in_count;
    *desc.add(2) = in_offs;
    *desc.add(3) = out_count;
    *desc.add(4) = out_offs;
    *desc.add(5) = param_count;
    *desc.add(6) = params;
    *desc.add(7) = state;
}

#[no_mangle]
pub extern "C" fn init(sample_rate: f32, saw_hz: f32, mod_hz: f32,
                       cutoff1: f32, cutoff2: f32, ring_gain: f32, feedback: f32) {
    unsafe {
        INC_S = saw_hz / sample_rate;
        INC_M = mod_hz / sample_rate;
        PHASE_S = 0.0;
        PHASE_M = 0.0;
        *(&raw mut O_S).cast::<u32>().add(0) = addr((&raw const S).cast::<f32>());
        *(&raw mut O_M).cast::<u32>().add(0) = addr((&raw const M).cast::<f32>());
        *(&raw mut O_R).cast::<u32>().add(0) = addr((&raw const R).cast::<f32>());
        let in_ring = (&raw mut IN_RING).cast::<u32>();
        *in_ring.add(0) = addr((&raw const S).cast::<f32>());
        *in_ring.add(1) = addr((&raw const M).cast::<f32>());
        *(&raw mut P_F1).cast::<f32>().add(0) = cutoff1;
        *(&raw mut P_F2).cast::<f32>().add(0) = cutoff2;
        *(&raw mut P_RING).cast::<f32>().add(0) = ring_gain;
        *(&raw mut P_DELAY).cast::<f32>().add(0) = feedback;
        write_desc((&raw mut D_F1).cast(), 0, 0,
                   addr((&raw const O_S).cast::<u32>()), 1,
                   addr((&raw const P_F1).cast::<f32>()), 1, addr((&raw const FS1).cast::<f32>()));
        write_desc((&raw mut D_F2).cast(), 0, 0,
                   addr((&raw const O_M).cast::<u32>()), 1,
                   addr((&raw const P_F2).cast::<f32>()), 1, addr((&raw const FS2).cast::<f32>()));
        write_desc((&raw mut D_RING).cast(),
                   addr((&raw const IN_RING).cast::<u32>()), 2,
                   addr((&raw const O_R).cast::<u32>()), 1,
                   addr((&raw const P_RING).cast::<f32>()), 1, addr((&raw const RING_SCRATCH).cast::<u32>()));
        write_desc((&raw mut D_DELAY).cast(), 0, 0,
                   addr((&raw const O_R).cast::<u32>()), 1,
                   addr((&raw const P_DELAY).cast::<f32>()), 1, addr((&raw const DS).cast::<u32>()));
    }
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    (&raw const R).cast::<f32>()
}

#[no_mangle]
pub extern "C" fn render(frames: usize) {
    let n = if frames > N { N } else { frames };
    unsafe {
        *(&raw mut D_F1).cast::<u32>().add(0) = n as u32;
        *(&raw mut D_F2).cast::<u32>().add(0) = n as u32;
        *(&raw mut D_RING).cast::<u32>().add(0) = n as u32;
        *(&raw mut D_DELAY).cast::<u32>().add(0) = n as u32;
        let s = (&raw mut S).cast::<f32>();
        let m = (&raw mut M).cast::<f32>();
        let mut ps = PHASE_S;
        let is = INC_S;
        let mut pm = PHASE_M;
        let im = INC_M;
        let mut i = 0;
        while i < n {
            *s.add(i) = 0.5 * (ps * 2.0 - 1.0);
            *m.add(i) = fast_sin((pm * 2.0 - 1.0) * PI);
            ps += is;
            if ps >= 1.0 {
                ps -= 1.0;
            }
            pm += im;
            if pm >= 1.0 {
                pm -= 1.0;
            }
            i += 1;
        }
        PHASE_S = ps;
        PHASE_M = pm;
        filter_process(addr((&raw const D_F1).cast::<u32>()));
        filter_process(addr((&raw const D_F2).cast::<u32>()));
        ring_process(addr((&raw const D_RING).cast::<u32>()));
        delay_process(addr((&raw const D_DELAY).cast::<u32>()));
    }
}

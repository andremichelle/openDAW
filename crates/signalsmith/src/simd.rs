//! A 4-lane f32 SIMD abstraction: a wasm `v128` implementation and a scalar `[f32;4]` fallback behind one API,
//! so the hot per-band loops are written ONCE. Because wasm `f32x4` arithmetic is the same IEEE-754 single as
//! scalar `f32` (no FMA on these paths), the fallback compiled natively is a bit-exact oracle for the wasm
//! intrinsics — the crate's native tests validate the SIMD algorithm directly.

#[cfg(target_arch = "wasm32")]
mod imp {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct Simd4(pub(super) v128);
    #[derive(Clone, Copy)]
    pub struct Mask(pub(super) v128);

    impl Simd4 {
        #[inline] pub fn splat(x: f32) -> Self { Simd4(f32x4_splat(x)) }
        #[inline] pub fn load(slice: &[f32]) -> Self { Simd4(f32x4(slice[0], slice[1], slice[2], slice[3])) }
        #[inline] pub fn store(self, slice: &mut [f32]) {
            slice[0] = f32x4_extract_lane::<0>(self.0); slice[1] = f32x4_extract_lane::<1>(self.0);
            slice[2] = f32x4_extract_lane::<2>(self.0); slice[3] = f32x4_extract_lane::<3>(self.0);
        }
        #[inline] pub fn to_array(self) -> [f32; 4] {
            [f32x4_extract_lane::<0>(self.0), f32x4_extract_lane::<1>(self.0),
             f32x4_extract_lane::<2>(self.0), f32x4_extract_lane::<3>(self.0)]
        }
        #[inline] pub fn add(self, o: Self) -> Self { Simd4(f32x4_add(self.0, o.0)) }
        #[inline] pub fn sub(self, o: Self) -> Self { Simd4(f32x4_sub(self.0, o.0)) }
        #[inline] pub fn mul(self, o: Self) -> Self { Simd4(f32x4_mul(self.0, o.0)) }
        #[inline] pub fn div(self, o: Self) -> Self { Simd4(f32x4_div(self.0, o.0)) }
        #[inline] pub fn abs(self) -> Self { Simd4(f32x4_abs(self.0)) }
        // pmin/pmax: `o < self ? o : self` / `self < o ? o : self` — the scalar fallback mirrors this exactly.
        #[inline] pub fn min(self, o: Self) -> Self { Simd4(f32x4_pmin(self.0, o.0)) }
        #[inline] pub fn max(self, o: Self) -> Self { Simd4(f32x4_pmax(self.0, o.0)) }
        #[inline] pub fn gt(self, o: Self) -> Mask { Mask(f32x4_gt(self.0, o.0)) }
        #[inline] pub fn ge(self, o: Self) -> Mask { Mask(f32x4_ge(self.0, o.0)) }
        #[inline] pub fn lt(self, o: Self) -> Mask { Mask(f32x4_lt(self.0, o.0)) }
        #[inline] pub fn select(mask: Mask, if_true: Self, if_false: Self) -> Self {
            Simd4(v128_bitselect(if_true.0, if_false.0, mask.0))
        }
        /// Fast inverse-sqrt seed: reinterpret the bits and compute `0x5f375a86 - (bits >> 1)` (per lane), the
        /// same magic used by the scalar `approx::sqrt`. The v128 is untyped so the reinterpret is free.
        #[inline] pub fn rsqrt_seed(self) -> Self {
            Simd4(i32x4_sub(i32x4_splat(0x5f37_5a86), u32x4_shr(self.0, 1)))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    #[derive(Clone, Copy)]
    pub struct Simd4(pub(super) [f32; 4]);
    #[derive(Clone, Copy)]
    pub struct Mask(pub(super) [bool; 4]);

    #[inline] fn map2(a: [f32; 4], b: [f32; 4], f: impl Fn(f32, f32) -> f32) -> [f32; 4] {
        [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
    }

    impl Simd4 {
        #[inline] pub fn splat(x: f32) -> Self { Simd4([x; 4]) }
        #[inline] pub fn load(slice: &[f32]) -> Self { Simd4([slice[0], slice[1], slice[2], slice[3]]) }
        #[inline] pub fn store(self, slice: &mut [f32]) { slice[..4].copy_from_slice(&self.0); }
        #[inline] pub fn to_array(self) -> [f32; 4] { self.0 }
        #[inline] pub fn add(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x + y)) }
        #[inline] pub fn sub(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x - y)) }
        #[inline] pub fn mul(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x * y)) }
        #[inline] pub fn div(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x / y)) }
        #[inline] pub fn abs(self) -> Self { Simd4([self.0[0].abs(), self.0[1].abs(), self.0[2].abs(), self.0[3].abs()]) }
        // pmin/pmax semantics (wasm): `if b < a { b } else { a }` — pick the second arg on ties/NaN.
        #[inline] pub fn min(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |a, b| if b < a { b } else { a })) }
        #[inline] pub fn max(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |a, b| if b > a { b } else { a })) }
        #[inline] pub fn gt(self, o: Self) -> Mask { Mask([self.0[0] > o.0[0], self.0[1] > o.0[1], self.0[2] > o.0[2], self.0[3] > o.0[3]]) }
        #[inline] pub fn ge(self, o: Self) -> Mask { Mask([self.0[0] >= o.0[0], self.0[1] >= o.0[1], self.0[2] >= o.0[2], self.0[3] >= o.0[3]]) }
        #[inline] pub fn lt(self, o: Self) -> Mask { Mask([self.0[0] < o.0[0], self.0[1] < o.0[1], self.0[2] < o.0[2], self.0[3] < o.0[3]]) }
        #[inline] pub fn select(mask: Mask, if_true: Self, if_false: Self) -> Self {
            let mut out = [0.0f32; 4];
            for lane in 0..4 { out[lane] = if mask.0[lane] { if_true.0[lane] } else { if_false.0[lane] }; }
            Simd4(out)
        }
        #[inline] pub fn rsqrt_seed(self) -> Self {
            let mut out = [0.0f32; 4];
            for lane in 0..4 { out[lane] = f32::from_bits(0x5f37_5a86u32.wrapping_sub(self.0[lane].to_bits() >> 1)); }
            Simd4(out)
        }
    }
}

pub use imp::Simd4;

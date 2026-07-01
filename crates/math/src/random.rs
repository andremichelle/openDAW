//! `Mulberry32`, a faithful port of lib-std `Mulberry32`: a tiny seeded PRNG. `set_seed` then `uniform` yields
//! a `[0, 1)` value. All arithmetic is `u32` wrapping (mirroring JS `Math.imul` + `>>>` on 32-bit lanes), so a
//! given seed produces the same stream as the TS engine. Callers that reseed before each draw (the Velocity
//! device) get identical output.

/// The Mulberry32 generator. `Default` seeds with 0 (a device sets the real seed before drawing).
#[derive(Clone, Copy, Default)]
pub struct Mulberry32 {
    seed: u32
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self {seed}
    }

    /// Set the seed (`value & 0xFFFFFFFF` in TS is exactly the `u32` bit pattern).
    pub fn set_seed(&mut self, value: u32) {
        self.seed = value;
    }

    /// The next `[0, 1)` value. Mirrors `Mulberry32.uniform`: `imul` is `wrapping_mul`, `>>>` is `u32 >>`, and
    /// the final divide by 2^32 is done in `f64` then narrowed (the f64 -> f32 policy).
    pub fn uniform(&mut self) -> f32 {
        self.seed = self.seed.wrapping_add(0x6D2B_79F5);
        let mut t = self.seed;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64 / 4_294_967_296.0) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::Mulberry32;

    #[test]
    fn uniform_is_in_the_unit_interval() {
        let mut random = Mulberry32::new(0x800);
        for _ in 0..10_000 {
            let value = random.uniform();
            assert!((0.0..1.0).contains(&value), "value {value} out of [0, 1)");
        }
    }

    #[test]
    fn a_seed_is_deterministic() {
        let mut a = Mulberry32::new(12_345);
        let mut b = Mulberry32::new(12_345);
        for _ in 0..100 {
            assert_eq!(a.uniform(), b.uniform(), "same seed -> same stream");
        }
    }

    #[test]
    fn reseeding_resets_the_stream() {
        let mut random = Mulberry32::new(0);
        random.set_seed(42);
        let first = random.uniform();
        random.set_seed(42);
        assert_eq!(random.uniform(), first, "reseed reproduces the same first draw");
    }

    #[test]
    fn matches_the_reference_stream_for_a_known_seed() {
        // The TS Mulberry32(1) first three uniforms, computed by the reference implementation. Locks byte-parity.
        let mut random = Mulberry32::new(1);
        let expected = [0.6270739405881613f64, 0.002735721180215478, 0.5274470399599522];
        for want in expected {
            let got = random.uniform();
            assert!((got as f64 - want).abs() < 1e-6, "got {got}, want {want}");
        }
    }
}

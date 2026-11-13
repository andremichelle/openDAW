// WASM CONTRACT: the loops users keep depend on these exact rolls. Never change the constants or the mixing order.

fn mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7FEB_352D);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846C_A68B);
    value ^ (value >> 16)
}

/// A stable 0 to 1 value for a seed and three indices.
pub fn unit(seed: u32, first: u32, second: u32, third: u32) -> f32 {
    let hashed = mix(mix(mix(mix(seed) ^ first).wrapping_add(second)) ^ third.wrapping_mul(0x9E37_79B9));
    (hashed >> 8) as f32 / (1u32 << 24) as f32
}

/// How often a step has been replaced after `pass` passes: every pass rolls once per step against `mutate`.
pub fn generation(seed: u32, step: u32, pass: u32, mutate: f32) -> u32 {
    if mutate <= 0.0 {return 0;}
    (1..=pass).filter(|index| unit(seed, step, *index, 0) < mutate).count() as u32
}

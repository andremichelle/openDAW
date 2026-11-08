//! Strokes and the step grid: which strings a stroke plays in which order, where the steps of a rate fall in
//! the bar, and the deterministic per-pluck variation.

use crate::fretting::{Tab, STRINGS};

// WASM CONTRACT: stroke kinds mirror `GuitarPatterns.Kinds` in studio-adapters (step-kinds field 30).
pub const REST: i32 = 0;
pub const DOWN: i32 = 1;
pub const UP: i32 = 2;
pub const MUTE: i32 = 3;
pub const CHUCK: i32 = 4;
pub const BASS: i32 = 5;
pub const ALTERNATE: i32 = 6;
pub const PICK: i32 = 7;
pub const STOP: i32 = 8;

pub const STEP_COUNT: usize = 64;
const SIXTEENTH: f64 = 240.0;

/// The step length in pulses for the rate (0 half, 1 normal, 2 double speed).
pub fn step_length(rate: i32) -> f64 {
    match rate {
        0 => SIXTEENTH * 2.0,
        2 => SIXTEENTH * 0.5,
        _ => SIXTEENTH
    }
}

/// The strings a stroke plays, in playing order, and how many. `mask` bit n is string n (0 = low E).
pub fn order(kind: i32, mask: i32, tab: &Tab) -> ([usize; STRINGS], usize) {
    let mut strings = [0usize; STRINGS];
    let mut count = 0;
    let sounding = |string: usize| tab[string] >= 0;
    match kind {
        DOWN | MUTE | UP => {
            for string in 0..STRINGS {
                if mask & (1 << string) != 0 && sounding(string) {
                    strings[count] = string;
                    count += 1;
                }
            }
            if kind == UP {
                strings[..count].reverse();
            }
        }
        CHUCK => {
            for string in 0..STRINGS {
                if sounding(string) {
                    strings[count] = string;
                    count += 1;
                }
            }
        }
        BASS | ALTERNATE => {
            let skip = if kind == BASS {0} else {1};
            if let Some(string) = (0..STRINGS).filter(|string| sounding(*string)).nth(skip) {
                strings[0] = string;
                count = 1;
            }
        }
        PICK => {
            for wanted in 0..STRINGS {
                if mask & (1 << wanted) == 0 {
                    continue;
                }
                let nearest = (0..STRINGS).filter(|string| sounding(*string))
                    .min_by_key(|string| (*string as i32 - wanted as i32).abs());
                if let Some(string) = nearest {
                    if !strings[..count].contains(&string) {
                        strings[count] = string;
                        count += 1;
                    }
                }
            }
        }
        _ => {}
    }
    (strings, count)
}

pub fn hash(seed: u32, step: i64, salt: u32) -> u32 {
    let mut value = (seed as u64).wrapping_mul(0xD6E8_FEB8_6659_FD93)
        ^ (step as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (salt as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    value ^= value >> 30;
    value = value.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^= value >> 31;
    (value >> 32) as u32
}

/// A deterministic value in [-1, 1) for one pluck, so a bounce repeats the playback.
pub fn bipolar(seed: u32, step: i64, salt: u32) -> f32 {
    (hash(seed, step, salt) >> 8) as f32 / 8_388_608.0 - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN_C: Tab = [-1, 3, 2, 0, 1, 0];

    #[test]
    fn down_crosses_the_lane_strings_from_low_to_high() {
        let (strings, count) = order(DOWN, 0b111111, &OPEN_C);
        assert_eq!(&strings[..count], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn up_crosses_them_from_high_to_low() {
        let (strings, count) = order(UP, 0b111100, &OPEN_C);
        assert_eq!(&strings[..count], &[5, 4, 3, 2]);
    }

    #[test]
    fn bass_and_alternate_bass_are_the_two_lowest_sounding_strings() {
        assert_eq!(order(BASS, 0, &OPEN_C), ([1, 0, 0, 0, 0, 0], 1));
        assert_eq!(order(ALTERNATE, 0, &OPEN_C), ([2, 0, 0, 0, 0, 0], 1));
    }

    #[test]
    fn pick_moves_a_muted_string_to_the_nearest_sounding_one() {
        let (strings, count) = order(PICK, 0b100001, &OPEN_C);
        assert_eq!(&strings[..count], &[1, 5]);
    }

    #[test]
    fn rest_and_stop_play_no_string() {
        assert_eq!(order(REST, 0b111111, &OPEN_C).1, 0);
        assert_eq!(order(STOP, 0b111111, &OPEN_C).1, 0);
    }

    #[test]
    fn the_rates() {
        assert_eq!(step_length(0), 480.0);
        assert_eq!(step_length(1), 240.0);
        assert_eq!(step_length(2), 120.0);
    }
}

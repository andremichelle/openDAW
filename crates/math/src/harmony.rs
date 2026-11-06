//! Keys and chords, the port of lib-dsp `Harmony`: a key is a root pitch class plus a 12-bit scale mask
//! (bit i = i semitones above the root), a chord a root pitch class plus its voicing as a mask of semitones
//! above that root (bits 0..31, so stacked 9ths and inversions keep their octave).

pub const MAJOR_BITS: i32 = 0b1010_1011_0101;

// WASM CONTRACT: the masks of lib-dsp `MidiKeys.StockScales`, same order (a device's `scale` parameter indexes it).
pub const STOCK_SCALES: [i32; 15] = [
    0xAB5, 0x5AD, 0x9AD, 0xAAD, 0x6AD, 0x5AB, 0xAD5, 0x6B5, 0x56B, 0x295, 0x4A9, 0x4E9, 0x555, 0xB6D, 0x999
];

pub fn count_notes(bits: i32) -> u32 {
    ((bits & 0xFFF) as u32).count_ones()
}

pub fn is_heptatonic(bits: i32) -> bool {
    count_notes(bits) == 7
}

pub fn has(pitch: i32, root: i32, bits: i32) -> bool {
    bits & (1 << (pitch - root).rem_euclid(12)) != 0
}

/// The nearest key of the scale inside 0..=127, ties resolve downwards.
pub fn quantise(pitch: i32, root: i32, bits: i32) -> i32 {
    if bits & 0xFFF == 0 {
        return pitch;
    }
    for distance in 0..12 {
        let down = pitch - distance;
        if down >= 0 && has(down, root, bits) {
            return down;
        }
        let up = pitch + distance;
        if up <= 127 && has(up, root, bits) {
            return up;
        }
    }
    pitch
}

/// The chord on `degree` (1..=7) of a 7-note key: `(root pitch class, voicing mask)`. `shape` 0 stacks
/// `notes` (3..=5) scale notes in thirds, any other value replaces them. `inversion` moves that many of the
/// lowest notes up an octave.
pub fn chord(root: i32, bits: i32, degree: i32, shift: i32, shape: i32, notes: i32, inversion: i32) -> Option<(i32, i32)> {
    if !is_heptatonic(bits) || !(1..=7).contains(&degree) {
        return None;
    }
    let mut steps = [0i32; 7];
    let mut count = 0;
    for index in 0..12 {
        if bits & (1 << index) != 0 {
            steps[count] = index;
            count += 1;
        }
    }
    let index = (degree - 1) as usize;
    let base = steps[index];
    let mut stack = [0i32; 12];
    let mut size = 0;
    if shape != 0 {
        for interval in 0..12 {
            if shape & (1 << interval) != 0 {
                stack[size] = interval;
                size += 1;
            }
        }
    } else {
        for note in 0..notes.clamp(3, 5) as usize {
            let step = index + note * 2;
            stack[size] = steps[step % 7] + (step / 7) as i32 * 12 - base;
            size += 1;
        }
    }
    let rotate = inversion.clamp(0, size as i32 - 1) as usize;
    let mut voicing = 0;
    for (position, interval) in stack[..size].iter().enumerate() {
        voicing |= 1 << (interval + if position < rotate {12} else {0});
    }
    Some(((root + base + shift).rem_euclid(12), voicing))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NATURAL_MINOR: i32 = 0b0101_1010_1101;
    const PENTATONIC_MAJOR: i32 = 0b0010_1001_0101;

    fn reference(pitch: i32, root: i32, bits: i32) -> i32 {
        let mut best = pitch;
        let mut best_distance = i32::MAX;
        for candidate in 0..=127 {
            if !has(candidate, root, bits) {
                continue;
            }
            let distance = (candidate - pitch).abs();
            if distance < best_distance {
                best = candidate;
                best_distance = distance;
            }
        }
        best
    }

    #[test]
    fn quantise_matches_the_reference_for_every_mask_and_root() {
        for bits in 1..4096 {
            for root in 0..12 {
                for pitch in 0..=127 {
                    assert_eq!(quantise(pitch, root, bits), reference(pitch, root, bits), "bits {bits} root {root} pitch {pitch}");
                }
            }
        }
    }

    #[test]
    fn ties_go_down_and_octaves_are_crossed() {
        assert_eq!(quantise(61, 0, MAJOR_BITS), 60);
        assert_eq!(quantise(70, 0, MAJOR_BITS), 69);
        assert_eq!(quantise(71, 0, PENTATONIC_MAJOR), 72);
        assert_eq!(quantise(0, 1, 1), 1);
        assert_eq!(quantise(127, 1, 1), 121);
        assert_eq!(quantise(61, 0, 0), 61);
    }

    #[test]
    fn triads_follow_key_and_scale() {
        let major: [(i32, i32); 7] = [(0, 0x91), (2, 0x89), (4, 0x89), (5, 0x91), (7, 0x91), (9, 0x89), (11, 0x49)];
        for (degree, expected) in major.iter().enumerate() {
            assert_eq!(chord(0, MAJOR_BITS, degree as i32 + 1, 0, 0, 3, 0), Some(*expected));
        }
        assert_eq!(chord(5, MAJOR_BITS, 5, 0, 0, 3, 0), Some((0, 0x91)));
        assert_eq!(chord(0, NATURAL_MINOR, 1, 0, 0, 3, 0), Some((0, 0x89)));
        assert_eq!(chord(0, MAJOR_BITS, 7, -1, 0x91, 3, 0), Some((10, 0x91)));
        assert_eq!(chord(5, MAJOR_BITS, 7, -1, 0x91, 3, 0), Some((3, 0x91)));
    }

    fn intervals(mask: i32) -> Vec<i32> {
        (0..32).filter(|interval| mask & (1 << interval) != 0).collect()
    }

    #[test]
    fn stacks_sevenths_and_ninths_and_inverts() {
        assert_eq!(chord(0, MAJOR_BITS, 1, 0, 0, 4, 0).map(|(root, mask)| (root, intervals(mask))), Some((0, vec![0, 4, 7, 11])));
        assert_eq!(chord(0, MAJOR_BITS, 5, 0, 0, 5, 0).map(|(root, mask)| (root, intervals(mask))), Some((7, vec![0, 4, 7, 10, 14])));
        assert_eq!(chord(0, MAJOR_BITS, 1, 0, 0, 3, 1).map(|(_, mask)| intervals(mask)), Some(vec![4, 7, 12]));
        assert_eq!(chord(0, MAJOR_BITS, 5, 0, 0, 4, 3).map(|(_, mask)| intervals(mask)), Some(vec![10, 12, 16, 19]));
        assert_eq!(chord(0, MAJOR_BITS, 1, 0, 0, 3, 9).map(|(_, mask)| intervals(mask)), Some(vec![7, 12, 16]), "capped by the note count");
        assert_eq!(chord(0, MAJOR_BITS, 1, 0, 0, 9, 0).map(|(_, mask)| intervals(mask)), Some(vec![0, 4, 7, 11, 14]), "notes capped at 5");
    }

    #[test]
    fn no_chord_without_seven_notes_or_valid_degree() {
        assert_eq!(chord(0, PENTATONIC_MAJOR, 1, 0, 0, 3, 0), None);
        assert_eq!(chord(0, MAJOR_BITS, 0, 0, 0, 3, 0), None);
        assert_eq!(chord(0, MAJOR_BITS, 8, 0, 0, 3, 0), None);
    }
}

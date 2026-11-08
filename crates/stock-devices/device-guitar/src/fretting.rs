//! Chord to tab: one fret per string (or muted) for a chord root and voicing mask. Every chord tone sounds,
//! the lowest sounding string plays the chord's bass, muted strings sit only below it, the shape spans at most
//! four frets with at most four fingers (the lowest fret may be barred), and it stays near the Position. The
//! TS twin is `Guitar.tab` in lib-dsp; the shared table in both tests keeps them equal.

pub const STRINGS: usize = 6;
pub const MUTED: i8 = -1;

// WASM CONTRACT: the tuning and position tables mirror `Guitar.Tunings` / `Guitar.PositionFrets` in lib-dsp.
pub const TUNINGS: [[i32; STRINGS]; 4] = [
    [40, 45, 50, 55, 59, 64],
    [38, 45, 50, 55, 59, 64],
    [38, 43, 50, 55, 59, 62],
    [38, 45, 50, 55, 57, 62]
];
pub const POSITION_FRETS: [i32; 6] = [0, 3, 5, 7, 9, 12];

const MAX_OPTIONS: usize = 9;

pub type Tab = [i8; STRINGS];

struct Search {
    open: [i32; STRINGS],
    low: i32,
    options: [[i8; MAX_OPTIONS]; STRINGS],
    counts: [usize; STRINGS],
    bass: i32,
    required: i32,
    tones: i32,
    tab: Tab,
    best: Tab,
    best_score: i32,
    found: bool
}

impl Search {
    fn evaluate(&mut self) {
        let Some(first) = self.tab.iter().position(|fret| *fret >= 0) else {return};
        let last = self.tab.iter().rposition(|fret| *fret >= 0).unwrap_or(first);
        if self.tab[first..=last].iter().any(|fret| *fret < 0) {
            return;
        }
        let sounding = (last - first + 1) as i32;
        if sounding < 3.min(self.tones.count_ones() as i32) {
            return;
        }
        if (self.open[first] + self.tab[first] as i32).rem_euclid(12) != self.bass {
            return;
        }
        let mut classes = 0;
        let (mut lowest, mut highest, mut opens) = (i32::MAX, i32::MIN, 0);
        for string in first..=last {
            let fret = self.tab[string] as i32;
            classes |= 1 << (self.open[string] + fret).rem_euclid(12);
            if fret == 0 {
                opens += 1;
            } else {
                lowest = lowest.min(fret);
                highest = highest.max(fret);
            }
        }
        if classes & self.required != self.required {
            return;
        }
        let fretted = lowest != i32::MAX;
        let span = if fretted {highest - lowest} else {0};
        if span > 3 {
            return;
        }
        if fretted {
            let fingers = self.tab[first..=last].iter().filter(|fret| **fret as i32 > lowest).count() as i32 + 1;
            if fingers > 4 {
                return;
            }
            let barre_from = (first..=last).find(|string| self.tab[*string] as i32 == lowest).unwrap_or(first);
            let barre_to = (first..=last).rev().find(|string| self.tab[*string] as i32 == lowest).unwrap_or(first);
            let fingered = self.tab[first..=last].iter().filter(|fret| **fret as i32 == lowest).count();
            if fingered > 1 && self.tab[barre_from..=barre_to].iter().any(|fret| *fret == 0) {
                return;
            }
        }
        let anchor = if fretted {lowest} else {self.low};
        let open_score = if self.low == 0 {opens * 2} else {-opens * 3};
        let score = sounding * 3 + open_score - (anchor - self.low.max(1)).abs() * 2 - span;
        if !self.found || score > self.best_score {
            self.found = true;
            self.best_score = score;
            self.best = self.tab;
        }
    }

    fn walk(&mut self, string: usize) {
        if string == STRINGS {
            self.evaluate();
            return;
        }
        for option in 0..self.counts[string] {
            self.tab[string] = self.options[string][option];
            self.walk(string + 1);
        }
    }
}

/// The tab for the chord `root` (pitch class) with `voicing` (interval mask from the root, the lowest set bit
/// is the bass) on `tuning` near `position`. A chord missing at the position moves to the nearest one that has
/// it, a chord no shape holds drops its fifth, then everything but root and bass. All muted when nothing fits.
pub fn tab(root: i32, voicing: i32, tuning: usize, position: usize) -> Tab {
    let open = TUNINGS[tuning.min(TUNINGS.len() - 1)];
    let position = position.min(POSITION_FRETS.len() - 1);
    let mut tones = 0;
    for interval in 0..31 {
        if voicing & (1 << interval) != 0 {
            tones |= 1 << (root + interval).rem_euclid(12);
        }
    }
    if tones == 0 {
        return [MUTED; STRINGS];
    }
    let bass = (root + voicing.trailing_zeros() as i32).rem_euclid(12);
    let root_class = root.rem_euclid(12);
    let fifth = (root + 7).rem_euclid(12);
    let without_fifth = if fifth != bass {tones & !(1 << fifth)} else {tones};
    let mut order = [0usize; POSITION_FRETS.len()];
    for (index, slot) in order.iter_mut().enumerate() {
        *slot = index;
    }
    order.sort_unstable_by_key(|candidate| ((*candidate as i32 - position as i32).abs(), *candidate));
    for required in [tones, without_fifth, (1 << bass) | (1 << root_class)] {
        for candidate in order {
            let low = POSITION_FRETS[candidate];
            let mut search = Search {
                open, low, options: [[MUTED; MAX_OPTIONS]; STRINGS], counts: [0; STRINGS], bass, required, tones,
                tab: [MUTED; STRINGS], best: [MUTED; STRINGS], best_score: 0, found: false
            };
            for string in 0..STRINGS {
                let mut count = 1;
                for fret in (low - 1).max(0)..=low + 4 {
                    if tones & (1 << (open[string] + fret).rem_euclid(12)) != 0 && count < MAX_OPTIONS {
                        search.options[string][count] = fret as i8;
                        count += 1;
                    }
                }
                if low > 1 && tones & (1 << open[string].rem_euclid(12)) != 0 && count < MAX_OPTIONS {
                    search.options[string][count] = 0;
                    count += 1;
                }
                search.counts[string] = count;
            }
            search.walk(0);
            if search.found {
                return search.best;
            }
        }
    }
    [MUTED; STRINGS]
}

/// The pitch a string sounds at `fret` in `tuning`.
pub fn pitch(tuning: usize, string: usize, fret: i8) -> i32 {
    TUNINGS[tuning.min(TUNINGS.len() - 1)][string] + fret as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAJOR: i32 = 0b1001_0001;
    const MINOR: i32 = 0b1000_1001;

    fn text(tab: Tab) -> String {
        tab.iter().map(|fret| if *fret < 0 {"x".to_string()} else {fret.to_string()}).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn the_common_open_shapes() {
        let cases = [(0, MAJOR, "x 3 2 0 1 0"), (7, MAJOR, "3 2 0 0 0 3"), (9, MINOR, "x 0 2 2 1 0"),
            (4, MINOR, "0 2 2 0 0 0"), (2, MAJOR, "x x 0 2 3 2"), (5, MAJOR, "1 3 3 2 1 1"),
            (2, MINOR, "x x 0 2 3 1"), (4, MAJOR, "0 2 2 1 0 0"), (9, MAJOR, "x 0 2 2 2 0")];
        for (root, voicing, expected) in cases {
            assert_eq!(text(tab(root, voicing, 0, 0)), expected, "root {root}");
        }
    }

    #[test]
    fn the_bass_of_an_inversion_is_the_lowest_string() {
        let first_inversion = (1 << 4) | (1 << 7) | (1 << 12);
        let shape = tab(0, first_inversion, 0, 0);
        let first = shape.iter().position(|fret| *fret >= 0).unwrap();
        assert_eq!(pitch(0, first, shape[first]).rem_euclid(12), 4);
    }

    #[test]
    fn every_chord_tone_sounds_in_every_position_and_tuning() {
        for tuning in 0..TUNINGS.len() {
            for position in 0..POSITION_FRETS.len() {
                for root in 0..12 {
                    for voicing in [MAJOR, MINOR, MAJOR | (1 << 10), MINOR | (1 << 10), 0b1_0010_0001] {
                        let shape = tab(root, voicing, tuning, position);
                        let mut classes = 0;
                        for (string, fret) in shape.iter().enumerate() {
                            if *fret >= 0 {
                                classes |= 1 << pitch(tuning, string, *fret).rem_euclid(12);
                            }
                        }
                        assert!(classes & (1 << root) != 0, "root {root} {voicing:b} tuning {tuning} position {position}");
                    }
                }
            }
        }
    }

    // Rows of `root voicing tuning position f0..f5` written by guitar.test.ts in lib-dsp from `Guitar.tab`.
    #[test]
    fn parity_fixture() {
        let fixture = include_str!("../tests/fretting-parity.txt");
        let mut rows = 0;
        for line in fixture.lines() {
            let values: Vec<i32> = line.split(' ').map(|value| value.parse().unwrap()).collect();
            let expected: Tab = core::array::from_fn(|string| values[4 + string] as i8);
            assert_eq!(tab(values[0], values[1], values[2] as usize, values[3] as usize), expected, "{line}");
            rows += 1;
        }
        assert_eq!(rows, 3744);
    }
}

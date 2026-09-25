//! The DX7 pitch envelope (`pitchenv.cc`): four rate / level stages in Q24-per-octave.

use crate::N;

const PITCHENV_RATE: [u8; 100] = [
    1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12,
    12, 13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 30, 31, 33, 34, 36, 37, 38, 39, 41, 42, 44, 46, 47,
    49, 51, 53, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 79, 82,
    85, 88, 91, 94, 98, 102, 106, 110, 115, 120, 125, 130, 135, 141, 147,
    153, 159, 165, 171, 178, 185, 193, 202, 211, 232, 243, 254, 255
];

const PITCHENV_TAB: [i8; 100] = [
    -128, -116, -104, -95, -85, -76, -68, -61, -56, -52, -49, -46, -43,
    -41, -39, -37, -35, -33, -32, -31, -30, -29, -28, -27, -26, -25, -24,
    -23, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10,
    -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    28, 29, 30, 31, 32, 33, 34, 35, 38, 40, 43, 46, 49, 53, 58, 65, 73,
    82, 92, 103, 115, 127
];

/// `PitchEnv::init`: the per-sample-rate rate unit.
pub fn unit(sample_rate: f64) -> i32 {
    (N as f64 * (1u32 << 24) as f64 / (21.3 * sample_rate) + 0.5) as i32
}

#[derive(Clone, Copy, Default)]
pub struct PitchEnv {
    unit: i32,
    rates: [i32; 4],
    levels: [i32; 4],
    level: i32,
    targetlevel: i32,
    rising: bool,
    ix: i32,
    inc: i32,
    down: bool
}

impl PitchEnv {
    pub fn set(&mut self, rates: &[i32; 4], levels: &[i32; 4], unit: i32) {
        self.unit = unit;
        self.rates = *rates;
        self.levels = *levels;
        self.level = (PITCHENV_TAB[levels[3].clamp(0, 99) as usize] as i32) << 19;
        self.down = true;
        self.advance(0);
    }

    pub fn getsample(&mut self) -> i32 {
        if self.ix < 3 || (self.ix < 4 && !self.down) {
            if self.rising {
                self.level = self.level.wrapping_add(self.inc);
                if self.level >= self.targetlevel {
                    self.level = self.targetlevel;
                    self.advance(self.ix + 1);
                }
            } else {
                self.level = self.level.wrapping_sub(self.inc);
                if self.level <= self.targetlevel {
                    self.level = self.targetlevel;
                    self.advance(self.ix + 1);
                }
            }
        }
        self.level
    }

    pub fn keydown(&mut self, down: bool) {
        if self.down != down {
            self.down = down;
            self.advance(if down {0} else {3});
        }
    }

    fn advance(&mut self, newix: i32) {
        self.ix = newix;
        if self.ix < 4 {
            let newlevel = self.levels[self.ix as usize];
            self.targetlevel = (PITCHENV_TAB[newlevel.clamp(0, 99) as usize] as i32) << 19;
            self.rising = self.targetlevel > self.level;
            self.inc = PITCHENV_RATE[self.rates[self.ix as usize].clamp(0, 99) as usize] as i32 * self.unit;
        }
    }
}

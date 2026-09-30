//! The DX7 operator envelope (`env.cc`, ACCURATE_ENVELOPE): four rate / level stages, the level in
//! Q24-per-doubling log units subsampled every N samples, the measured static-time table for stages
//! whose level does not move, and the 44.1k rate multiplier for other sample rates.

use crate::N;

const LEVEL_LUT: [i32; 20] = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];

const STATICS: [i32; 77] = [
    1764000, 1764000, 1411200, 1411200, 1190700, 1014300, 992250,
    882000, 705600, 705600, 584325, 507150, 502740, 441000, 418950,
    352800, 308700, 286650, 253575, 220500, 220500, 176400, 145530,
    145530, 125685, 110250, 110250, 88200, 88200, 74970, 61740,
    61740, 55125, 48510, 44100, 37485, 31311, 30870, 27562, 27562,
    22050, 18522, 17640, 15435, 14112, 13230, 11025, 9261, 9261, 7717,
    6615, 6615, 5512, 5512, 4410, 3969, 3969, 3439, 2866, 2690, 2249,
    1984, 1896, 1808, 1411, 1367, 1234, 1146, 926, 837, 837, 705,
    573, 573, 529, 441, 441
];

/// `Env::init_sr`: the 44100-normalised rate multiplier, Q24.
pub fn sr_multiplier(sample_rate: f64) -> u32 {
    ((44100.0 / sample_rate) * (1u32 << 24) as f64) as u32
}

pub fn scaleoutlevel(outlevel: i32) -> i32 {
    if outlevel >= 20 {28 + outlevel} else {LEVEL_LUT[outlevel.clamp(0, 19) as usize]}
}

#[derive(Clone, Copy, Default)]
pub struct Env {
    initialised: bool,
    sr_multiplier: u32,
    rates: [i32; 4],
    levels: [i32; 4],
    outlevel: i32,
    rate_scaling: i32,
    level: i32,
    targetlevel: i32,
    rising: bool,
    ix: i32,
    inc: i32,
    staticcount: i32,
    down: bool
}

impl Env {
    pub fn init(&mut self, rates: &[i32; 4], levels: &[i32; 4], outlevel: i32, rate_scaling: i32, sr_multiplier: u32) {
        self.initialised = true;
        self.sr_multiplier = sr_multiplier;
        self.rates = *rates;
        self.levels = *levels;
        self.outlevel = outlevel;
        self.rate_scaling = rate_scaling;
        self.level = 0;
        self.down = true;
        self.advance(0);
    }

    pub fn getsample(&mut self) -> i32 {
        if self.staticcount != 0 {
            self.staticcount -= N as i32;
            if self.staticcount <= 0 {
                self.staticcount = 0;
                self.advance(self.ix + 1);
            }
        }
        if self.ix < 3 || (self.ix < 4 && !self.down) {
            if self.staticcount != 0 {
            } else if self.rising {
                const JUMPTARGET: i32 = 1716;
                if self.level < (JUMPTARGET << 16) {
                    self.level = JUMPTARGET << 16;
                }
                self.level = self.level.wrapping_add((((17 << 24) - self.level) >> 24).wrapping_mul(self.inc));
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
            let mut actuallevel = scaleoutlevel(newlevel) >> 1;
            actuallevel = (actuallevel << 6) + self.outlevel - 4256;
            actuallevel = if actuallevel < 16 {16} else {actuallevel};
            self.targetlevel = actuallevel << 16;
            self.rising = self.targetlevel > self.level;
            let mut qrate = (self.rates[self.ix as usize] * 41) >> 6;
            qrate += self.rate_scaling;
            qrate = qrate.min(63);
            if self.targetlevel == self.level || (self.ix == 0 && newlevel == 0) {
                let mut staticrate = self.rates[self.ix as usize];
                staticrate += self.rate_scaling;
                staticrate = staticrate.min(99);
                self.staticcount = if staticrate < 77 {STATICS[staticrate.max(0) as usize]} else {20 * (99 - staticrate)};
                if staticrate < 77 && (self.ix == 0 && newlevel == 0) {
                    self.staticcount /= 20;
                }
                self.staticcount = ((self.staticcount as i64 * self.sr_multiplier as i64) >> 24) as i32;
            } else {
                self.staticcount = 0;
            }
            self.inc = (4 + (qrate & 3)) << (2 + crate::LG_N + (qrate >> 2) as u32);
            self.inc = ((self.inc as i64 * self.sr_multiplier as i64) >> 24) as i32;
        }
    }

    pub fn update(&mut self, rates: &[i32; 4], levels: &[i32; 4], outlevel: i32, rate_scaling: i32) {
        self.rates = *rates;
        self.levels = *levels;
        self.outlevel = outlevel;
        self.rate_scaling = rate_scaling;
        if self.down {
            let newlevel = self.levels[2];
            let mut actuallevel = scaleoutlevel(newlevel) >> 1;
            actuallevel = (actuallevel << 6) - 4256;
            actuallevel = if actuallevel < 16 {16} else {actuallevel};
            self.targetlevel = actuallevel << 16;
            self.advance(2);
        }
    }

    pub fn transfer(&mut self, src: &Env) {
        self.rates = src.rates;
        self.levels = src.levels;
        self.outlevel = src.outlevel;
        self.rate_scaling = src.rate_scaling;
        self.level = src.level;
        self.targetlevel = src.targetlevel;
        self.rising = src.rising;
        self.ix = src.ix;
        self.down = src.down;
        self.staticcount = src.staticcount;
        self.inc = src.inc;
    }

    pub fn is_active(&self) -> bool {
        self.initialised && (self.ix < 4 || self.levels[3] > 0)
    }
}

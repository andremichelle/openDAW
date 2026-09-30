//! The DX7 LFO (`lfo.cc`): six waveforms at the hardware speed table, the delay ramp, key sync.

use crate::tables::Tables;
use crate::N;

const LFO_SOURCE: [f64; 100] = [
    0.062541, 0.125031, 0.312393, 0.437120, 0.624610,
    0.750694, 0.936330, 1.125302, 1.249609, 1.436782,
    1.560915, 1.752081, 1.875117, 2.062494, 2.247191,
    2.374451, 2.560492, 2.686728, 2.873976, 2.998950,
    3.188013, 3.369840, 3.500175, 3.682224, 3.812065,
    4.000800, 4.186202, 4.310716, 4.501260, 4.623209,
    4.814636, 4.930480, 5.121901, 5.315191, 5.434783,
    5.617346, 5.750431, 5.946717, 6.062811, 6.248438,
    6.431695, 6.564264, 6.749460, 6.868132, 7.052186,
    7.250580, 7.375719, 7.556294, 7.687577, 7.877738,
    7.993605, 8.181967, 8.372405, 8.504848, 8.685079,
    8.810573, 8.986341, 9.122423, 9.300595, 9.500285,
    9.607994, 9.798158, 9.950249, 10.117361, 11.251125,
    11.384335, 12.562814, 13.676149, 13.904338, 15.092062,
    16.366612, 16.638935, 17.869907, 19.193858, 19.425019,
    20.833333, 21.034918, 22.502250, 24.003841, 24.260068,
    25.746653, 27.173913, 27.578599, 29.052876, 30.693677,
    31.191516, 32.658393, 34.317090, 34.674064, 36.416606,
    38.197097, 38.550501, 40.387722, 40.749796, 42.625746,
    44.326241, 44.883303, 46.772685, 48.590865, 49.261084
];

#[derive(Clone, Copy, Default)]
pub struct Lfo {
    unit: u32,
    lforatio: u32,
    phase: u32,
    delta: u32,
    waveform: u8,
    randstate: u8,
    sync: bool,
    delaystate: u32,
    delayinc: u32,
    delayinc2: u32
}

impl Lfo {
    pub fn init(&mut self, sample_rate: f64) {
        self.unit = (N as f64 * 25190424.0 / sample_rate + 0.5) as i32 as u32;
        self.lforatio = (4437500000.0 * N as f64 / sample_rate) as u32;
    }

    /// `params` = patch bytes 137..143 (speed, delay, pmd, amd, sync, wave).
    pub fn reset(&mut self, params: &[u8]) {
        let rate = params[0].min(99) as usize;
        self.delta = (LFO_SOURCE[rate] * self.lforatio as f64) as u32;
        let mut a = 99 - params[1].min(99) as i32;
        if a == 99 {
            self.delayinc = !0u32;
            self.delayinc2 = !0u32;
        } else {
            a = (16 + (a & 15)) << (1 + (a >> 4));
            self.delayinc = self.unit.wrapping_mul(a as u32);
            a &= 0xff80;
            a = a.max(0x80);
            self.delayinc2 = self.unit.wrapping_mul(a as u32);
        }
        self.waveform = params[5];
        self.sync = params[4] != 0;
    }

    pub fn getsample(&mut self, tables: &Tables) -> i32 {
        self.phase = self.phase.wrapping_add(self.delta);
        match self.waveform {
            0 => {
                let mut x = (self.phase >> 7) as i32;
                x ^= -((self.phase >> 31) as i32);
                x &= (1 << 24) - 1;
                x
            }
            1 => ((!self.phase ^ (1u32 << 31)) >> 8) as i32,
            2 => ((self.phase ^ (1u32 << 31)) >> 8) as i32,
            3 => (((!self.phase) >> 7) & (1 << 24)) as i32,
            4 => (1 << 23) + (tables.sin_lookup((self.phase >> 8) as i32) >> 1),
            5 => {
                if self.phase < self.delta {
                    self.randstate = (self.randstate as u32 * 179 + 17) as u8;
                }
                let x = (self.randstate ^ 0x80) as i32;
                (x + 1) << 16
            }
            _ => 1 << 23
        }
    }

    pub fn getdelay(&mut self) -> i32 {
        let delta = if self.delaystate < (1u32 << 31) {self.delayinc} else {self.delayinc2};
        let d = self.delaystate as u64 + delta as u64;
        if d > u32::MAX as u64 {
            return 1 << 24;
        }
        self.delaystate = d as u32;
        if d < (1u64 << 31) {
            0
        } else {
            ((d >> 7) & ((1 << 24) - 1)) as i32
        }
    }

    pub fn keydown(&mut self) {
        if self.sync {
            self.phase = (1u32 << 31) - 1;
        }
        self.delaystate = 0;
    }
}

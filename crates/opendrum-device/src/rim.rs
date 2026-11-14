use opendrum::rim::{Rim, RimParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Rim {
    type Params = RimParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(100.0, 4000.0)},
        Param {key: 11, mapping: Mapping::Linear(1.0, 5.0)},
        Param {key: 12, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 13, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 14, mapping: Mapping::Linear(1.0, 12.0)},
        Param {key: 15, mapping: Mapping::Exponential(0.005, 1.0)},
        Param {key: 16, mapping: Mapping::Exponential(0.005, 1.0)},
        Param {key: 17, mapping: Mapping::Exponential(0.002, 0.5)},
        Param {key: 18, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 19, mapping: Mapping::Linear(0.0, 36.0)},
        Param {key: 20, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 21, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 22, mapping: Mapping::Linear(0.0, 8.0)},
        Param {key: 23, mapping: Mapping::Exponential(20.0, 4000.0)},
        Param {key: 24, mapping: Mapping::Index(2)},
        Param {key: 25, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 26, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 27, mapping: Mapping::Index(3)}
    ];

    fn set(params: &mut RimParams, index: usize, value: f32) {
        match index {
            0 => params.tune = value,
            1 => params.ratio = value,
            2 => params.balance = value,
            3 => params.high = value,
            4 => params.high_ratio = value,
            5 => params.ring = value,
            6 => params.ring_high = value,
            7 => params.decay = value,
            8 => params.punch = value,
            9 => params.drive = value,
            10 => params.hard = value,
            11 => params.click = value,
            12 => params.swell = value,
            13 => params.cut = value,
            14 => params.restart = value >= 0.5,
            15 => params.volume = value,
            16 => params.velocity = value,
            17 => params.play = play(value),
            _ => {}
        }
    }

    crate::forward!(Rim, RimParams);
}

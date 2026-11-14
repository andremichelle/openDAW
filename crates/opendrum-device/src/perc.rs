use opendrum::perc::{Perc, PercParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Perc {
    type Params = PercParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(20.0, 8000.0)},
        Param {key: 11, mapping: Mapping::Exponential(0.25, 16.0)},
        Param {key: 12, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 13, mapping: Mapping::Exponential(0.001, 2.0)},
        Param {key: 14, mapping: Mapping::Linear(-48.0, 48.0)},
        Param {key: 15, mapping: Mapping::Exponential(0.0005, 2.0)},
        Param {key: 16, mapping: Mapping::Exponential(0.005, 4.0)},
        Param {key: 17, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 18, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 19, mapping: Mapping::Linear(0.0, 36.0)},
        Param {key: 20, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 21, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 22, mapping: Mapping::Index(3)},
        Param {key: 23, mapping: Mapping::Linear(-1.0, 1.0)}
    ];

    fn set(params: &mut PercParams, index: usize, value: f32) {
        match index {
            0 => params.tune = value,
            1 => params.ratio = value,
            2 => params.index = value,
            3 => params.bite = value,
            4 => params.pitch = value,
            5 => params.sweep = value,
            6 => params.decay = value,
            7 => params.curve = value,
            8 => params.noise = value,
            9 => params.drive = value,
            10 => params.volume = value,
            11 => params.velocity = value,
            12 => params.play = play(value),
            _ => {}
        }
    }

    crate::forward!(Perc, PercParams);
}

use opendrum::hat::{Hat, HatParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Hat {
    type Params = HatParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(0.25, 4.0)},
        Param {key: 11, mapping: Mapping::Exponential(200.0, 16000.0)},
        Param {key: 12, mapping: Mapping::Linear(0.0, 0.5)},
        Param {key: 13, mapping: Mapping::Exponential(0.005, 4.0)},
        Param {key: 14, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 15, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 16, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 17, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 18, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 19, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 20, mapping: Mapping::Index(3)},
        Param {key: 21, mapping: Mapping::Linear(-1.0, 1.0)}
    ];

    fn set(params: &mut HatParams, index: usize, value: f32) {
        match index {
            0 => params.tune = value,
            1 => params.color = value,
            2 => params.hold = value,
            3 => params.decay = value,
            4 => params.spread = value,
            5 => params.ring = value,
            6 => params.reso = value,
            7 => params.curve = value,
            8 => params.volume = value,
            9 => params.velocity = value,
            10 => params.play = play(value),
            _ => {}
        }
    }

    crate::forward!(Hat, HatParams);
}

use opendrum::shaker::{Shaker, ShakerParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Shaker {
    type Params = ShakerParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(200.0, 16000.0)},
        Param {key: 11, mapping: Mapping::Linear(0.0, 0.2)},
        Param {key: 12, mapping: Mapping::Exponential(0.002, 2.0)},
        Param {key: 13, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 14, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 15, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 16, mapping: Mapping::Index(3)},
        Param {key: 17, mapping: Mapping::Linear(-1.0, 1.0)}
    ];

    fn set(params: &mut ShakerParams, index: usize, value: f32) {
        match index {
            0 => params.color = value,
            1 => params.attack = value,
            2 => params.decay = value,
            3 => params.curve = value,
            4 => params.volume = value,
            5 => params.velocity = value,
            6 => params.play = play(value),
            _ => {}
        }
    }

    crate::forward!(Shaker, ShakerParams);
}

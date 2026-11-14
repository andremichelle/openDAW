use opendrum::bell::{Bell, BellParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Bell {
    type Params = BellParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(50.0, 4000.0)},
        Param {key: 11, mapping: Mapping::Linear(1.0, 4.0)},
        Param {key: 12, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 13, mapping: Mapping::Exponential(100.0, 16000.0)},
        Param {key: 14, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 15, mapping: Mapping::Exponential(0.01, 4.0)},
        Param {key: 16, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 17, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 18, mapping: Mapping::Index(3)}
    ];

    fn set(params: &mut BellParams, index: usize, value: f32) {
        match index {
            0 => params.tune = value,
            1 => params.ratio = value,
            2 => params.balance = value,
            3 => params.color = value,
            4 => params.strike = value,
            5 => params.decay = value,
            6 => params.volume = value,
            7 => params.velocity = value,
            8 => params.play = play(value),
            _ => {}
        }
    }

    crate::forward!(Bell, BellParams);
}

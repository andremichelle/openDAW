use opendrum::tom::{Tom, TomParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Tom {
    type Params = TomParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(40.0, 800.0)},
        Param {key: 11, mapping: Mapping::Linear(0.0, 24.0)},
        Param {key: 12, mapping: Mapping::Exponential(0.001, 0.2)},
        Param {key: 13, mapping: Mapping::Linear(0.0, 12.0)},
        Param {key: 14, mapping: Mapping::Exponential(0.02, 3.0)},
        Param {key: 15, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 16, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 17, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 18, mapping: Mapping::Linear(0.5, 1.0)},
        Param {key: 19, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 20, mapping: Mapping::Exponential(0.02, 1.0)},
        Param {key: 21, mapping: Mapping::Linear(0.0, 36.0)},
        Param {key: 22, mapping: Mapping::Linear(-48.0, 0.0)},
        Param {key: 23, mapping: Mapping::Exponential(0.02, 3.0)},
        Param {key: 24, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 25, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 26, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 27, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 28, mapping: Mapping::Index(3)},
        Param {key: 29, mapping: Mapping::Linear(0.0, 1.0)}
    ];

    fn set(params: &mut TomParams, index: usize, value: f32) {
        match index {
            0 => params.tune = value,
            1 => params.pitch = value,
            2 => params.sweep = value,
            3 => params.drift = value,
            4 => params.decay = value,
            5 => params.punch = value,
            6 => params.shape = value,
            7 => params.sub = value,
            8 => params.ratio = value,
            9 => params.top = value,
            10 => params.length = value,
            11 => params.drive = value,
            12 => params.noise = value,
            13 => params.noise_decay = value,
            14 => params.color = value,
            15 => params.air = value,
            16 => params.volume = value,
            17 => params.velocity = value,
            18 => params.play = play(value),
            19 => params.glide = value,
            _ => {}
        }
    }

    crate::forward!(Tom, TomParams);
}

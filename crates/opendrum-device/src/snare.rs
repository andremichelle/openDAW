use opendrum::snare::{Snare, SnareParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Snare {
    type Params = SnareParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Exponential(80.0, 600.0)},
        Param {key: 11, mapping: Mapping::Linear(1.0, 3.0)},
        Param {key: 12, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 13, mapping: Mapping::Linear(0.0, 24.0)},
        Param {key: 14, mapping: Mapping::Exponential(0.001, 0.1)},
        Param {key: 15, mapping: Mapping::Exponential(0.02, 2.0)},
        Param {key: 16, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 17, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 18, mapping: Mapping::Linear(-48.0, -3.0)},
        Param {key: 19, mapping: Mapping::Exponential(0.02, 2.0)},
        Param {key: 20, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 21, mapping: Mapping::Linear(-1.0, 1.0)},
        Param {key: 22, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 23, mapping: Mapping::Exponential(200.0, 16000.0)},
        Param {key: 24, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 25, mapping: Mapping::Linear(0.0, 36.0)},
        Param {key: 26, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 27, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 28, mapping: Mapping::Index(3)},
        Param {key: 29, mapping: Mapping::Linear(0.0, 1.0)}
    ];

    fn set(params: &mut SnareParams, index: usize, value: f32) {
        match index {
            0 => params.tune = value,
            1 => params.ratio = value,
            2 => params.balance = value,
            3 => params.pitch = value,
            4 => params.sweep = value,
            5 => params.decay = value,
            6 => params.punch = value,
            7 => params.shape = value,
            8 => params.level = value,
            9 => params.wire_decay = value,
            10 => params.width = value,
            11 => params.curve = value,
            12 => params.click = value,
            13 => params.tone = value,
            14 => params.skin = value,
            15 => params.drive = value,
            16 => params.volume = value,
            17 => params.velocity = value,
            18 => params.play = play(value),
            19 => params.glide = value,
            _ => {}
        }
    }

    crate::forward!(Snare, SnareParams);
}

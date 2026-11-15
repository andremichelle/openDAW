use opendrum::clap::{Clap, ClapParams};
use crate::{play, Engine, Mapping, Param};

impl Engine for Clap {
    type Params = ClapParams;

    const PARAMS: &'static [Param] = &[
        Param {key: 10, mapping: Mapping::Integer(1, 8)},
        Param {key: 11, mapping: Mapping::Linear(0.0, 0.04)},
        Param {key: 12, mapping: Mapping::Linear(0.3, 1.5)},
        Param {key: 13, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 14, mapping: Mapping::Linear(0.0, 0.005)},
        Param {key: 15, mapping: Mapping::Exponential(0.002, 0.2)},
        Param {key: 16, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 17, mapping: Mapping::Linear(0.0, 36.0)},
        Param {key: 18, mapping: Mapping::Exponential(300.0, 8000.0)},
        Param {key: 19, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 20, mapping: Mapping::Linear(-48.0, 0.0)},
        Param {key: 21, mapping: Mapping::Exponential(0.02, 2.0)},
        Param {key: 22, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 23, mapping: Mapping::Linear(-36.0, 6.0)},
        Param {key: 24, mapping: Mapping::Linear(0.0, 1.0)},
        Param {key: 25, mapping: Mapping::Index(3)},
        Param {key: 26, mapping: Mapping::Linear(-1.0, 1.0)}
    ];

    fn set(params: &mut ClapParams, index: usize, value: f32) {
        match index {
            0 => params.hands = value,
            1 => params.gap = value,
            2 => params.last = value,
            3 => params.spread = value,
            4 => params.attack = value,
            5 => params.decay = value,
            6 => params.snap = value,
            7 => params.drive = value,
            8 => params.tone = value,
            9 => params.resonance = value,
            10 => params.room = value,
            11 => params.room_decay = value,
            12 => params.tail = value,
            13 => params.volume = value,
            14 => params.velocity = value,
            15 => params.play = play(value),
            _ => {}
        }
    }

    crate::forward!(Clap, ClapParams);
}

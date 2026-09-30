//! The 156 automatable parameters in bind order (the parity probe's ids): the box field path each one
//! binds, its integer range and where its value lands (a patch byte, an operator switch or the output
//! stage). Box operators are numbered OP1..OP6 like the panel; the patch stores OP6 first.

pub const COUNT: usize = 156;
const OPERATOR_PARAMS: usize = 22;
const OPERATOR_BASE: usize = 24;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Cutoff,
    Resonance,
    Output,
    Mono,
    Tune,
    /// A byte of the 155-byte patch.
    Byte(usize),
    /// The on / off switch of a patch operator (patch order, OP6 = 0).
    OpSwitch(usize)
}

pub struct Spec {
    pub path: [u16; 3],
    pub path_len: usize,
    pub max: i32,
    pub target: Target
}

const fn global(key: u16, max: i32, target: Target) -> Spec {
    Spec {path: [key, 0, 0], path_len: 1, max, target}
}

const fn lfo(key: u16, max: i32, offset: usize) -> Spec {
    Spec {path: [20, key, 0], path_len: 2, max, target: Target::Byte(offset)}
}

const OPERATOR_MAX: [i32; OPERATOR_PARAMS] = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14, 1];

pub fn patch_operator(box_operator: usize) -> usize {
    5 - box_operator
}

pub fn spec(index: usize) -> Spec {
    match index {
        0 => global(10, 0, Target::Cutoff),
        1 => global(11, 0, Target::Resonance),
        2 => global(12, 0, Target::Output),
        3 => global(13, 1, Target::Mono),
        4 => global(14, 0, Target::Tune),
        5 => global(15, 31, Target::Byte(134)),
        6 => global(16, 7, Target::Byte(135)),
        7 => global(17, 1, Target::Byte(136)),
        8 => lfo(1, 99, 137),
        9 => lfo(2, 99, 138),
        10 => lfo(3, 99, 139),
        11 => lfo(4, 99, 140),
        12 => lfo(5, 1, 141),
        13 => lfo(6, 5, 142),
        14 => global(21, 7, Target::Byte(143)),
        15 => global(22, 48, Target::Byte(144)),
        16..=19 => Spec {path: [30, (index - 16) as u16 + 1, 0], path_len: 2, max: 99, target: Target::Byte(126 + index - 16)},
        20..=23 => Spec {path: [30, (index - 20) as u16 + 11, 0], path_len: 2, max: 99, target: Target::Byte(130 + index - 20)},
        _ => {
            let op = (index - OPERATOR_BASE) / OPERATOR_PARAMS;
            let key = (index - OPERATOR_BASE) % OPERATOR_PARAMS;
            let target = if key == OPERATOR_PARAMS - 1 {
                Target::OpSwitch(patch_operator(op))
            } else {
                Target::Byte(patch_operator(op) * 21 + key)
            };
            Spec {path: [40, op as u16, key as u16 + 1], path_len: 3, max: OPERATOR_MAX[key], target}
        }
    }
}

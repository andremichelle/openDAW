import {BoxSchema, FieldRecord} from "@opendaw/lib-box-forge"
import {Pointers, VoicingMode} from "@opendaw/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

// A DX7 panel value stored as the hardware byte (0..max), the DSP owns the hardware tables.
const dx7 = (name: string, max: number, value: number = 0) => ({
    type: "int32", name, value, pointerRules: ParameterPointerRules, constraints: {min: 0, max}, unit: ""
} as const)

// One operator, the 22 panel values in sysex order. Defaults = Dexed's INIT VOICE operator.
const OperatorFields = {
    1: dx7("rate1", 99, 99), 2: dx7("rate2", 99, 99), 3: dx7("rate3", 99, 99), 4: dx7("rate4", 99, 99),
    5: dx7("level1", 99, 99), 6: dx7("level2", 99, 99), 7: dx7("level3", 99, 99), 8: dx7("level4", 99, 0),
    9: dx7("break-point", 99), 10: dx7("left-depth", 99), 11: dx7("right-depth", 99),
    12: dx7("left-curve", 3), 13: dx7("right-curve", 3), // -LIN, -EXP, +EXP, +LIN
    14: dx7("rate-scaling", 7), 15: dx7("amp-mod-sens", 3), 16: dx7("velocity-sens", 7),
    17: dx7("output-level", 99), 18: dx7("mode", 1), // ratio, fixed
    19: dx7("coarse", 31, 1), 20: dx7("fine", 99), 21: dx7("detune", 14, 7), // 7 = centre
    22: dx7("enabled", 1, 1)
} as const satisfies FieldRecord<Pointers>

export const TubularDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("TubularDeviceBox", "notes", {
    10: {type: "float32", name: "cutoff", pointerRules: ParameterPointerRules, value: 1.0, ...UnipolarConstraints},
    11: {type: "float32", name: "resonance", pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    12: {type: "float32", name: "volume", pointerRules: ParameterPointerRules, value: 1.0, ...UnipolarConstraints},
    13: {
        type: "int32", name: "voicing-mode", pointerRules: ParameterPointerRules,
        value: VoicingMode.Polyphonic, constraints: {values: [VoicingMode.Monophonic, VoicingMode.Polyphonic]}, unit: ""
    },
    14: {
        type: "float32", name: "tune", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -100, max: 100, scaling: "linear"}, unit: "ct"
    },
    15: dx7("algorithm", 31), // 0-based, the panel shows 1..32
    16: dx7("feedback", 7),
    17: dx7("osc-key-sync", 1, 1),
    20: {
        type: "object", name: "lfo", class: {
            name: "TubularLfo",
            fields: {
                1: dx7("speed", 99, 35),
                2: dx7("delay", 99),
                3: dx7("pm-depth", 99),
                4: dx7("am-depth", 99),
                5: dx7("sync", 1, 1),
                6: dx7("wave", 5) // triangle, saw down, saw up, square, sine, sample & hold
            }
        }
    },
    21: dx7("pitch-mod-sens", 7, 3),
    22: dx7("transpose", 48, 24), // 24 = C3, no shift
    30: {
        type: "object", name: "pitch-envelope", class: {
            name: "TubularPitchEnvelope",
            fields: {
                1: dx7("rate1", 99, 99), 2: dx7("rate2", 99, 99), 3: dx7("rate3", 99, 99), 4: dx7("rate4", 99, 99),
                11: dx7("level1", 99, 50), 12: dx7("level2", 99, 50), 13: dx7("level3", 99, 50), 14: dx7("level4", 99, 50)
            }
        }
    },
    // Bumped by every voice load: the device cuts all notes and restarts the LFO, as Dexed does on a
    // program change (plain field, not automatable).
    50: {type: "int32", name: "voice-load", value: 0, constraints: "index", unit: ""},
    // Operator kernel: 0 = Mark I (Dexed's default, hardware-like tables), 1 = Modern (msfa). Plain field.
    51: {type: "int32", name: "engine", value: 0, constraints: {min: 0, max: 1}, unit: ""},
    // Panel order OP1..OP6 (the sysex stores OP6 first; the adapter and the DSP map the index).
    40: {
        type: "array", name: "operators", length: 6, element: {
            type: "object",
            class: {name: "TubularOperator", fields: OperatorFields}
        }
    }
})

import {BoxSchema, FieldRecord} from "@opendaw/lib-box-forge"
import {Pointers, VoicingMode} from "@opendaw/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

// A CZ hardware value in the 0-99 domain, stored as a CONTINUOUS float so typed times/levels land
// exactly; a .syx import writes whole numbers, the DSP owns the hardware rate/level tables.
const czParameter = (name: string) => ({
    type: "float32", name, value: 0.0, pointerRules: ParameterPointerRules,
    constraints: {min: 0, max: 99, scaling: "linear"}, unit: ""
} as const)
const czStage = (name: string) => ({
    type: "float32", name, value: 0.0, constraints: {min: 0, max: 99, scaling: "linear"}, unit: ""
} as const)

// One 8-stage envelope (DCO pitch / DCW / DCA): per stage a rate and a level (raw 0-99), the sustain stage
// (1-8, 0 = none: hold there until note-off) and the end stage (1-8). Plain fields, not automatable.
const EnvelopeFields = {
    1: czStage("rate1"), 2: czStage("rate2"), 3: czStage("rate3"), 4: czStage("rate4"),
    5: czStage("rate5"), 6: czStage("rate6"), 7: czStage("rate7"), 8: czStage("rate8"),
    11: czStage("level1"), 12: czStage("level2"), 13: czStage("level3"), 14: czStage("level4"),
    15: czStage("level5"), 16: czStage("level6"), 17: czStage("level7"), 18: czStage("level8"),
    20: {type: "int32", name: "sustain", value: 0, constraints: {min: 0, max: 8}, unit: ""},
    21: {type: "int32", name: "end", value: 1, constraints: {min: 1, max: 8}, unit: ""}
} as const satisfies FieldRecord<Pointers>

export const NeonDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("NeonDeviceBox", "notes", {
    10: {
        type: "int32", name: "line-select", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 4}, unit: "" // 1, 2, 1+1', 1+2'
    },
    11: {
        type: "int32", name: "modulation", pointerRules: ParameterPointerRules,
        value: 0, constraints: {length: 3}, unit: "" // Off, Ring, Noise
    },
    12: {
        type: "int32", name: "octave", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -3, max: 3}, unit: "oct"
    },
    13: {
        // One continuous detune in CENTS (the .syx note+fine pair folds into this on import). The
        // hardware range is ±(3 octaves + 11 notes + 60 fine) ≈ ±48 semitones.
        type: "float32", name: "detune", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -4800, max: 4800, scaling: "linear"}, unit: "ct"
    },
    15: {
        type: "float32", name: "glide-time", pointerRules: ParameterPointerRules,
        value: 0.0, ...UnipolarConstraints
    },
    17: {
        type: "int32", name: "voicing-mode", pointerRules: ParameterPointerRules,
        value: VoicingMode.Polyphonic, constraints: {values: [VoicingMode.Monophonic, VoicingMode.Polyphonic]}, unit: ""
    },
    20: {
        type: "object", name: "vibrato", class: {
            name: "NeonVibrato",
            fields: {
                1: {
                    type: "int32", name: "wave", pointerRules: ParameterPointerRules,
                    value: 0, constraints: {length: 4}, unit: "" // Triangle, Saw Up, Saw Down, Square
                },
                2: czParameter("delay"),
                3: czParameter("rate"),
                4: czParameter("depth")
            }
        }
    },
    30: {
        type: "array", name: "lines", length: 2, element: {
            type: "object",
            class: {
                name: "NeonLine",
                fields: {
                    1: {
                        type: "int32", name: "wave1", pointerRules: ParameterPointerRules,
                        // Saw, Square, Pulse, Double Sine, Saw-Pulse, Resonance Saw/Triangle/Trapezoid
                        value: 0, constraints: {length: 8}, unit: ""
                    },
                    2: {
                        type: "int32", name: "wave2", pointerRules: ParameterPointerRules,
                        value: 0, constraints: {length: 9}, unit: "" // Off + the 8 waves
                    },
                    3: {
                        type: "float32", name: "dcw-key-follow", pointerRules: ParameterPointerRules,
                        value: 0.0, constraints: {min: 0, max: 9, scaling: "linear"}, unit: ""
                    },
                    4: {
                        type: "float32", name: "dca-key-follow", pointerRules: ParameterPointerRules,
                        value: 0.0, constraints: {min: 0, max: 9, scaling: "linear"}, unit: ""
                    }
                }
            }
        }
    },
    // The six 8-stage envelopes in a fixed order: line1 pitch, line1 DCW, line1 DCA, line2 pitch,
    // line2 DCW, line2 DCA.
    40: {
        type: "array", name: "envelopes", length: 6, element: {
            type: "object",
            class: {name: "NeonEnvelope", fields: EnvelopeFields}
        }
    }
})

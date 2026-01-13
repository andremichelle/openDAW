import {BoxSchema, deprecated} from "@moises-ai/lib-box-forge"
import {Pointers, VoicingMode} from "@moises-ai/studio-enums"
import {BipolarConstraints, ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ClassicWaveform} from "@moises-ai/lib-dsp"

const NoiseEnv = {value: 0.001, constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"} as const

export const VaporisateurDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("VaporisateurDeviceBox", {
    10: {
        type: "float32", name: "volume", deprecated, pointerRules: ParameterPointerRules,
        value: -6.0, constraints: "decibel", unit: "dB"
    },
    11: {
        type: "int32", name: "octave", deprecated, pointerRules: ParameterPointerRules,
        constraints: "any", unit: "oct"
    },
    12: {
        type: "float32", name: "tune", deprecated, pointerRules: ParameterPointerRules,
        constraints: "any", unit: "ct"
    },
    13: {
        type: "int32", name: "waveform", deprecated, pointerRules: ParameterPointerRules,
        constraints: "any", unit: ""
    },
    14: {
        type: "float32", name: "cutoff", pointerRules: ParameterPointerRules,
        constraints: {min: 20.0, max: 20_000.0, scaling: "exponential"}, unit: "Hz"
    },
    15: {
        type: "float32", name: "resonance", pointerRules: ParameterPointerRules,
        constraints: {min: 0.01, max: 10.0, scaling: "exponential"}, unit: "q"
    },
    16: {
        type: "float32", name: "attack", pointerRules: ParameterPointerRules,
        constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"
    },
    17: {
        type: "float32", name: "release", pointerRules: ParameterPointerRules,
        constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"
    },
    18: {
        type: "float32", name: "filter-envelope", pointerRules: ParameterPointerRules,
        ...BipolarConstraints
    },
    19: {
        type: "float32", name: "decay", pointerRules: ParameterPointerRules,
        value: 0.001, constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"
    },
    20: {
        type: "float32", name: "sustain", pointerRules: ParameterPointerRules,
        value: 1.0, ...UnipolarConstraints
    },
    21: {
        type: "float32", name: "glide-time", pointerRules: ParameterPointerRules,
        value: 0.0, ...UnipolarConstraints
    },
    22: {
        type: "int32", name: "voicing-mode", pointerRules: ParameterPointerRules,
        value: VoicingMode.Polyphonic, constraints: {values: [VoicingMode.Monophonic, VoicingMode.Polyphonic]}, unit: ""
    },
    23: {
        type: "int32", name: "unison-count", pointerRules: ParameterPointerRules,
        value: 1, constraints: {values: [1, 3, 5]}, unit: ""
    },
    24: {
        type: "float32", name: "unison-detune", pointerRules: ParameterPointerRules,
        value: 30, constraints: {min: 1.0, max: 1200.0, scaling: "exponential"}, unit: "ct"
    },
    25: {
        type: "float32", name: "unison-stereo", pointerRules: ParameterPointerRules,
        value: 1.0, ...UnipolarConstraints
    },
    26: {
        type: "int32", name: "filter-order", pointerRules: ParameterPointerRules,
        value: 1, constraints: {values: [1, 2, 3, 4]}, unit: ""
    },
    27: {
        type: "float32", name: "filter-keyboard", pointerRules: ParameterPointerRules,
        ...BipolarConstraints
    },
    30: {
        type: "object", name: "lfo", class: {
            name: "VaporisateurLFO",
            fields: {
                1: {
                    type: "int32", name: "waveform", pointerRules: ParameterPointerRules,
                    constraints: {
                        values: [
                            ClassicWaveform.sine, ClassicWaveform.triangle,
                            ClassicWaveform.saw, ClassicWaveform.square
                        ]
                    }, unit: ""
                },
                2: {
                    type: "float32", name: "rate", pointerRules: ParameterPointerRules,
                    value: 0.0001, constraints: {min: 0.0001, max: 30.0, scaling: "exponential"}, unit: "Hz"
                },
                3: {
                    type: "boolean", name: "sync", pointerRules: ParameterPointerRules, value: false
                },
                10: {
                    type: "float32", name: "target-tune", pointerRules: ParameterPointerRules,
                    ...BipolarConstraints
                },
                11: {
                    type: "float32", name: "target-cutoff", pointerRules: ParameterPointerRules,
                    ...BipolarConstraints
                },
                12: {
                    type: "float32", name: "target-volume", pointerRules: ParameterPointerRules,
                    ...BipolarConstraints
                }
            }
        }
    },
    40: {
        type: "array", name: "oscillators", length: 2, element: {
            type: "object",
            class: {
                name: "VaporisateurOsc",
                fields: {
                    1: {
                        type: "int32", name: "waveform", pointerRules: ParameterPointerRules,
                        constraints: {
                            values: [
                                ClassicWaveform.sine, ClassicWaveform.triangle,
                                ClassicWaveform.saw, ClassicWaveform.square
                            ]
                        }, unit: ""
                    },
                    2: {
                        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
                        value: Number.NEGATIVE_INFINITY,
                        constraints: "decibel", unit: "db"
                    },
                    3: {
                        type: "int32", name: "octave", pointerRules: ParameterPointerRules,
                        value: 0, constraints: {min: -3, max: 3}, unit: "oct"
                    },
                    4: {
                        type: "float32", name: "tune", pointerRules: ParameterPointerRules,
                        constraints: {min: -1200.0, max: 1200.0, scaling: "linear"}, unit: "ct"
                    }
                }
            }
        }
    },
    50: {
        type: "object",
        name: "noise",
        class: {
            name: "VaporisateurNoise",
            fields: {
                1: {
                    type: "float32", name: "attack", pointerRules: ParameterPointerRules, ...NoiseEnv
                },
                2: {
                    type: "float32", name: "hold", pointerRules: ParameterPointerRules, ...NoiseEnv
                },
                3: {
                    type: "float32", name: "release", pointerRules: ParameterPointerRules, ...NoiseEnv
                },
                4: {
                    type: "float32", name: "volume", pointerRules: ParameterPointerRules,
                    value: 0.001, constraints: "decibel", unit: "db"
                }
            }
        }
    },
    99: {type: "int32", name: "version", constraints: "any", unit: ""}
})
import {BoxSchema, FieldRecord} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

const Seconds = {constraints: {min: 0.0, max: 5.0, scaling: "linear"}, unit: "s"} as const
const Time = {constraints: {min: 0.001, max: 8.0, scaling: "exponential"}, unit: "s"} as const

const envelope = (attack: number, decay: number, sustain: number): FieldRecord<Pointers> => ({
    1: {type: "float32", name: "delay", pointerRules: ParameterPointerRules, value: 0.0, ...Seconds},
    2: {type: "float32", name: "attack", pointerRules: ParameterPointerRules, value: attack, ...Time},
    3: {type: "float32", name: "hold", pointerRules: ParameterPointerRules, value: 0.0, ...Seconds},
    4: {type: "float32", name: "decay", pointerRules: ParameterPointerRules, value: decay, ...Time},
    5: {type: "float32", name: "sustain", pointerRules: ParameterPointerRules, value: sustain, ...UnipolarConstraints},
    6: {type: "float32", name: "release", pointerRules: ParameterPointerRules, value: 0.25, ...Time}
})

const lfo = (rate: number): FieldRecord<Pointers> => ({
    1: {
        type: "int32", name: "shape", pointerRules: ParameterPointerRules,
        value: 0, constraints: {values: [0, 1, 2, 3]}, unit: "" // sine, triangle, saw, square
    },
    2: {
        type: "float32", name: "rate", pointerRules: ParameterPointerRules,
        value: rate, constraints: {min: 0.01, max: 30.0, scaling: "exponential"}, unit: "Hz"
    },
    3: {type: "float32", name: "delay", pointerRules: ParameterPointerRules, value: 0.0, ...Seconds},
    4: {type: "float32", name: "fade", pointerRules: ParameterPointerRules, value: 0.0, ...Seconds},
    5: {type: "boolean", name: "sync", pointerRules: ParameterPointerRules, value: false},
    6: {type: "boolean", name: "restart", pointerRules: ParameterPointerRules, value: true}
})

export const SamplerDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("SamplerDeviceBox", "notes", {
    10: {type: "field", name: "zones", pointerRules: {accepts: [Pointers.SamplerZone], mandatory: false}},
    11: {type: "field", name: "groups", pointerRules: {accepts: [Pointers.SamplerGroup], mandatory: false}},
    12: {type: "field", name: "modulations", pointerRules: {accepts: [Pointers.SamplerModulation], mandatory: false}},
    20: {
        type: "int32", name: "voices", pointerRules: ParameterPointerRules,
        value: 16, constraints: {min: 1, max: 64}, unit: ""
    },
    21: {type: "float32", name: "glide", pointerRules: ParameterPointerRules, value: 0.0, ...Seconds},
    22: {type: "boolean", name: "legato", pointerRules: ParameterPointerRules, value: false},
    23: {
        type: "int32", name: "octave", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -3, max: 3}, unit: "oct"
    },
    24: {
        type: "int32", name: "transpose", pointerRules: ParameterPointerRules,
        value: 0, constraints: {min: -12, max: 12}, unit: "st"
    },
    25: {
        type: "float32", name: "tune", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: {min: -100.0, max: 100.0, scaling: "linear"}, unit: "ct"
    },
    30: {
        type: "int32", name: "filter-type", pointerRules: ParameterPointerRules,
        value: 0, constraints: {values: [0, 1, 2, 3]}, unit: "" // off, low-pass 12, low-pass 24, high-pass 12
    },
    31: {
        type: "float32", name: "cutoff", pointerRules: ParameterPointerRules,
        value: 20_000.0, constraints: {min: 20.0, max: 20_000.0, scaling: "exponential"}, unit: "Hz"
    },
    32: {
        type: "float32", name: "resonance", pointerRules: ParameterPointerRules,
        value: 0.0, ...UnipolarConstraints
    },
    40: {
        type: "float32", name: "volume", pointerRules: ParameterPointerRules,
        value: -3.0, constraints: "decibel", unit: "dB"
    },
    41: {type: "float32", name: "panning", pointerRules: ParameterPointerRules, constraints: "bipolar", unit: ""},
    42: {type: "float32", name: "mono", pointerRules: ParameterPointerRules, value: 0.0, ...UnipolarConstraints},
    50: {
        type: "object", name: "amp-envelope",
        class: {name: "SamplerAmpEnvelope", fields: envelope(0.001, 0.5, 1.0)}
    },
    51: {
        type: "object", name: "mod-envelope",
        class: {name: "SamplerModEnvelope", fields: envelope(0.001, 0.5, 0.0)}
    },
    60: {type: "object", name: "lfo-a", class: {name: "SamplerLfoA", fields: lfo(5.0)}},
    61: {type: "object", name: "lfo-b", class: {name: "SamplerLfoB", fields: lfo(0.5)}}
})

import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {IndexConstraints, ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"

export const CubedDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("CubedDeviceBox", "notes", {
    10: {type: "float32", name: "tuning", pointerRules: ParameterPointerRules, value: 0.5, ...UnipolarConstraints},
    11: {type: "float32", name: "cutoff", pointerRules: ParameterPointerRules, value: 0.4, ...UnipolarConstraints},
    12: {type: "float32", name: "resonance", pointerRules: ParameterPointerRules, value: 0.6, ...UnipolarConstraints},
    13: {type: "float32", name: "env-mod", pointerRules: ParameterPointerRules, value: 0.55, ...UnipolarConstraints},
    14: {type: "float32", name: "decay", pointerRules: ParameterPointerRules, value: 0.4, ...UnipolarConstraints},
    15: {type: "float32", name: "accent", pointerRules: ParameterPointerRules, value: 0.7, ...UnipolarConstraints},
    16: {type: "float32", name: "volume", pointerRules: ParameterPointerRules, value: 0.0, constraints: "decibel", unit: "dB"},
    17: {type: "int32", name: "waveform", pointerRules: ParameterPointerRules, value: 0, constraints: {values: [0, 1]}, unit: ""},
    20: {type: "int32", name: "pattern-index", pointerRules: ParameterPointerRules, value: 0, constraints: {min: 0, max: 127}, unit: ""},
    30: {type: "field", name: "patterns", pointerRules: {accepts: [Pointers.Pattern], mandatory: false}},
    99: {type: "int32", name: "version", constraints: "any", unit: ""}
})

export const CubedPatternBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "CubedPatternBox",
        fields: {
            10: {type: "pointer", name: "device", pointerType: Pointers.Pattern, mandatory: true},
            11: {type: "int32", name: "index", ...IndexConstraints},
            12: {type: "int32", name: "length", value: 16, constraints: {min: 1, max: 64}, unit: ""},
            // each int32 packs midi-note (7 bits), on/off (1), slide (1), accent (1). adapter packs/unpacks
            20: {type: "array", name: "steps", length: 64, element: {type: "int32", constraints: "any", unit: ""}}
        }
    },
    pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}

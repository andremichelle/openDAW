import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules, UnipolarConstraints} from "../../std/Defaults"

export const PlayfieldDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument("PlayfieldDeviceBox", {
    10: {type: "field", name: "samples", pointerRules: {accepts: [Pointers.Sample], mandatory: false}}
})

export const PlayfieldSampleBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "PlayfieldSampleBox",
        fields: {
            10: {type: "pointer", name: "device", pointerType: Pointers.Sample, mandatory: true},
            11: {type: "pointer", name: "file", pointerType: Pointers.AudioFile, mandatory: true},
            12: {
                type: "field",
                name: "midi-effects",
                pointerRules: {accepts: [Pointers.MIDIEffectHost], mandatory: false}
            },
            13: {
                type: "field",
                name: "audio-effects",
                pointerRules: {accepts: [Pointers.AudioEffectHost], mandatory: false}
            },
            15: {
                type: "int32", name: "index",
                value: 60, constraints: {min: 0, max: 127}, unit: ""
            },
            20: {type: "string", name: "label"},
            21: {type: "string", name: "icon"},
            22: {type: "boolean", name: "enabled", value: true},
            23: {type: "boolean", name: "minimized", value: false},
            40: {type: "boolean", name: "mute"},
            41: {type: "boolean", name: "solo"},
            42: {type: "boolean", name: "exclude"},
            43: {type: "boolean", name: "polyphone"},
            44: {type: "int32", name: "gate", value: 0, constraints: {length: 3}, unit: ""}, // Off, On, Loop
            45: {
                type: "float32", name: "pitch", pointerRules: ParameterPointerRules,
                constraints: {min: -1200, max: 1200, scaling: "linear"}, unit: "ct"
            },
            46: {
                type: "float32", name: "sample-start", pointerRules: ParameterPointerRules,
                value: 0.0, ...UnipolarConstraints
            },
            47: {
                type: "float32", name: "sample-end", pointerRules: ParameterPointerRules,
                value: 1.0, ...UnipolarConstraints
            },
            48: {
                type: "float32", name: "attack", pointerRules: ParameterPointerRules,
                value: 0.001, constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"
            },
            49: {
                type: "float32", name: "release", pointerRules: ParameterPointerRules,
                value: 0.020, constraints: {min: 0.001, max: 5.0, scaling: "exponential"}, unit: "s"
            }
        }
    }, pointerRules: {accepts: [Pointers.Editing, Pointers.SideChain, Pointers.Selection], mandatory: false}
}
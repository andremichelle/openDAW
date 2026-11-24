import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {UnipolarConstraints} from "./Defaults"

export const MIDIControllerBox: BoxSchema<Pointers> = {
    type: "box",
    ephemeral: true,
    class: {
        name: "MIDIControllerBox",
        fields: {
            1: {type: "pointer", name: "controllers", pointerType: Pointers.MIDIControllers, mandatory: true},
            2: {type: "pointer", name: "parameter", pointerType: Pointers.MIDIControl, mandatory: true},
            3: {type: "string", name: "device-id"},
            4: {type: "int32", name: "device-channel", constraints: {min: 0, max: 127}, unit: ""},
            5: {type: "int32", name: "control-id", constraints: {min: 0, max: 127}, unit: ""},
            6: {type: "float32", name: "min", value: 0.0, ...UnipolarConstraints},
            7: {type: "float32", name: "max", value: 1.0, ...UnipolarConstraints},
            8: {type: "int32", name: "takeover", value: 0, constraints: {min: 0, max: 2}, unit: ""},
            9: {type: "int32", name: "encoding", value: 0, constraints: {min: 0, max: 3}, unit: ""},
            11: {type: "string", name: "filter-device-id"},
            12: {type: "string", name: "key-code"},
            13: {type: "int32", name: "key-mode", value: 0, constraints: {min: 0, max: 1}, unit: ""}
        }
    }
}
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const MIDIControllerBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "MIDIControllerBox",
        fields: {
            1: {type: "pointer", name: "controllers", pointerType: Pointers.MIDIControllers, mandatory: true},
            2: {type: "pointer", name: "parameter", pointerType: Pointers.MIDIControl, mandatory: true},
            3: {type: "string", name: "device-id"},
            4: {type: "int32", name: "device-channel", constraints: {min: 0, max: 127}, unit: ""},
            5: {type: "int32", name: "control-id", constraints: {min: 0, max: 127}, unit: ""}
        }
    }
}
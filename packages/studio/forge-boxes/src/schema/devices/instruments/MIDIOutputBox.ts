import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const MIDIOutputBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "MIDIOutputBox",
        fields: {
            1: {type: "pointer", name: "root", pointerType: Pointers.MIDIDevice, mandatory: true},
            2: {type: "field", name: "device", pointerRules: {accepts: [Pointers.MIDIDevice], mandatory: true}},
            3: {type: "string", name: "id"},
            4: {type: "string", name: "label"},
            5: {
                type: "int32", name: "delayInMs",
                value: 10, constraints: {min: 0, max: 500}, unit: "ms"
            },
            6: {type: "boolean", name: "send-transport-messages", value: true}
        }
    }
}
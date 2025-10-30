import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const MIDIOutputParameterBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "MIDIOutputParameterBox",
        fields: {
            1: {type: "pointer", name: "owner", pointerType: Pointers.Parameter, mandatory: true},
            2: {type: "string", name: "label", value: ""},
            3: {type: "int32", name: "controller", value: 64},
            4: {
                type: "float32", name: "value", pointerRules: {
                    accepts: [Pointers.Modulation, Pointers.Automation, Pointers.MidiControl],
                    mandatory: true
                }
            }
        }
    }
}
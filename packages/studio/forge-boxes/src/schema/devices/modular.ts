import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceFactory} from "../std/DeviceFactory"
import {UnipolarConstraints} from "../std/Defaults"

const DeviceInterfaceElement = {
    1: {type: "pointer", name: "user-interface", pointerType: Pointers.DeviceUserInterface, mandatory: true},
    2: {type: "pointer", name: "parameter", pointerType: Pointers.ParameterController, mandatory: true},
    3: {type: "int32", name: "index", constraints: "index", unit: ""},
    ...reserveMany(4, 5, 6, 7, 8, 9)
} satisfies FieldRecord<Pointers>

export const DeviceInterfaceKnobBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "DeviceInterfaceKnobBox",
        fields: mergeFields(DeviceInterfaceElement, {
            10: {type: "float32", name: "anchor", ...UnipolarConstraints},
            11: {type: "string", name: "color"}
        })
    }
}

export const ModularDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("ModularDeviceBox", {
    10: {
        type: "pointer",
        name: "modular-setup",
        pointerType: Pointers.ModularSetup,
        mandatory: true
    },
    11: {
        type: "object", name: "user-interface", class: {
            name: "DeviceUserInterface",
            fields: {
                1: {
                    type: "field",
                    name: "elements",
                    pointerRules: {accepts: [Pointers.DeviceUserInterface], mandatory: false}
                }
            }
        }
    }
})
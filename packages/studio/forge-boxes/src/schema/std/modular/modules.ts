import {BoxSchema, FieldName, FieldSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {UnipolarConstraints} from "../Defaults"

export const createVoltageConnector = (name: string): FieldSchema<Pointers.VoltageConnection> & FieldName => ({
    type: "field", name, pointerRules: {mandatory: false, accepts: [Pointers.VoltageConnection]}
})

export const ModularUserEditingBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ModularUserEditingBox",
        fields: {
            1: {type: "pointer", name: "system", pointerType: Pointers.Editing, mandatory: true},
            2: {type: "pointer", name: "editing", pointerType: Pointers.Editing, mandatory: true},
            3: {type: "int32", name: "x", constraints: "any", unit: "x"},
            4: {type: "int32", name: "y", constraints: "any", unit: "y"},
            5: {type: "float32", name: "scale", value: 1.0, ...UnipolarConstraints}
        }
    }
}

export const ModularBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ModularBox",
        fields: {
            1: {type: "pointer", name: "collection", pointerType: Pointers.ModularSetup, mandatory: true},
            2: {type: "field", name: "device", pointerRules: {accepts: [Pointers.ModularSetup], mandatory: true}},
            3: {type: "field", name: "editing", pointerRules: {accepts: [Pointers.Editing], mandatory: false}},
            11: {
                type: "field",
                name: "modules",
                pointerRules: {accepts: [Pointers.ModuleCollection], mandatory: false}
            },
            12: {
                type: "field",
                name: "connections",
                pointerRules: {accepts: [Pointers.ConnectionCollection], mandatory: false}
            },
            13: {type: "string", name: "label"}
        }
    }
}

export const ModuleConnectionBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ModuleConnectionBox",
        fields: {
            1: {type: "pointer", name: "collection", pointerType: Pointers.ConnectionCollection, mandatory: true},
            2: {type: "pointer", name: "source", pointerType: Pointers.VoltageConnection, mandatory: true},
            3: {type: "pointer", name: "target", pointerType: Pointers.VoltageConnection, mandatory: true}
        }
    }
}
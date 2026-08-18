import {Pointers} from "@opendaw/studio-enums"
import {BipolarConstraints, IndexConstraints, ParameterPointerRules} from "./Defaults"
import {BoxSchema} from "@opendaw/lib-box-forge"

// Both pointers are mandatory, so deleting either end takes the assignment with it.
export const ModulationBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ModulationBox",
        fields: {
            1: {type: "pointer", name: "source", pointerType: Pointers.ModulatorSource, mandatory: true},
            2: {type: "pointer", name: "target", pointerType: Pointers.Modulation, mandatory: true},
            3: {
                type: "float32", name: "depth", pointerRules: ParameterPointerRules,
                value: 0.0, ...BipolarConstraints
            },
            4: {type: "boolean", name: "enabled", value: true},
            5: {type: "int32", name: "index", ...IndexConstraints}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}

import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const NeuralAmpModelBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NeuralAmpModelBox",
        fields: {
            1: {type: "string", name: "label"},
            2: {type: "string", name: "model"}
        }
    },
    pointerRules: {accepts: [Pointers.NeuralAmpModel], mandatory: true},
    resource: "preserved"
}

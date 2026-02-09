import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const ShadertoyBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ShadertoyBox",
        fields: {
            1: {type: "string", name: "shader-code"},
            2: {type: "boolean", name: "highres", value: true}
        }
    },
    pointerRules: {accepts: [Pointers.Shadertoy], mandatory: true}
}
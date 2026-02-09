import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {HueConstraints, PPQNPositionConstraints} from "../Defaults"

export const MarkerBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "MarkerBox",
        fields: {
            1: {type: "pointer", name: "track", pointerType: Pointers.MarkerTrack, mandatory: true},
            2: {type: "int32", name: "position", ...PPQNPositionConstraints},
            3: {type: "int32", name: "plays", value: 1, constraints: "non-negative", unit: ""}, // 0 is infinite plays, 1 is one play (normal), ...n for n plays
            4: {type: "string", name: "label"},
            5: {type: "int32", name: "hue", ...HueConstraints}
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.MetaData], mandatory: false}
}
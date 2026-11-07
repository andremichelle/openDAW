import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {PPQNPositionConstraints} from "../Defaults"

export const KeyEventBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "KeyEventBox",
        fields: {
            1: {type: "pointer", name: "track", pointerType: Pointers.KeyTrack, mandatory: true},
            2: {type: "int32", name: "position", ...PPQNPositionConstraints},
            3: {type: "int32", name: "root", value: 0, constraints: {min: 0, max: 11}, unit: ""},
            4: {type: "int32", name: "scale", value: 0b101010110101, constraints: {min: 1, max: 4095}, unit: ""}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}

import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {PPQNDurationConstraints, PPQNPositionConstraints} from "../Defaults"

export const ChordEventBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ChordEventBox",
        fields: {
            1: {type: "pointer", name: "track", pointerType: Pointers.ChordTrack, mandatory: true},
            2: {type: "int32", name: "position", ...PPQNPositionConstraints},
            3: {type: "int32", name: "duration", ...PPQNDurationConstraints},
            4: {type: "int32", name: "degree", value: 1, constraints: {min: 1, max: 7}, unit: ""},
            5: {type: "int32", name: "shift", value: 0, constraints: {min: -1, max: 1}, unit: "st"},
            6: {type: "int32", name: "shape", value: 0, constraints: {min: 0, max: 4095}, unit: ""}
        }
    }, pointerRules: {accepts: [Pointers.Selection], mandatory: false}
}

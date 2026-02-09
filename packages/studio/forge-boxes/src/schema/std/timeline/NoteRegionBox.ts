import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {HueConstraints, PPQNDurationConstraints, PPQNPositionConstraints} from "../Defaults"

export const NoteRegionBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteRegionBox",
        fields: {
            1: {type: "pointer", name: "regions", pointerType: Pointers.RegionCollection, mandatory: true},
            2: {type: "pointer", name: "events", pointerType: Pointers.NoteEventCollection, mandatory: true},
            10: {type: "int32", name: "position", ...PPQNPositionConstraints},
            11: {type: "int32", name: "duration", ...PPQNDurationConstraints},
            12: {type: "int32", name: "loop-offset", ...PPQNPositionConstraints},
            13: {type: "int32", name: "loop-duration", ...PPQNDurationConstraints},
            14: {type: "int32", name: "event-offset", ...PPQNPositionConstraints},
            15: {type: "boolean", name: "mute"},
            16: {type: "string", name: "label"},
            17: {type: "int32", name: "hue", ...HueConstraints}
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.Editing, Pointers.MetaData], mandatory: false}
}
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ClipTriggerFields} from "./ClipTriggerFields"
import {HueConstraints, IndexConstraints, PPQNDurationConstraints} from "../Defaults"

export const NoteClipBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NoteClipBox",
        fields: {
            1: {type: "pointer", name: "clips", pointerType: Pointers.ClipCollection, mandatory: true},
            2: {type: "pointer", name: "events", pointerType: Pointers.NoteEventCollection, mandatory: true},
            3: {type: "int32", name: "index", ...IndexConstraints},
            4: {type: "object", name: "trigger-mode", class: ClipTriggerFields},
            10: {type: "int32", name: "duration", ...PPQNDurationConstraints},
            11: {type: "boolean", name: "mute"},
            12: {type: "string", name: "label"},
            13: {type: "int32", name: "hue", ...HueConstraints}
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.Editing, Pointers.MetaData], mandatory: false}
}
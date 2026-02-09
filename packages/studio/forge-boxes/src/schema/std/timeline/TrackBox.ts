import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {IndexConstraints} from "../Defaults"

export const TrackBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "TrackBox",
        fields: {
            1: {type: "pointer", name: "tracks", pointerType: Pointers.TrackCollection, mandatory: true},
            2: {type: "pointer", name: "target", pointerType: Pointers.Automation, mandatory: true},
            3: {type: "field", name: "regions", pointerRules: {accepts: [Pointers.RegionCollection], mandatory: false}},
            4: {type: "field", name: "clips", pointerRules: {accepts: [Pointers.ClipCollection], mandatory: false}},
            10: {type: "int32", name: "index", ...IndexConstraints},
            11: {
                type: "int32", name: "type", constraints: {
                    values: [0, 1, 2, 3] // TrackType
                }, unit: ""
            },
            20: {type: "boolean", name: "enabled", value: true},
            30: {type: "boolean", name: "exclude-piano-mode", value: false}
        }
    }, pointerRules: {accepts: [Pointers.Selection, Pointers.PianoMode, Pointers.MetaData], mandatory: false}
}
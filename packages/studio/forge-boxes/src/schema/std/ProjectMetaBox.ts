import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const ProjectMetaBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "ProjectMetaBox",
        fields: {
            1: {type: "string", name: "project-name"},
            2: {type: "string", name: "artist"},
            3: {type: "string", name: "description"},
            4: {type: "string", name: "tag-list", value: "[]"}, // JSON encoded Array<string>
            5: {type: "string", name: "notepad"},
            6: {type: "string", name: "created"},
            7: {type: "string", name: "modified"},
            8: {type: "string", name: "cover-id"} // content id of the cover; bytes travel over P2P (empty = no cover)
        }
    },
    pointerRules: {accepts: [Pointers.ProjectMeta], mandatory: true}
}

import {BoxSchema} from "@opendaw/lib-box-forge"
import {MaxTrackHeight, Pointers} from "@opendaw/studio-enums"

export const ViewStateBox: BoxSchema<Pointers> = {
    type: "box",
    ephemeral: true,
    class: {
        name: "ViewStateBox",
        fields: {
            1: {type: "pointer", name: "user", pointerType: Pointers.ViewState, mandatory: true},
            2: {type: "pointer", name: "target", pointerType: Pointers.ViewState, mandatory: true},
            3: {type: "boolean", name: "group-collapsed"},
            4: {type: "boolean", name: "automation-collapsed"},
            5: {type: "int32", name: "height", value: 0, constraints: {min: 0, max: MaxTrackHeight}, unit: "px"}
        }
    }
}

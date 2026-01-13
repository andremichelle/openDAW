import {BoxSchema} from "@moises-ai/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

export const UserInterfaceBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        fields: {
            1: {
                type: "pointer",
                name: "root",
                mandatory: true,
                pointerType: Pointers.User
            },
            10: {
                type: "field",
                name: "selection",
                pointerRules: {accepts: [Pointers.Selection], mandatory: false}
            },
            11: {
                type: "field",
                name: "upload-states",
                pointerRules: {accepts: [Pointers.FileUploadState], mandatory: false}
            },
            21: {
                type: "pointer",
                name: "editing-device-chain", pointerType: Pointers.Editing, mandatory: false
            },
            22: {
                type: "pointer",
                name: "editing-timeline-region", pointerType: Pointers.Editing, mandatory: false
            },
            23: {
                type: "pointer",
                name: "editing-modular-system", pointerType: Pointers.Editing, mandatory: false
            },
            30: {
                type: "field",
                name: "midi-controllers",
                pointerRules: {accepts: [Pointers.MIDIControllers], mandatory: false}
            }
        },
        name: "UserInterfaceBox"
    }, pointerRules: {accepts: [Pointers.MetaData], mandatory: false}
}
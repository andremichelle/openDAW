import {BoxSchema, FieldRecord, mergeFields, reserveMany} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"

const CaptureAttributes = {
    1: {type: "string", name: "device-id"},
    2: {type: "string", name: "record-mode", value: "normal"}, // "normal" | "replace" | "punch"
    ...reserveMany(3, 4, 5, 6, 7, 8, 9)
} as const satisfies FieldRecord<Pointers>

export const CaptureAudioBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "CaptureAudioBox",
        fields: mergeFields(CaptureAttributes, {
            10: {
                type: "int32", name: "request-channels",
                value: 1, constraints: "any", unit: ""
            },
            11: {
                type: "float32", name: "gain-db",
                value: 0.0, constraints: "decibel", unit: "dB"
            }
        })
    }, pointerRules: {accepts: [Pointers.Capture], mandatory: true}
}

export const CaptureMidiBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "CaptureMidiBox",
        fields: mergeFields(CaptureAttributes, {
            10: {type: "int32", name: "channel", value: -1, constraints: "any", unit: ""} // -1 for all channels
        })
    }, pointerRules: {accepts: [Pointers.Capture], mandatory: true}
}
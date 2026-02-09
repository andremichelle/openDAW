import {Pointers} from "@moises-ai/studio-enums"
import {ClassSchema, deprecated} from "@opendaw/lib-box-forge"

export const ClipTriggerFields = {
    name: "ClipPlaybackFields", // cannot change
    fields: {
        1: {type: "boolean", name: "loop", value: true},
        2: {type: "boolean", name: "reverse"},
        3: {type: "boolean", name: "mute", deprecated}, // TODO Remove
        4: {type: "int32", name: "speed", constraints: "non-negative", unit: ""},
        5: {type: "int32", name: "quantise", constraints: "non-negative", unit: ""},
        6: {type: "int32", name: "trigger", constraints: "non-negative", unit: ""}
    }
} satisfies ClassSchema<Pointers>
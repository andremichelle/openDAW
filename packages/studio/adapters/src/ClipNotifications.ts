import {UUID} from "@moises-ai/lib-std"

export type ClipSequencingUpdates = {
    started: ReadonlyArray<UUID.Bytes>
    stopped: ReadonlyArray<UUID.Bytes>
    obsolete: ReadonlyArray<UUID.Bytes> // were scheduled but never started
}

export type ClipNotification = {
    type: "sequencing"
    changes: ClipSequencingUpdates
} | {
    type: "waiting"
    clips: ReadonlyArray<UUID.Bytes>
}
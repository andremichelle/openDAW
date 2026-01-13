import {Schema} from "@moises-ai/lib-std"

export const EngineStateSchema = Schema.createBuilder({
    position: Schema.float,
    bpm: Schema.float,
    playbackTimestamp: Schema.float,
    countInBeatsRemaining: Schema.float,
    isPlaying: Schema.bool,
    isCountingIn: Schema.bool,
    isRecording: Schema.bool
})

export type EngineState = ReturnType<typeof EngineStateSchema>["object"]
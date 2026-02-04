import {Schema} from "@opendaw/lib-std"

// Ring buffer size: ~1 second at 48kHz = 375 blocks, use 512 (power of 2)
export const PERF_BUFFER_SIZE = 512

export const EngineStateSchema = Schema.createBuilder({
    position: Schema.float,
    bpm: Schema.float,
    playbackTimestamp: Schema.float,
    countInBeatsRemaining: Schema.float,
    isPlaying: Schema.bool,
    isCountingIn: Schema.bool,
    isRecording: Schema.bool,
    perfIndex: Schema.int32,
    perfBuffer: Schema.floats(PERF_BUFFER_SIZE)
})

export type EngineState = ReturnType<typeof EngineStateSchema>["object"]
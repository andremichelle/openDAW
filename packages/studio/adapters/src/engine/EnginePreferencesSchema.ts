import {z} from "zod"

const _BeatSubDivisionOptions = [1, 2, 4, 8] as const
const _RecordingCountInBars = [1, 2, 3, 4, 5, 6, 7, 8] as const

export const EngineSettingsSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union(_BeatSubDivisionOptions.map(value => z.literal(value))),
        gain: z.number().min(Number.NEGATIVE_INFINITY).max(0)
    }).default({
        enabled: false,
        beatSubDivision: 1,
        gain: -6.0
    }),
    playback: z.object({
        timestampEnabled: z.boolean(),
        pauseOnLoopDisabled: z.boolean(),
        truncateNotesAtRegionEnd: z.boolean()
    }).default({
        timestampEnabled: true,
        pauseOnLoopDisabled: false,
        truncateNotesAtRegionEnd: false
    }),
    recording: z.object({
        countInBars: z.union(_RecordingCountInBars.map(value => z.literal(value))),
        allowTakes: z.boolean()
    }).default({
        countInBars: 1,
        allowTakes: true
    })
})

export type EngineSettings = z.infer<typeof EngineSettingsSchema>

export namespace EngineSettings {
    export const BeatSubDivisionOptions = _BeatSubDivisionOptions
    export const RecordingCountInBars = _RecordingCountInBars
}
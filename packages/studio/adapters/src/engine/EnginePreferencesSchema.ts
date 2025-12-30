import {z} from "zod"

const _BeatSubDivisionOptions = [1, 2, 4, 8] as const
const _RecordingCountInBars = [1, 2, 3, 4, 5, 6, 7, 8] as const

export const EngineSettingsSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union(_BeatSubDivisionOptions.map(value => z.literal(value))),
        gain: z.number().min(0).max(1)
    }).default({enabled: false, beatSubDivision: 1, gain: 0.5}),
    playback: z.object({
        timestampEnabled: z.boolean()
    }).default({timestampEnabled: true}),
    recording: z.object({
        countInBars: z.union(_RecordingCountInBars.map(value => z.literal(value)))
    }).default({countInBars: 1})
})

export type EngineSettings = z.infer<typeof EngineSettingsSchema>

export namespace EngineSettings {
    export const BeatSubDivisionOptions = _BeatSubDivisionOptions
    export const RecordingCountInBars = _RecordingCountInBars
}
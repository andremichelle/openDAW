import {z} from "zod"

export const BeatSubDivisionOptions = [2, 4, 8] as const

export const EngineSettingsSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union(BeatSubDivisionOptions.map(value => z.literal(value))),
        gain: z.number().min(0).max(1)
    }).default({enabled: false, beatSubDivision: 4, gain: 0.5})
})

export type EngineSettings = z.infer<typeof EngineSettingsSchema>
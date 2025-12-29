import {z} from "zod"
import {Observer, PathTuple, Subscription, ValueAtPath} from "@opendaw/lib-std"

export const BeatSubDivisionOptions = [2, 4, 8] as const

export const EngineSettingsSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union(BeatSubDivisionOptions.map(value => z.literal(value))),
        gain: z.number().min(0).max(1)
    }).default({enabled: true, beatSubDivision: 4, gain: 0.5})
})

export type EngineSettings = z.infer<typeof EngineSettingsSchema>

export interface EnginePreferences {
    settings(): EngineSettings
    subscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription
    catchupAndSubscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription
}
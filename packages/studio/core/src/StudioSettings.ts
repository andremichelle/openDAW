import {z} from "zod"

export const FpsOptions = [24, 25, 29.97, 30] as const

export const StudioSettingsSchema = z.object({
    "visible-help-hints": z.boolean().default(true),
    "enable-history-buttons": z.boolean().default(navigator.maxTouchPoints > 0),
    "note-audition-while-editing": z.boolean().default(true),
    "modifying-controls-wheel": z.boolean().default(false),
    "auto-open-clips": z.boolean().default(true),
    "auto-create-output-compressor": z.boolean().default(true),
    "footer-show-fps-meter": z.boolean().default(false),
    "footer-show-build-infos": z.boolean().default(false),
    "normalize-mouse-wheel": z.boolean().default(false),
    "time-display": z.object({
        "musical": z.boolean(),
        "absolute": z.boolean(),
        "details": z.boolean(),
        "fps": z.union(FpsOptions.map(value => z.literal(value)))
    }).default({musical: true, absolute: false, details: false, fps: 25}),
    "dragging-use-pointer-lock": z.boolean().default(false),
    "enable-beta-features": z.boolean().default(false)
})

export type StudioSettings = z.infer<typeof StudioSettingsSchema>
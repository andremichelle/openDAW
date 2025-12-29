import {z} from "zod"
import {isDefined, tryCatch} from "@opendaw/lib-std"
import {PreferencesHost} from "@opendaw/lib-fusion"

export const FpsOptions = [24, 25, 29.97, 30] as const

export const StudioSettingsSchema = z.object({
    "visible-help-hints": z.boolean().default(true),
    "enable-history-buttons": z.boolean().default(false),
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
        "fps": z.union(FpsOptions.map(v => z.literal(v)))
    }).default({musical: true, absolute: false, details: false, fps: 25}),
    "dragging-use-pointer-lock": z.boolean().default(false),
    "enable-beta-features": z.boolean().default(false)
})

export type StudioSettings = z.infer<typeof StudioSettingsSchema>

const STORAGE_KEY = "preferences"

const loadFromStorage = (): StudioSettings => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isDefined(stored)) {
        const {status, value} = tryCatch(() => JSON.parse(stored))
        if (status === "success") {
            return StudioSettingsSchema.parse(value)
        }
    }
    return StudioSettingsSchema.parse({})
}

const host = new PreferencesHost<StudioSettings>(loadFromStorage())

host.subscribeAll(() => {
    tryCatch(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(host.settings)))
})

export const StudioPreferences = {
    get values(): StudioSettings {return host.settings},
    catchupAndSubscribe: host.catchupAndSubscribe.bind(host)
}

/** @deprecated Use StudioPreferences instead */
export const Preferences = StudioPreferences

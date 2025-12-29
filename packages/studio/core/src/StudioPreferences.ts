import {isDefined, tryCatch} from "@opendaw/lib-std"
import {PreferencesHost} from "@opendaw/lib-fusion"
import {StudioSettings, StudioSettingsSchema} from "./StudioSettings"

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

export const StudioPreferences = new PreferencesHost<StudioSettings>(loadFromStorage())

StudioPreferences.subscribeAll(() =>
    tryCatch(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(StudioPreferences.settings))))
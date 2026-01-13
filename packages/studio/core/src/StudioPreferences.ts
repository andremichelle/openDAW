import {Preferences} from "@moises-ai/lib-fusion"
import {StudioSettingsSchema} from "./StudioSettings"

export const StudioPreferences = Preferences.host("preferences", StudioSettingsSchema)
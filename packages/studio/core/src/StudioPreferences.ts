import {Preferences} from "@opendaw/lib-fusion"
import {StudioSettingsSchema} from "./StudioSettings"

export const StudioPreferences = Preferences.host("preferences", StudioSettingsSchema)
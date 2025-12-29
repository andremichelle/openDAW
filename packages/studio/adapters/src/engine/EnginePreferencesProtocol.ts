import {EnginePreferences} from "./EnginePreferencesSchema"

export interface EnginePreferencesProtocol {
    updatePreferences(preferences: EnginePreferences): void
}

import {EngineSettings} from "./EnginePreferencesSchema"

export interface EnginePreferencesProtocol {
    updatePreferences(preferences: EngineSettings): void
}
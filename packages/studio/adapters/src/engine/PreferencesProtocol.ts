export interface PreferencesProtocol<SETTINGS> {
    updateSettings(settings: SETTINGS): void
}
import {Sample, Soundfont} from "@opendaw/studio-adapters"
import {PresetMeta} from "./presets"

// Source of the "stock"/factory catalogs (samples, soundfonts, presets).
// The concrete implementation lives in the openDAW app and talks to the
// openDAW servers, so it is injected here instead of referenced directly.
// A standalone SDK consumer that never installs a provider stays local-only.
export namespace FactoryCatalog {
    export interface Provider {
        samples(): Promise<ReadonlyArray<Sample>>
        soundfonts(): Promise<ReadonlyArray<Soundfont>>
        presets(): Promise<ReadonlyArray<PresetMeta>>
    }
    const Empty: Provider = {
        samples: async () => [],
        soundfonts: async () => [],
        presets: async () => []
    }
    let current: Provider = Empty
    export const install = (provider: Provider): void => {current = provider}
    export const get = (): Provider => current
}

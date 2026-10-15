import {panic} from "@opendaw/lib-std"

// The web app always reaches the openDAW servers. A host without them (the desktop app) disables the cloud
// before boot: catalogues are empty at once and remote loads fail fast instead of retrying.
export namespace OpenDAWCloud {
    const state = {available: true}

    export const disable = (): void => {state.available = false}
    export const isAvailable = (): boolean => state.available
    export const unavailable = (resource: string): never => panic(`${resource} is not available without the openDAW cloud`)
}

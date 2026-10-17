import {panic} from "@opendaw/lib-std"

// The web app always reaches the openDAW servers. A host that follows the network (the desktop app) has no cloud
// while the computer is offline: catalogues are empty and remote loads fail at once. Only a fetched index is kept,
// so back online every catalogue is fetched on its next use.
export namespace OpenDAWCloud {
    const state = {followsNetwork: false}

    export const followNetwork = (): void => {state.followsNetwork = true}
    export const followsNetwork = (): boolean => state.followsNetwork
    export const isAvailable = (): boolean => !state.followsNetwork || navigator.onLine
    export const unavailable = (resource: string): never => panic(`${resource} is not available without the openDAW cloud`)
}

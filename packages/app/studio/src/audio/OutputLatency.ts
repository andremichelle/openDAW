import {Option, Provider} from "@opendaw/lib-std"

// The output latency to show. A host whose engine does not play through this AudioContext (the desktop app's native
// engine) installs its own measurement.
export namespace OutputLatency {
    const state: { provider: Option<Provider<number>> } = {provider: Option.None}

    export const install = (provider: Provider<number>): void => {state.provider = Option.wrap(provider)}
    export const of = (context: AudioContext): number => state.provider.mapOr(provider => provider(), context.outputLatency)
}

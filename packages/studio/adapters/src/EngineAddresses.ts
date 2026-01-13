import {Address} from "@moises-ai/lib-box"
import {UUID} from "@moises-ai/lib-std"

export namespace EngineAddresses {
    export const PEAKS = Address.compose(UUID.Lowest).append(0)
    export const SPECTRUM = Address.compose(UUID.Lowest).append(1)
    export const WAVEFORM = Address.compose(UUID.Lowest).append(2)
}
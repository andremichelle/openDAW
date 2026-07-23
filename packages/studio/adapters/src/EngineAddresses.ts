import {Address} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"

export namespace EngineAddresses {
    export const PEAKS = Address.compose(UUID.Lowest).append(0)
    export const SPECTRUM = Address.compose(UUID.Lowest).append(1)
    export const WAVEFORM = Address.compose(UUID.Lowest).append(2)
    export const STEREO = Address.compose(UUID.Lowest).append(3)
    export const GONIO = Address.compose(UUID.Lowest).append(4)
    export const LOUDNESS = Address.compose(UUID.Lowest).append(5)
}
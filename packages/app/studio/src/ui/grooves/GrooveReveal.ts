import {MutableObservableOption, UUID} from "@opendaw/lib-std"

export namespace GrooveReveal {
    export const requested = new MutableObservableOption<UUID.Bytes>()

    export const request = (uuid: UUID.Bytes): void => requested.wrap(uuid)
}

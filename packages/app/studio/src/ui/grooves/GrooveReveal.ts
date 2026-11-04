import {MutableObservableOption, UUID} from "@opendaw/lib-std"

// A groove someone wants to look at: the service brings up the Grooves tab, the list scrolls to the row and clears it
export namespace GrooveReveal {
    export const requested = new MutableObservableOption<UUID.Bytes>()

    export const request = (uuid: UUID.Bytes): void => requested.wrap(uuid)
}

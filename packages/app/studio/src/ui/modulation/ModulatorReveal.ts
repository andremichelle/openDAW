import {MutableObservableOption, UUID} from "@opendaw/lib-std"

/// A modulator that just came into existence somewhere else in the studio and wants to be looked at: the
/// service brings up the screen, the panel scrolls to the row and clears it.
export namespace ModulatorReveal {
    export const requested = new MutableObservableOption<UUID.Bytes>()

    export const request = (uuid: UUID.Bytes): void => requested.wrap(uuid)
}

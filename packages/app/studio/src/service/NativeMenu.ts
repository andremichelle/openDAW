import {Option, Procedure} from "@opendaw/lib-std"
import type {StudioService} from "@/service/StudioService"

// A host with a native menu bar (the desktop app) replaces the in-page studio menu
export namespace NativeMenu {
    const state: { host: Option<Procedure<StudioService>> } = {host: Option.None}

    export const install = (host: Procedure<StudioService>): void => {state.host = Option.wrap(host)}
    export const isActive = (): boolean => state.host.nonEmpty()
    export const attach = (service: StudioService): void => state.host.ifSome(host => host(service))
}

import {Exec, Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {ResourceSelection} from "@/ui/browse/ResourceSelection"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioSignal} from "@/service/StudioSignal"
import {ResourceHeader} from "@/ui/browse/ResourceHeader"

export type ResourceBrowserConfig<T> = {
    name: string
    fetchOnline: () => Promise<ReadonlyArray<T>>
    fetchLocal: () => Promise<ReadonlyArray<T>>
    renderEntry: (props: {
        lifecycle: Lifecycle
        service: StudioService
        selection: ResourceSelection
        item: T
        location: AssetLocation
        refresh: Exec
    }) => HTMLElement
    resolveEntryName: (entry: T) => string
    createSelection: (service: StudioService, htmlSelection: HTMLSelection) => ResourceSelection
    importSignal: StudioSignal["type"]
    headers: ReadonlyArray<ResourceHeader>
    footer?: (props: { lifecycle: Lifecycle, service: StudioService }) => HTMLElement | null
    onReload?: Exec
    onTerminate?: Exec
}
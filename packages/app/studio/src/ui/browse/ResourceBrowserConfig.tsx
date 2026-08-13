import {Exec, Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService"
import {ResourceSelection} from "@/ui/browse/ResourceSelection"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioSignal} from "@/service/StudioSignal"
import {ResourceHeader} from "@/ui/browse/ResourceHeader"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"

export type ResourceBrowserConfig<T> = {
    name: string
    fetchOnline: () => Promise<ResourceFolder<T>>
    fetchLocal: () => Promise<ReadonlyArray<T>>
    expandedKeys?: Set<string>
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
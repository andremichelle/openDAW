import {Exec, Lifecycle, Option, UUID} from "@opendaw/lib-std"
import {AnyDragData} from "@/ui/AnyDragData"
import {StudioService} from "@/service/StudioService"
import {ResourceSelection} from "@/ui/browse/ResourceSelection"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {StudioSignal} from "@/service/StudioSignal"
import {ResourceHeader} from "@/ui/browse/ResourceHeader"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"
import {LocalTree} from "@/ui/browse/LocalTree"

export type ResourceBrowserConfig<T> = {
    name: string
    fetchOnline: () => Promise<ResourceFolder<T>>
    fetchLocal: () => Promise<ReadonlyArray<T>>
    fetchLocalTree?: () => Promise<LocalTree<T>>
    expandedKeys?: Set<string>
    dragType: AnyDragData["type"]
    renderEntry: (props: {
        lifecycle: Lifecycle
        service: StudioService
        selection: ResourceSelection<T>
        item: T
        location: AssetLocation
        tree: Option<LocalTree<T>>
        refresh: Exec
    }) => HTMLElement
    resolveEntryName: (entry: T) => string
    resolveEntryUuid: (entry: T) => UUID.String
    createSelection: (service: StudioService, htmlSelection: HTMLSelection) => ResourceSelection<T>
    importSignal: StudioSignal["type"]
    headers: ReadonlyArray<ResourceHeader>
    footer?: (props: { lifecycle: Lifecycle, service: StudioService }) => HTMLElement | null
    onReload?: Exec
    onTerminate?: Exec
}
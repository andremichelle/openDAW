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
    // Reads the folder structure that groups the local items. Loaded on every reload, so a change made in
    // another tab shows up here. Without it the local list stays flat.
    fetchLocalTree?: () => Promise<LocalTree<T>>
    expandedKeys?: Set<string>
    // Which drag payload this browser accepts when moving items between its folders. Two open browsers must
    // not accept each other's rows.
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
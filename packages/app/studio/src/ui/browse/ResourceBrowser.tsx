import {
    Arrays,
    DefaultObservableValue,
    Func,
    isDefined,
    Lifecycle,
    MutableObservableOption,
    Option,
    Optional,
    Predicate,
    RuntimeSignal,
    StringComparator,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Await, createElement, Hotspot, HotspotUpdater, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu, ProjectSignals} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService.ts"
import {ThreeDots} from "@/ui/spinner/ThreeDots.tsx"
import {SearchInput} from "@/ui/components/SearchInput"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Icon} from "@/ui/components/Icon"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {HTMLSelection} from "@/ui/HTMLSelection"
import {ResourceBrowserConfig} from "@/ui/browse/ResourceBrowserConfig"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"
import {ResourceFolderItem} from "@/ui/browse/ResourceFolderItem"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {LocalTree} from "@/ui/browse/LocalTree"
import {ResourceMenus} from "@/ui/browse/ResourceMenus"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"

type Construct<T> = {
    lifecycle: Lifecycle
    service: StudioService
    config: ResourceBrowserConfig<T>
    className: string
    background?: boolean
    fontSize?: string
    location: DefaultObservableValue<AssetLocation>
}

type Loaded<T> = { root: ResourceFolder<T>, tree: Option<LocalTree<T>> }

const dragUuid = (data: AnyDragData): Optional<UUID.String> =>
    data.type === "sample" ? data.sample.uuid : data.type === "soundfont" ? data.soundfont.uuid : undefined

export const ResourceBrowser = <T, >({
                                         lifecycle,
                                         service,
                                         config,
                                         className,
                                         background,
                                         fontSize,
                                         location
                                     }: Construct<T>) => {
    const entries: HTMLElement = (
        <div className="scrollable" onConnect={scrollable => lifecycle.own(installScrollbars(scrollable))}/>
    )
    const selection = lifecycle.own(new HTMLSelection(entries))
    const resourceSelection = config.createSelection(service, selection)
    const loaded = new MutableObservableOption<LocalTree<T>>()
    const deleteSelection = async (): Promise<void> => {
        const selected = resourceSelection.selected()
        if (selected.length === 0) {return}
        const uuidOf = config.resolveEntryUuid
        return loaded.match({
            none: async () => {await resourceSelection.deleteItems(selected)},
            some: async local => {
                const trashed = selected.filter(item => local.isTrashed(uuidOf(item)))
                const remaining = selected.filter(item => !local.isTrashed(uuidOf(item)))
                if (remaining.length > 0) {await local.trash(remaining.map(uuidOf))}
                if (trashed.length > 0) {
                    await local.forget((await resourceSelection.deleteItems(trashed)).map(uuidOf))
                }
            }
        })
    }
    const expandedKeys = config.expandedKeys ?? new Set<string>()
    const entriesLifeSpan = lifecycle.own(new Terminator())
    const reload = Inject.ref<HotspotUpdater>()
    const filter = new DefaultObservableValue("")
    const searchInput: HTMLElement = <SearchInput lifecycle={lifecycle} model={filter} style={{gridColumn: "1 / -1"}}/>
    const element: Element = (
        <div className={Html.buildClassList(className, background && "background")} tabIndex={-1} style={{fontSize}}>
            <div className="filter">
                <RadioGroup lifecycle={lifecycle} model={location} elements={[
                    {
                        value: AssetLocation.OpenDAW,
                        element: <Icon symbol={IconSymbol.CloudFolder}/>,
                        tooltip: `Online ${config.name.toLowerCase()}`
                    },
                    {
                        value: AssetLocation.Local,
                        element: <Icon symbol={IconSymbol.UserFolder}/>,
                        tooltip: `Locally stored ${config.name.toLowerCase()}`
                    }
                ]} appearance={{framed: true, landscape: true}}/>
                {searchInput}
            </div>
            <header>
                {config.headers.map(header => (
                    <span className={header.align === "right" ? "right" : undefined}>
                        {header.label}
                    </span>
                ))}
            </header>
            <div className="content">
                <Hotspot ref={reload} render={() => {
                    config.onReload?.()
                    entriesLifeSpan.terminate()
                    return (
                        <Await
                            factory={async (): Promise<Loaded<T>> => {
                                loaded.clear()
                                if (location.getValue() !== AssetLocation.Local) {
                                    return {root: await config.fetchOnline(), tree: Option.None}
                                }
                                const items = await config.fetchLocal()
                                const fetchLocalTree = config.fetchLocalTree
                                if (!isDefined(fetchLocalTree)) {
                                    return {root: {name: "", folders: [], items}, tree: Option.None}
                                }
                                const tree = await fetchLocalTree()
                                loaded.wrap(tree)
                                return {root: tree.assemble(items, config.resolveEntryName), tree: Option.wrap(tree)}
                            }}
                            loading={() => (<div><ThreeDots/></div>)}
                            failure={({reason, retry}) => (
                                <div className="error" onclick={retry}>
                                    {reason instanceof DOMException ? reason.name : String(reason)}
                                </div>
                            )}
                            success={({root, tree}) => {
                                const refresh = () => reload.get().update()
                                // The whole selection when the dragged row belongs to it, that row otherwise.
                                const draggedUuids = (data: AnyDragData): ReadonlyArray<UUID.String> => {
                                    const uuid = dragUuid(data)
                                    if (!isDefined(uuid)) {return Arrays.empty()}
                                    const selected = resourceSelection.selected().map(config.resolveEntryUuid)
                                    return selected.includes(uuid) ? selected : [uuid]
                                }
                                const installDropTarget = (target: HTMLElement,
                                                           accepts: Predicate<ReadonlyArray<UUID.String>>,
                                                           apply: Func<ReadonlyArray<UUID.String>, Promise<void>>,
                                                           within: Predicate<DragEvent> = () => true): Terminable =>
                                    DragAndDrop.installTarget(target, {
                                        drag: (event, data) => data.type === config.dragType
                                            && within(event) && accepts(draggedUuids(data)),
                                        drop: (event, data) => {
                                            event.stopPropagation()
                                            target.classList.remove("drag-over")
                                            apply(draggedUuids(data)).then(refresh)
                                        },
                                        enter: allowDrop => {
                                            if (allowDrop) {target.classList.add("drag-over")}
                                        },
                                        leave: () => target.classList.remove("drag-over")
                                    })
                                const renderEntry = (item: T) => config.renderEntry({
                                    lifecycle: entriesLifeSpan,
                                    service,
                                    selection: resourceSelection,
                                    item,
                                    location: location.getValue(),
                                    tree,
                                    refresh
                                })
                                const renderContent = (folder: ResourceFolder<T>, path: string, depth: number): Array<HTMLElement> => [
                                    ...folder.folders.map(sub => {
                                        const subPath = LocalTree.path(path, sub.name)
                                        return ResourceFolderItem({
                                            label: sub.name,
                                            count: ResourceFolder.countItems(sub),
                                            depth,
                                            expandKey: subPath,
                                            expandedKeys,
                                            entries: renderContent(sub, subPath, depth + 1),
                                            install: tree.mapOr(local => (header: HTMLElement) =>
                                                entriesLifeSpan.ownAll(
                                                    subPath === LocalTree.TrashName
                                                        ? installDropTarget(header,
                                                            uuids => uuids.some(uuid => !local.isTrashed(uuid)),
                                                            uuids => local.trash(uuids))
                                                        : installDropTarget(header,
                                                            uuids => uuids.some(uuid => local.isTrashed(uuid)
                                                                || local.pathOf(uuid) !== subPath),
                                                            uuids => local.move(uuids, subPath)),
                                                    ContextMenu.subscribe(header, collector => collector.addItems(
                                                        ...(subPath === LocalTree.TrashName
                                                            ? ResourceMenus.trashFolder(local, resourceSelection,
                                                                sub.items, config.resolveEntryUuid, refresh)
                                                            : ResourceMenus.folder(local, subPath,
                                                                ResourceFolder.countItems(sub), refresh))))
                                                ), undefined)
                                        })
                                    }),
                                    ...folder.items.map(renderEntry)
                                ]
                                const renderSearch = (query: string): Array<HTMLElement> => ResourceFolder.flatten(root)
                                    .filter(item => tree.mapOr(
                                        local => !local.isTrashed(config.resolveEntryUuid(item)), true))
                                    .filter(item => config.resolveEntryName(item).toLowerCase().includes(query))
                                    .toSorted((a, b) => StringComparator(config.resolveEntryName(a).toLowerCase(), config.resolveEntryName(b).toLowerCase()))
                                    .map(renderEntry)
                                const update = () => {
                                    entriesLifeSpan.terminate()
                                    selection.clear()
                                    // Reinstalled here because `entriesLifeSpan` dies on every update.
                                    tree.ifSome(local => entriesLifeSpan.ownAll(
                                        installDropTarget(entries,
                                            uuids => uuids.some(uuid => local.isTrashed(uuid)
                                                || local.pathOf(uuid).length > 0),
                                            uuids => local.move(uuids, ""),
                                            event => !(event.target instanceof Element)
                                                || !isDefined(event.target.closest("[data-selection], .folder-header"))),
                                        ContextMenu.subscribe(entries, collector =>
                                            collector.addItems(...ResourceMenus.background(local, refresh)))
                                    ))
                                    const query = filter.getValue().toLowerCase()
                                    replaceChildren(entries, query.length === 0
                                        ? renderContent(root, "", 0)
                                        : renderSearch(query))
                                }
                                const debounceSetLocation = Runtime.debounce(() => {
                                    location.setValue(AssetLocation.Local)
                                    reload.get().update()
                                }, 500)
                                lifecycle.own(filter.catchupAndSubscribe(update))
                                lifecycle.own(service.subscribeSignal(debounceSetLocation, config.importSignal))
                                searchInput.focus()
                                return entries
                            }}/>
                    )
                }}>
                </Hotspot>
            </div>
            {config.footer?.({lifecycle, service})}
        </div>
    )
    lifecycle.ownAll(
        location.subscribe(() => reload.get().update()),
        RuntimeSignal.subscribe(signal => signal === ProjectSignals.StorageUpdated && reload.get().update()),
        {terminate: () => config.onTerminate?.()},
        Events.subscribe(element, "keydown", async event => {
            if (Events.isTextInput(event.target)) {return}
            if (Keyboard.isDelete(event) && location.getValue() === AssetLocation.Local) {
                await deleteSelection()
                reload.get().update()
            }
        })
    )
    return element
}
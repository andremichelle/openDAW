import {
    Arrays,
    DefaultObservableValue,
    EmptyExec,
    EmptyProcedure,
    Func,
    isDefined,
    Lifecycle,
    MutableObservableOption,
    Nullable,
    Option,
    Optional,
    panic,
    Predicate,
    Procedure,
    RuntimeSignal,
    StringComparator,
    Strings,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Await, createElement, Hotspot, HotspotUpdater, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Promises, Runtime} from "@opendaw/lib-runtime"
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
import {FolderImport} from "@/ui/browse/FolderImport"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData, DragFile} from "@/ui/AnyDragData"
import {Surface} from "@/ui/surface/Surface"

const TrashRejectsFiles = "Files cannot be dropped into the Trash"

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
    const renderLifeSpan = lifecycle.own(new Terminator())
    const reload = Inject.ref<HotspotUpdater>()
    const filter = new DefaultObservableValue("")
    const importing = new DefaultObservableValue(false)
    const debounceSetLocation = Runtime.debounce(() => {
        location.setValue(AssetLocation.Local)
        reload.get().update()
    }, 500)
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
                    renderLifeSpan.terminate()
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
                                const importInto = async (local: LocalTree<T>,
                                                          sources: ReadonlyArray<FolderImport.Entry>,
                                                          path: string): Promise<void> => {
                                    if (sources.length === 0) {return}
                                    importing.setValue(true)
                                    const folders = FolderImport.byFolder(sources)
                                    const result = await Promises.tryCatch(
                                        config.importGroups(folders.map(([, files]) => files)))
                                    if (result.status === "rejected") {
                                        importing.setValue(false)
                                        return panic(result.error)
                                    }
                                    // identical audio is one item, it stays in the first folder it is found in
                                    const placed = new Set<UUID.String>()
                                    for (const [index, [folder]] of folders.entries()) {
                                        const uuids = (result.value[index] ?? Arrays.empty())
                                            .map(config.resolveEntryUuid)
                                            .filter(uuid => !placed.has(uuid))
                                        uuids.forEach(uuid => placed.add(uuid))
                                        await local.move(uuids, folder.length === 0 ? path : LocalTree.importPath(path, folder))
                                    }
                                    importing.setValue(false)
                                    if (placed.size === 0) {
                                        Surface.get(entries).toast(`No ${config.name.toLowerCase()} found`, IconSymbol.Warning)
                                    }
                                }
                                const importDropped = async (local: LocalTree<T>,
                                                             {files, entries: dropped}: DragFile,
                                                             path: string): Promise<void> => {
                                    if (!FolderImport.hasFolder(dropped)) {
                                        return importInto(local, files.map(file => ({file, folder: ""})), path)
                                    }
                                    const read = await Promises.tryCatch(FolderImport.fromEntries(dropped))
                                    if (read.status === "rejected") {
                                        Surface.get(entries).toast("The dropped folder could not be read", IconSymbol.Warning)
                                        return
                                    }
                                    if (!await approveFolder(read.value)) {return}
                                    return importInto(local, read.value, path)
                                }
                                const approveFolder = async (sources: ReadonlyArray<FolderImport.Entry>): Promise<boolean> => {
                                    const estimate = await config.estimateImport(sources.map(({file}) => file))
                                    return estimate.count === 0 || FolderImport.approve(estimate, config.name)
                                }
                                const importPicked = async (local: LocalTree<T>, path: string): Promise<void> => {
                                    const sources = await FolderImport.pick()
                                    if (sources.length > 0 && !await approveFolder(sources)) {return}
                                    await importInto(local, sources, path)
                                    refresh()
                                }
                                const installDropTarget = (target: HTMLElement, {accepts, apply, importTo, within = () => true}: {
                                    accepts: Predicate<ReadonlyArray<UUID.String>>
                                    apply: Func<ReadonlyArray<UUID.String>, Promise<void>>
                                    importTo: Option<Func<DragFile, Promise<void>>>
                                    within?: Predicate<DragEvent>
                                }): Terminable => {
                                    const clear = () => target.classList.remove("drag-over")
                                    return Terminable.many(
                                        DragAndDrop.installTarget(target, {
                                            drag: (event, data) => data.type === "file"
                                                ? importTo.nonEmpty()
                                                : within(event) && data.type === config.dragType && accepts(draggedUuids(data)),
                                            drop: (event, data) => {
                                                event.stopPropagation()
                                                clear()
                                                if (data.type === "file") {
                                                    importTo.ifSome(importer => importer(data).then(refresh))
                                                } else {
                                                    apply(draggedUuids(data)).then(refresh)
                                                }
                                            },
                                            enter: allowDrop => {
                                                if (allowDrop) {target.classList.add("drag-over")}
                                            },
                                            leave: clear
                                        }),
                                        // dragend fires on the source, so a canceled drag never reaches
                                        // `leave` and the highlight would stay behind.
                                        Events.subscribe(window, "dragend", clear, {capture: true}),
                                        Events.subscribe(window, "drop", clear, {capture: true})
                                    )
                                }
                                const rejectFiles = (target: HTMLElement, message: string, icon: IconSymbol): Terminable =>
                                    DragAndDrop.installTarget(target, {
                                        drag: (_event, data) => data.type === "file",
                                        drop: event => {
                                            event.stopPropagation()
                                            Surface.get(target).toast(message, icon)
                                        },
                                        enter: EmptyProcedure,
                                        leave: EmptyExec
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
                                const installTrash = (local: LocalTree<T>,
                                                      folder: ResourceFolder<T>): Procedure<HTMLElement> =>
                                    header => entriesLifeSpan.ownAll(
                                        installDropTarget(header, {
                                            accepts: uuids => uuids.some(uuid => !local.isTrashed(uuid)),
                                            apply: uuids => local.trash(uuids),
                                            importTo: Option.None
                                        }),
                                        rejectFiles(header, TrashRejectsFiles, IconSymbol.Warning),
                                        ContextMenu.subscribe(header, collector =>
                                            collector.addItems(...ResourceMenus.trashFolder(
                                                local, resourceSelection, folder.items, config.resolveEntryUuid, refresh)))
                                    )
                                const installFolder = (local: LocalTree<T>, path: string): Procedure<HTMLElement> =>
                                    header => entriesLifeSpan.ownAll(
                                        installDropTarget(header, {
                                            accepts: uuids => uuids.some(uuid => local.isTrashed(uuid)
                                                || local.pathOf(uuid) !== path),
                                            apply: uuids => local.move(uuids, path),
                                            importTo: Option.wrap(data => importDropped(local, data, path))
                                        }),
                                        ContextMenu.subscribe(header, collector =>
                                            collector.addItems(...ResourceMenus.folder(local, path, refresh, () => importPicked(local, path))))
                                    )
                                const installEntries = (local: LocalTree<T>, path: string, isTrash: boolean): Procedure<HTMLElement> =>
                                    list => entriesLifeSpan.own(isTrash
                                        ? rejectFiles(list, TrashRejectsFiles, IconSymbol.Warning)
                                        : installDropTarget(list, {
                                            accepts: () => false,
                                            apply: () => Promise.resolve(),
                                            importTo: Option.wrap(data => importDropped(local, data, path))
                                        }))
                                const renderContent = (folder: ResourceFolder<T>, path: string, depth: number): Array<HTMLElement> => [
                                    ...folder.folders.map(sub => {
                                        const subPath = LocalTree.path(path, sub.name)
                                        const isTrash = subPath === LocalTree.TrashName
                                        return ResourceFolderItem({
                                            label: sub.name,
                                            symbols: isTrash ? [IconSymbol.FolderTrash, IconSymbol.FolderTrash] : undefined,
                                            count: ResourceFolder.countItems(sub),
                                            depth,
                                            expandKey: subPath,
                                            expandedKeys,
                                            entries: renderContent(sub, subPath, depth + 1),
                                            // Not `mapOr`: a function fallback would be called as a provider.
                                            install: tree.match<Procedure<HTMLElement>>({
                                                none: () => EmptyProcedure,
                                                some: local => isTrash
                                                    ? installTrash(local, sub)
                                                    : installFolder(local, subPath)
                                            }),
                                            installEntries: tree.match<Procedure<HTMLElement>>({
                                                none: () => EmptyProcedure,
                                                some: local => installEntries(local, subPath, isTrash)
                                            })
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
                                    const isBlank = (element: Nullable<Element>): boolean =>
                                        !isDefined(element) || !isDefined(element.closest("[data-selection], .folder-header"))
                                    tree.match({
                                        none: () => {
                                            entriesLifeSpan.own(rejectFiles(entries,
                                                `${Strings.capitalize(config.name)} can only be stored in the user folder`,
                                                IconSymbol.UserFolder))
                                        },
                                        some: local => entriesLifeSpan.ownAll(
                                            installDropTarget(entries, {
                                                accepts: uuids => uuids.some(uuid => local.isTrashed(uuid)
                                                    || local.pathOf(uuid).length > 0),
                                                apply: uuids => local.move(uuids, ""),
                                                importTo: Option.wrap(data => importDropped(local, data, "")),
                                                within: event => !(event.target instanceof Element) || isBlank(event.target)
                                            }),
                                            ContextMenu.subscribe(entries, collector => {
                                                const {clientX, clientY} = collector.client
                                                if (!isBlank(document.elementFromPoint(clientX, clientY))) {return}
                                                collector.addItems(...ResourceMenus.root(local, refresh, () => importPicked(local, "")))
                                            }))
                                    })
                                    const query = filter.getValue().toLowerCase()
                                    replaceChildren(entries, query.length === 0
                                        ? renderContent(root, "", 0)
                                        : renderSearch(query))
                                }
                                renderLifeSpan.ownAll(
                                    filter.catchupAndSubscribe(update),
                                    service.subscribeSignal(() => {
                                        if (!importing.getValue()) {debounceSetLocation()}
                                    }, config.importSignal))
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
import {DefaultObservableValue, Lifecycle, RuntimeSignal, StringComparator, Terminator} from "@opendaw/lib-std"
import {Await, createElement, Hotspot, HotspotUpdater, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {ProjectSignals} from "@opendaw/studio-core"
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

type Construct<T> = {
    lifecycle: Lifecycle
    service: StudioService
    config: ResourceBrowserConfig<T>
    className: string
    background?: boolean
    fontSize?: string
    location: DefaultObservableValue<AssetLocation>
}

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
                            factory={async (): Promise<ResourceFolder<T>> => location.getValue() === AssetLocation.Local
                                ? {name: "", folders: [], items: await config.fetchLocal()}
                                : config.fetchOnline()}
                            loading={() => (<div><ThreeDots/></div>)}
                            failure={({reason, retry}) => (
                                <div className="error" onclick={retry}>
                                    {reason instanceof DOMException ? reason.name : String(reason)}
                                </div>
                            )}
                            success={(root) => {
                                const renderEntry = (item: T) => config.renderEntry({
                                    lifecycle: entriesLifeSpan,
                                    service,
                                    selection: resourceSelection,
                                    item,
                                    location: location.getValue(),
                                    refresh: () => reload.get().update()
                                })
                                const renderContent = (folder: ResourceFolder<T>, path: string, depth: number): Array<HTMLElement> => [
                                    ...folder.folders.map(sub => {
                                        const expandKey = `${path}/${sub.name}`
                                        return ResourceFolderItem({
                                            label: sub.name,
                                            count: ResourceFolder.countItems(sub),
                                            depth,
                                            expandKey,
                                            expandedKeys,
                                            entries: renderContent(sub, expandKey, depth + 1)
                                        })
                                    }),
                                    ...folder.items.map(renderEntry)
                                ]
                                // A query abandons the structure and searches the whole catalogue, which is what
                                // the flat list did before folders existed.
                                const renderSearch = (query: string): Array<HTMLElement> => ResourceFolder.flatten(root)
                                    .filter(item => config.resolveEntryName(item).toLowerCase().includes(query))
                                    .toSorted((a, b) => StringComparator(config.resolveEntryName(a).toLowerCase(), config.resolveEntryName(b).toLowerCase()))
                                    .map(renderEntry)
                                const update = () => {
                                    entriesLifeSpan.terminate()
                                    selection.clear()
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
                await resourceSelection.deleteSelected()
                reload.get().update()
            }
        })
    )
    return element
}
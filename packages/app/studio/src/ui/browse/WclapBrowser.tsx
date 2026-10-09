import css from "./WclapBrowser.sass?inline"
import {
    Bytes, DefaultObservableValue, EmptyProcedure, Lifecycle, RuntimeNotifier, StringComparator, Terminator
} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu, MenuItem, WclapStorage} from "@opendaw/studio-core"
import {WclapPluginInfo} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {WclapDescriber} from "@/service/WclapDescriber"
import {WclapNames} from "@/service/WclapNames"
import {OpenWclapAPI, WclapIndexFolder} from "@/opendaw-api"
import {AssetLocation} from "@/ui/browse/AssetLocation"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"
import {ResourceFolderItem} from "@/ui/browse/ResourceFolderItem"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Icon} from "@/ui/components/Icon"
import {SearchInput} from "@/ui/components/SearchInput"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {ThreeDots} from "@/ui/spinner/ThreeDots.tsx"

const className = Html.adoptStyleSheet(css, "WclapBrowser")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

type Entry = {
    id: string, name: string, bundle: string, type: string, vendor: string, license: string, size: number, local: boolean
}

const {describe, kindOf, shortKind} = WclapDescriber

const location = new DefaultObservableValue(AssetLocation.OpenDAW)

const toEntries = (id: string, size: number, local: boolean, license: string,
                   plugins: ReadonlyArray<WclapPluginInfo>): ReadonlyArray<Entry> => {
    if (plugins.length === 0) {
        const name = `Unknown bundle ${id.substring(0, 8)}`
        return [{id, size, local, license, name, bundle: name, type: "", vendor: ""}]
    }
    const bundle = plugins.map(({name}) => name).join(", ")
    const shortNames = WclapNames.distinct(plugins.map(({name}) => name))
    return plugins.map((plugin, index) => ({
        id, size, local, license, bundle, name: shortNames[index], type: shortKind(kindOf(plugin)), vendor: plugin.vendor
    }))
}

const expandedKeys = new Set<string>()

const byName = (a: Entry, b: Entry): number => StringComparator(a.name.toLowerCase(), b.name.toLowerCase())

const loadLocal = async (): Promise<ResourceFolder<Entry>> => {
    const [ids, cloud] = await Promise.all([WclapStorage.list(), OpenWclapAPI.get().all()])
    // a bundle imported from disk carries no license we know of, one from the cloud carries the published one
    const licenses = new Map(cloud.map(({uuid, license}) => [uuid, license]))
    const items = await Promise.all(ids.map(async id => {
        const [archive, plugins] = await Promise.all([
            WclapStorage.loadId(id),
            describe(WclapStorage.urlOf(id)).catch(() => [])
        ])
        return toEntries(id, archive.byteLength, true, licenses.get(id) ?? "", plugins)
    }))
    return {name: "", folders: [], items: items.flat().toSorted(byName)}
}

// the published folder tree, in the order the admin tool arranged it
const loadCloud = async (): Promise<ResourceFolder<Entry>> => {
    const toFolder = (folder: WclapIndexFolder): ResourceFolder<Entry> => ({
        name: folder.name,
        folders: folder.folders?.map(toFolder) ?? [],
        items: folder.wclaps?.flatMap(({uuid, size, license, plugins}) => toEntries(uuid, size, false, license, plugins)) ?? []
    })
    return {name: "", folders: (await OpenWclapAPI.get().tree()).folders.map(toFolder), items: []}
}

export const WclapBrowser = ({lifecycle}: Construct) => {
    const entries: HTMLElement = (
        <div className="scrollable" onConnect={scrollable => lifecycle.own(installScrollbars(scrollable))}/>
    )
    const rows = lifecycle.own(new Terminator())
    const filter = new DefaultObservableValue("")
    const loaded: { root: ResourceFolder<Entry> } = {root: {name: "", folders: [], items: []}}
    const remove = async ({id, bundle}: Entry): Promise<void> => {
        const approved = await RuntimeNotifier.approve({
            headline: "Delete WebCLAP Bundle",
            message: `Delete "${bundle}" from this device and from your cloud backup? Projects using it will pass audio through.`,
            approveText: "Delete",
            cancelText: "Cancel"
        })
        if (!approved) {return}
        await WclapStorage.remove(id)
        refresh()
    }
    const renderRow = (entry: Entry): HTMLElement => {
        const element: HTMLElement = (
            <div className="entry">
                <span className="name"><Icon symbol={IconSymbol.WebClap}/>{entry.name}</span>
                <span>{entry.type}</span>
                <span>{entry.vendor}</span>
                <span>{entry.license.length > 0 ? entry.license : "-"}</span>
                <span className="right">{Bytes.toString(entry.size)}</span>
            </div>
        )
        if (entry.local) {
            rows.own(ContextMenu.subscribe(element, collector => collector.addItems(
                MenuItem.header({label: entry.bundle, icon: IconSymbol.WebClap, color: Colors.blue}),
                MenuItem.default({label: "Delete Forever…", icon: IconSymbol.Delete})
                    .setTriggerProcedure(() => remove(entry)))))
        }
        return element
    }
    const renderFolder = (folder: ResourceFolder<Entry>, path: string, depth: number): Array<HTMLElement> => [
        ...folder.folders.map(sub => {
            const subPath = `${path}/${sub.name}`
            return ResourceFolderItem({
                label: sub.name, count: ResourceFolder.countItems(sub), depth, expandKey: subPath, expandedKeys,
                entries: renderFolder(sub, subPath, depth + 1), install: EmptyProcedure
            })
        }),
        ...folder.items.map(renderRow)
    ]
    const render = (): void => {
        rows.terminate()
        const query = filter.getValue().toLowerCase()
        const all = ResourceFolder.flatten(loaded.root)
        if (all.length === 0) {
            replaceChildren(entries, <div className="empty">{location.getValue() === AssetLocation.Local
                ? "No WebCLAP bundles stored. Import one in a WebCLAP device or pick one from the cloud."
                : "No WebCLAP plugins published yet."}</div>)
        } else if (query.length === 0) {
            replaceChildren(entries, renderFolder(loaded.root, "", 0))
        } else {
            replaceChildren(entries, all
                .filter(({bundle, vendor}) => `${bundle} ${vendor}`.toLowerCase().includes(query))
                .toSorted(byName)
                .map(renderRow))
        }
    }
    const loads = {generation: 0}
    const refresh = (): void => {
        const generation = ++loads.generation
        rows.terminate()
        replaceChildren(entries, <div><ThreeDots/></div>)
        const load = location.getValue() === AssetLocation.Local ? loadLocal() : loadCloud()
        load.then(root => {
            if (generation !== loads.generation) {return}
            loaded.root = root
            render()
        }, reason => {
            if (generation !== loads.generation) {return}
            replaceChildren(entries, <div className="error" onclick={refresh}>{String(reason)}</div>)
        })
    }
    lifecycle.ownAll(filter.subscribe(render), location.subscribe(refresh))
    refresh()
    return (
        <div className={className}>
            <div className="filter">
                <RadioGroup lifecycle={lifecycle} model={location} elements={[
                    {value: AssetLocation.OpenDAW, element: <Icon symbol={IconSymbol.CloudFolder}/>, tooltip: "WebCLAP plugins hosted by openDAW"},
                    {value: AssetLocation.Local, element: <Icon symbol={IconSymbol.UserFolder}/>, tooltip: "WebCLAP bundles stored on this device"}
                ]} appearance={{framed: true, landscape: true}}/>
                <SearchInput lifecycle={lifecycle} model={filter} style={{gridColumn: "1 / -1"}}/>
            </div>
            <header>
                <span>Plugins</span>
                <span>Type</span>
                <span>Vendor</span>
                <span>License</span>
                <span className="right">Size</span>
            </header>
            <div className="content">{entries}</div>
        </div>
    )
}

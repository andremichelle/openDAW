import css from "./WclapBrowser.sass?inline"
import {Bytes, DefaultObservableValue, Lifecycle, RuntimeNotifier, StringComparator, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu, MenuItem, WclapBundles, WclapStorage} from "@opendaw/studio-core"
import {createWclapDescriber} from "@opendaw/studio-core-wasm"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {SearchInput} from "@/ui/components/SearchInput"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "WclapBrowser")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

type Entry = { id: string, name: string, vendor: string, size: number }

const describe = createWclapDescriber(WclapBundles.fetch)

const loadEntries = async (): Promise<ReadonlyArray<Entry>> => {
    const ids = await WclapStorage.list()
    const entries = await Promise.all(ids.map(async id => {
        const [archive, plugins] = await Promise.all([
            WclapStorage.loadId(id),
            describe(WclapStorage.urlOf(id)).catch(() => [])
        ])
        return {
            id, size: archive.byteLength,
            name: plugins.length === 0 ? `Unknown bundle ${id.substring(0, 8)}` : plugins.map(({name}) => name).join(", "),
            vendor: plugins.at(0)?.vendor ?? ""
        }
    }))
    return entries.toSorted((a, b) => StringComparator(a.name.toLowerCase(), b.name.toLowerCase()))
}

export const WclapBrowser = ({lifecycle}: Construct) => {
    const entries: HTMLElement = (
        <div className="scrollable" onConnect={scrollable => lifecycle.own(installScrollbars(scrollable))}/>
    )
    const rows = lifecycle.own(new Terminator())
    const filter = new DefaultObservableValue("")
    const loaded: { list: ReadonlyArray<Entry> } = {list: []}
    const remove = async ({id, name}: Entry): Promise<void> => {
        const approved = await RuntimeNotifier.approve({
            headline: "Delete WebCLAP Bundle",
            message: `Delete "${name}" from this device and from your cloud backup? Projects using it will pass audio through.`,
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
                <span>{entry.vendor}</span>
                <span className="right">{Bytes.toString(entry.size)}</span>
            </div>
        )
        rows.own(ContextMenu.subscribe(element, collector => collector.addItems(
            MenuItem.header({label: entry.name, icon: IconSymbol.WebClap, color: Colors.blue}),
            MenuItem.default({label: "Delete Forever…", icon: IconSymbol.Delete})
                .setTriggerProcedure(() => remove(entry)))))
        return element
    }
    const render = (): void => {
        rows.terminate()
        const query = filter.getValue().toLowerCase()
        const visible = loaded.list.filter(({name, vendor}) => `${name} ${vendor}`.toLowerCase().includes(query))
        replaceChildren(entries, loaded.list.length === 0
            ? <div className="empty">No WebCLAP bundles stored. Load one in a WebCLAP device or pick an example.</div>
            : visible.map(renderRow))
    }
    const refresh = (): void => {
        loadEntries().then(list => {
            loaded.list = list
            render()
        }, reason => replaceChildren(entries, <div className="error">{String(reason)}</div>))
    }
    lifecycle.own(filter.subscribe(render))
    refresh()
    return (
        <div className={className}>
            <div className="filter">
                <SearchInput lifecycle={lifecycle} model={filter} style={{gridColumn: "1 / -1"}}/>
            </div>
            <header>
                <span>Plugins</span>
                <span>Vendor</span>
                <span className="right">Size</span>
            </header>
            <div className="content">{entries}</div>
        </div>
    )
}

import css from "./LibraryBrowser.sass?inline"
import {DefaultObservableValue, Lifecycle, Terminator} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "../components/Icon"
import {PresetEntry, PresetMeta, PresetSource} from "./PresetMeta"
import mockStockIndexRaw from "./mocks/mock-stock-index.json"
import mockUserIndexRaw from "./mocks/mock-user-index.json"

const className = Html.adoptStyleSheet(css, "LibraryBrowser")

const mockStockIndex: ReadonlyArray<PresetMeta> = mockStockIndexRaw as ReadonlyArray<PresetMeta>
const mockUserIndex: ReadonlyArray<PresetMeta> = mockUserIndexRaw as ReadonlyArray<PresetMeta>

const tagSource = (list: ReadonlyArray<PresetMeta>, source: PresetSource): ReadonlyArray<PresetEntry> =>
    list.map(meta => ({...meta, source}))

const allPresets: ReadonlyArray<PresetEntry> = [
    ...tagSource(mockStockIndex, "stock"),
    ...tagSource(mockUserIndex, "user")
]

type SourceToggles = {stock: boolean, user: boolean}

type CategoryKey = "instrument" | "audio-effect" | "midi-effect"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const LibraryBrowser = ({lifecycle}: Construct) => {
    const search = new DefaultObservableValue("")
    const toggles = new DefaultObservableValue<SourceToggles>({stock: true, user: true})
    const tree = <div className="tree"/> as HTMLElement
    const render = () => {
        const query = search.getValue().trim().toLowerCase()
        const {stock, user} = toggles.getValue()
        const filterActive = query.length > 0 || !stock || !user
        const matches = (entry: PresetEntry): boolean => {
            if (entry.source === "stock" && !stock) {return false}
            if (entry.source === "user" && !user) {return false}
            if (query.length === 0) {return true}
            return entry.name.toLowerCase().includes(query)
                || entry.device.toLowerCase().includes(query)
        }
        tree.replaceChildren(
            renderCategory({
                label: "Instruments",
                colorVar: "--color-green",
                categoryKey: "instrument",
                compoundLabel: "Racks",
                compoundCategory: "audio-unit",
                stockDevices: Object.entries(InstrumentFactories.Named).map(([key, factory]) => ({
                    key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription
                })),
                matches,
                filterActive
            }),
            renderCategory({
                label: "Audio Effects",
                colorVar: "--color-blue",
                categoryKey: "audio-effect",
                compoundLabel: "Effect Chains",
                compoundCategory: "audio-effect-chain",
                stockDevices: effectDevices(EffectFactories.AudioNamed),
                matches,
                filterActive
            }),
            renderCategory({
                label: "MIDI Effects",
                colorVar: "--color-orange",
                categoryKey: "midi-effect",
                compoundLabel: "Effect Chains",
                compoundCategory: "midi-effect-chain",
                stockDevices: effectDevices(EffectFactories.MidiNamed),
                matches,
                filterActive
            })
        )
    }
    const stockToggle = (
        <button className="source-toggle active" title="Show stock presets">
            <Icon symbol={IconSymbol.CloudFolder}/>
        </button>
    ) as HTMLButtonElement
    const userToggle = (
        <button className="source-toggle active" title="Show user presets">
            <Icon symbol={IconSymbol.UserFolder}/>
        </button>
    ) as HTMLButtonElement
    const applyToggles = (next: SourceToggles) => {
        const safe = !next.stock && !next.user ? {stock: true, user: true} : next
        stockToggle.classList.toggle("active", safe.stock)
        userToggle.classList.toggle("active", safe.user)
        toggles.setValue(safe)
    }
    stockToggle.onclick = () => applyToggles({...toggles.getValue(), stock: !toggles.getValue().stock})
    userToggle.onclick = () => applyToggles({...toggles.getValue(), user: !toggles.getValue().user})
    lifecycle.ownAll(
        search.subscribe(render),
        toggles.subscribe(render),
        lifecycle.own(new Terminator())
    )
    render()
    return (
        <div className={className}>
            <div className="filter-bar">
                <input
                    type="search"
                    className="search"
                    placeholder="Search presets…"
                    oninput={(event: Event) => search.setValue((event.target as HTMLInputElement).value)}/>
                {stockToggle}
                {userToggle}
            </div>
            {tree}
        </div>
    )
}

type StockDeviceMeta = {key: string, name: string, icon: IconSymbol, brief: string}

const effectDevices = (records: Record<string, EffectFactory>): ReadonlyArray<StockDeviceMeta> =>
    Object.entries(records).map(([key, factory]) => ({
        key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription
    }))

type RenderCategoryArgs = {
    label: string
    colorVar: string
    categoryKey: CategoryKey
    compoundLabel: string
    compoundCategory: "audio-unit" | "audio-effect-chain" | "midi-effect-chain"
    stockDevices: ReadonlyArray<StockDeviceMeta>
    matches: (entry: PresetEntry) => boolean
    filterActive: boolean
}

const renderCategory = (args: RenderCategoryArgs): HTMLElement => {
    const {label, colorVar, categoryKey, compoundLabel, compoundCategory, stockDevices, matches, filterActive} = args
    const section = <section className="category" style={{"--color": `var(${colorVar})`}}/> as HTMLElement
    section.appendChild(<h1>{label}</h1>)
    stockDevices.forEach(device => {
        const devicePresets = allPresets
            .filter(entry => entry.category === categoryKey && entry.device === device.key)
            .filter(matches)
        section.appendChild(renderDeviceRow(device, devicePresets, filterActive))
    })
    const compoundPresets = allPresets
        .filter(entry => entry.category === compoundCategory)
        .filter(matches)
    if (!filterActive || compoundPresets.length > 0) {
        section.appendChild(renderCompoundRow(compoundLabel, compoundPresets, filterActive))
    }
    return section
}

const renderDeviceRow = (
    device: StockDeviceMeta,
    presets: ReadonlyArray<PresetEntry>,
    filterActive: boolean
): HTMLElement => {
    const empty = presets.length === 0
    const row = <div className={`device-row ${empty ? "empty" : ""}`}/> as HTMLElement
    const header = (
        <div className="device-header">
            <span className="triangle"/>
            <div className="icon">
                <Icon symbol={device.icon}/>
            </div>
            <span className="name">{device.name}</span>
            <span className="brief">{device.brief}</span>
        </div>
    ) as HTMLElement
    const presetList = <div className="preset-list hidden"/> as HTMLElement
    renderPresetRows(presetList, presets)
    if (!empty) {
        header.onclick = () => {
            const open = presetList.classList.toggle("hidden") === false
            row.classList.toggle("expanded", open)
        }
    }
    if (filterActive && presets.length > 0) {
        presetList.classList.remove("hidden")
        row.classList.add("expanded")
    }
    row.appendChild(header)
    row.appendChild(presetList)
    return row
}

const renderCompoundRow = (
    label: string,
    presets: ReadonlyArray<PresetEntry>,
    filterActive: boolean
): HTMLElement => {
    const empty = presets.length === 0
    const row = <div className={`compound-row ${empty ? "empty" : ""}`}/> as HTMLElement
    const header = (
        <div className="compound-header">
            <span className="triangle"/>
            <div className="icon">
                <Icon symbol={IconSymbol.Cube}/>
            </div>
            <span className="name">{label}</span>
            <span className="brief"/>
        </div>
    ) as HTMLElement
    const presetList = <div className="preset-list hidden"/> as HTMLElement
    renderPresetRows(presetList, presets)
    if (!empty) {
        header.onclick = () => {
            const open = presetList.classList.toggle("hidden") === false
            row.classList.toggle("expanded", open)
        }
    }
    if (filterActive && presets.length > 0) {
        presetList.classList.remove("hidden")
        row.classList.add("expanded")
    }
    row.appendChild(header)
    row.appendChild(presetList)
    return row
}

const renderPresetRows = (container: HTMLElement, presets: ReadonlyArray<PresetEntry>) => {
    const user = presets.filter(entry => entry.source === "user")
    const stock = presets.filter(entry => entry.source === "stock")
    user.forEach(entry => container.appendChild(renderPresetRow(entry)))
    stock.forEach(entry => container.appendChild(renderPresetRow(entry)))
}

const renderPresetRow = (entry: PresetEntry): HTMLElement => (
    <div className={`preset-row source-${entry.source}`} title={entry.description}>
        <div className="marker">
            <Icon symbol={entry.source === "stock" ? IconSymbol.CloudFolder : IconSymbol.UserFolder}/>
        </div>
        <span className="name">{entry.name}</span>
    </div>
) as HTMLElement

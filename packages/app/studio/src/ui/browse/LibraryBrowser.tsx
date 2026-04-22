import css from "./LibraryBrowser.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, Nullable, Predicate, Terminator, UUID} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories, PresetHeader} from "@opendaw/studio-adapters"
import {
    EffectFactories,
    EffectFactory,
    OpenPresetAPI,
    PresetEntry,
    PresetMeta,
    PresetSource,
    PresetStorage
} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService.ts"
import {LibraryActions, LibraryCategoryKey} from "@/ui/browse/LibraryActions"
import {DeviceDropKind, DeviceItem, StockDeviceMeta} from "@/ui/browse/DeviceItem"
import {CompoundItem} from "@/ui/browse/CompoundItem"
import {Checkbox} from "../components/Checkbox"
import {Icon} from "../components/Icon"

const className = Html.adoptStyleSheet(css, "LibraryBrowser")

const tagSource = (list: ReadonlyArray<PresetMeta>, source: PresetSource): ReadonlyArray<PresetEntry> =>
    list.map(meta => ({...meta, source}))

const deviceKeyOf = (entry: PresetMeta): string => {
    switch (entry.category) {
        case "instrument":
        case "audio-effect":
        case "midi-effect":
            return entry.device
        case "audio-unit":
            return entry.instrument
        case "audio-effect-chain":
        case "midi-effect-chain":
            return ""
    }
}

const effectDevices = (records: Record<string, EffectFactory>): ReadonlyArray<StockDeviceMeta> =>
    Object.entries(records).map(([key, factory]) => ({
        key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription
    }))

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const LibraryBrowser = ({lifecycle, service}: Construct) => {
    const {project} = service
    const actions = new LibraryActions(project)
    const expandedKeys = new Set<string>()
    const search = new DefaultObservableValue("")
    const showStock = new DefaultObservableValue(true)
    const showUser = new DefaultObservableValue(true)
    const userIndex = PresetStorage.observable()
    const cloudIndex = new DefaultObservableValue<ReadonlyArray<PresetMeta>>([])
    const tree: HTMLElement = <div className="tree"/>
    const render = () => {
        const query = search.getValue().trim().toLowerCase()
        const stock = showStock.getValue()
        const user = showUser.getValue()
        const searching = query.length > 0
        const filterActive = searching || !stock || !user
        const allPresets: ReadonlyArray<PresetEntry> = [
            ...tagSource(userIndex.getValue(), "user"),
            ...tagSource(cloudIndex.getValue(), "stock")
        ]
        const matches = (entry: PresetEntry): boolean => {
            if (entry.source === "stock" && !stock) {return false}
            if (entry.source === "user" && !user) {return false}
            if (!searching) {return true}
            return entry.name.toLowerCase().includes(query)
                || deviceKeyOf(entry).toLowerCase().includes(query)
        }
        tree.replaceChildren(
            renderCategory({
                actions, expandedKeys, allPresets, query, matches, filterActive, searching,
                label: "Instruments",
                colorVar: "--color-green",
                categoryKey: "instrument",
                compoundLabel: "Racks",
                compoundCategory: "audio-unit",
                stockDevices: Object.entries(InstrumentFactories.Named).map(([key, factory]) => ({
                    key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription
                }))
            }),
            renderCategory({
                actions, expandedKeys, allPresets, query, matches, filterActive, searching,
                label: "Audio Effects",
                colorVar: "--color-blue",
                categoryKey: "audio-effect",
                compoundLabel: "Stash",
                compoundCategory: "audio-effect-chain",
                stockDevices: effectDevices(EffectFactories.AudioNamed)
            }),
            renderCategory({
                actions, expandedKeys, allPresets, query, matches, filterActive, searching,
                label: "MIDI Effects",
                colorVar: "--color-orange",
                categoryKey: "midi-effect",
                compoundLabel: "Stash",
                compoundCategory: "midi-effect-chain",
                stockDevices: effectDevices(EffectFactories.MidiNamed)
            })
        )
    }
    PresetStorage.readIndex().catch(reason => console.warn("PresetStorage.readIndex failed", reason))
    OpenPresetAPI.get().list().then(
        value => cloudIndex.setValue(value),
        reason => console.warn("OpenPresetAPI.list failed", reason))
    const enforceAtLeastOne = (target: DefaultObservableValue<boolean>, other: DefaultObservableValue<boolean>) =>
        target.subscribe(() => {
            if (!target.getValue() && !other.getValue()) {target.setValue(true)}
        })
    const stockToggle: HTMLElement = (
        <Checkbox lifecycle={lifecycle}
                  model={showStock}
                  className="source-toggle"
                  appearance={{tooltip: "Show stock presets", activeColor: Colors.blue}}>
            <Icon symbol={IconSymbol.CloudFolder}/>
        </Checkbox>
    )
    const userToggle: HTMLElement = (
        <Checkbox lifecycle={lifecycle}
                  model={showUser}
                  className="source-toggle"
                  appearance={{tooltip: "Show user presets", activeColor: Colors.blue}}>
            <Icon symbol={IconSymbol.UserFolder}/>
        </Checkbox>
    )
    lifecycle.ownAll(
        enforceAtLeastOne(showStock, showUser),
        enforceAtLeastOne(showUser, showStock),
        search.subscribe(render),
        showStock.catchupAndSubscribe(value => stockToggle.classList.toggle("active", value.getValue())),
        showUser.catchupAndSubscribe(value => userToggle.classList.toggle("active", value.getValue())),
        showStock.subscribe(render),
        showUser.subscribe(render),
        userIndex.subscribe(render),
        cloudIndex.subscribe(render),
        lifecycle.own(new Terminator())
    )
    render()
    return (
        <div className={className}>
            <div className="filter-bar">
                <input
                    type="search"
                    className="search"
                    placeholder="Search devices"
                    oninput={(event: Event) => search.setValue((event.target as HTMLInputElement).value)}/>
                {stockToggle}
                {userToggle}
            </div>
            {tree}
        </div>
    )
}

type RenderCategoryArgs = {
    actions: LibraryActions
    expandedKeys: Set<string>
    allPresets: ReadonlyArray<PresetEntry>
    query: string
    matches: Predicate<PresetEntry>
    filterActive: boolean
    searching: boolean
    label: string
    colorVar: string
    categoryKey: LibraryCategoryKey
    compoundLabel: string
    compoundCategory: "audio-unit" | "audio-effect-chain" | "midi-effect-chain"
    stockDevices: ReadonlyArray<StockDeviceMeta>
}

const renderCategory = (args: RenderCategoryArgs): HTMLElement => {
    const {
        actions, expandedKeys, allPresets, query, matches, filterActive, searching,
        label, colorVar, categoryKey, compoundLabel, compoundCategory, stockDevices
    } = args
    const section: HTMLElement = <section className="category" style={{"--color": `var(${colorVar})`}}/>
    section.appendChild(<h1>{label}</h1>)
    const dropKind: Nullable<DeviceDropKind> = categoryKey === "audio-effect" || categoryKey === "midi-effect"
        ? categoryKey
        : null
    stockDevices.forEach(device => {
        const devicePresets = allPresets
            .filter(entry => entry.category === categoryKey && deviceKeyOf(entry) === device.key)
            .filter(matches)
        if (query.length > 0) {
            const deviceMatchesQuery = device.name.toLowerCase().includes(query)
            if (!deviceMatchesQuery && devicePresets.length === 0) {return}
        }
        const onDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>> = isDefined(dropKind)
            ? effects => actions.saveAsSingleEffectPreset(dropKind, device.key, effects[0])
            : null
        const instrumentKey: Nullable<InstrumentFactories.Keys> = categoryKey === "instrument"
            && Object.hasOwn(InstrumentFactories.Named, device.key)
            ? device.key as InstrumentFactories.Keys
            : null
        const deviceExpandKey = `device:${categoryKey}:${device.key}`
        section.appendChild(DeviceItem({
            actions, expandedKeys, device, presets: devicePresets,
            expandOnRender: searching && devicePresets.length > 0,
            onCreate: () => actions.createDevice(categoryKey, device.key),
            dropKind, onDrop, instrumentKey, expandKey: deviceExpandKey
        }))
    })
    const compoundPresets = allPresets
        .filter(entry => entry.category === compoundCategory)
        .filter(matches)
    if (!filterActive || compoundPresets.length > 0) {
        const chainKind = compoundCategory === "audio-effect-chain"
            ? PresetHeader.ChainKind.Audio
            : compoundCategory === "midi-effect-chain"
                ? PresetHeader.ChainKind.Midi
                : null
        const onStashDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>> =
            isDefined(dropKind) && isDefined(chainKind)
                ? effects => actions.saveAsChainPreset(chainKind, effects)
                : null
        const onRackDrop = compoundCategory === "audio-unit"
            ? (instrumentUuid: UUID.String, effectUuids: ReadonlyArray<UUID.String>) =>
                actions.handleRackDrop(instrumentUuid, effectUuids)
            : null
        const compoundExpandKey = `compound:${categoryKey}:${compoundCategory}`
        section.appendChild(CompoundItem({
            actions, expandedKeys, label: compoundLabel, presets: compoundPresets,
            expandOnRender: searching && compoundPresets.length > 0,
            dropKind, onDrop: onStashDrop, onRackDrop, expandKey: compoundExpandKey
        }))
    }
    return section
}

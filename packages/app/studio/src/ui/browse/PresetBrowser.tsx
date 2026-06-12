import css from "./PresetBrowser.sass?inline"
import {
    Color,
    DefaultObservableValue,
    isDefined,
    Lifecycle,
    Nullable,
    Predicate,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {Await, createElement} from "@opendaw/lib-jsx"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories, PresetHeader} from "@opendaw/studio-adapters"
import {
    EffectFactories,
    EffectFactory,
    PresetEntry,
    PresetMeta,
    PresetSource
} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService.ts"
import {deviceKeyOf, PresetCategoryKey, PresetService} from "@/ui/browse/PresetService"
import {DeviceDropKind, DeviceItem, StockDeviceMeta} from "@/ui/browse/DeviceItem"
import {CompoundItem} from "@/ui/browse/CompoundItem"
import {Checkbox} from "../components/Checkbox"
import {Icon} from "../components/Icon"
import {SearchInput} from "@/ui/components/SearchInput"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {ThreeDots} from "@/ui/spinner/ThreeDots"

const className = Html.adoptStyleSheet(css, "PresetBrowser")

const tagSource = (list: ReadonlyArray<PresetMeta>, source: PresetSource): ReadonlyArray<PresetEntry> =>
    list.map(meta => ({...meta, source}))

const effectDevices = (records: Record<string, EffectFactory>): ReadonlyArray<StockDeviceMeta> =>
    Object.entries(records).map(([key, factory]) => ({
        key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription,
        externalIconUrl: factory.external ? "/images/tone3000.svg" : undefined
    }))

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const PresetBrowser = ({lifecycle, service}: Construct) => {
    const presets = service.presets
    const userIndex = presets.userIndex
    const cloudIndex = presets.cloudIndex
    const cloudReady = presets.cloudReady
    const expandedKeys = new Set<string>()
    const search = new DefaultObservableValue("")
    const showStock = new DefaultObservableValue(true)
    const showUser = new DefaultObservableValue(true)
    const tree: HTMLElement = <div className="tree" onConnect={element => lifecycle.own(installScrollbars(element))}/>
    // Per-render lifecycle for item-level subscriptions (e.g. preset tooltips).
    // Terminated at the start of every render so disposed-of items don't leak
    // event listeners across re-renders.
    const itemLifecycle = lifecycle.own(new Terminator())
    const render = () => {
        itemLifecycle.terminate()
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
                presetService: presets, expandedKeys, allPresets, query, matches, filterActive, searching,
                label: "Instruments",
                color: Colors.green,
                categoryKey: "instrument",
                compoundLabel: "Racks",
                compoundCategory: "audio-unit",
                stockDevices: Object.entries(InstrumentFactories.Named).map(([key, factory]) => ({
                    key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription,
                    presetless: key === "Tape"
                })),
                lifecycle: itemLifecycle
            }),
            renderCategory({
                presetService: presets, expandedKeys, allPresets, query, matches, filterActive, searching,
                label: "Audio Effects",
                color: Colors.blue,
                categoryKey: "audio-effect",
                compoundLabel: "Chains",
                compoundCategory: "audio-effect-chain",
                stockDevices: effectDevices(EffectFactories.AudioNamed),
                lifecycle: itemLifecycle
            }),
            renderCategory({
                presetService: presets, expandedKeys, allPresets, query, matches, filterActive, searching,
                label: "MIDI Effects",
                color: Colors.orange,
                categoryKey: "midi-effect",
                compoundLabel: "Chains",
                compoundCategory: "midi-effect-chain",
                stockDevices: effectDevices(EffectFactories.MidiNamed),
                lifecycle: itemLifecycle
            })
        )
    }
    const enforceAtLeastOne = (target: DefaultObservableValue<boolean>,
                               other: DefaultObservableValue<boolean>) => target.subscribe(() => {
        if (!target.getValue() && !other.getValue()) {target.setValue(true)}
    })
    const stockToggle: HTMLElement = (
        <Checkbox lifecycle={lifecycle}
                  model={showStock}
                  appearance={{tooltip: "Show stock presets", activeColor: Colors.blue, framed: true, landscape: true}}>
            <Icon symbol={IconSymbol.CloudFolder}/>
        </Checkbox>
    )
    const userToggle: HTMLElement = (
        <Checkbox lifecycle={lifecycle}
                  model={showUser}
                  appearance={{tooltip: "Show user presets", activeColor: Colors.blue, framed: true, landscape: true}}>
            <Icon symbol={IconSymbol.UserFolder}/>
        </Checkbox>
    )
    lifecycle.ownAll(
        enforceAtLeastOne(showStock, showUser),
        enforceAtLeastOne(showUser, showStock),
        search.subscribe(render),
        showStock.subscribe(render),
        showUser.subscribe(render),
        userIndex.subscribe(render),
        cloudIndex.subscribe(render)
    )
    render()
    return (
        <div className={className}>
            <div className="filter-bar">
                {stockToggle}
                {userToggle}
                <SearchInput lifecycle={lifecycle} model={search}/>
            </div>
            <Await
                factory={() => cloudReady}
                loading={() => <div className="loading"><ThreeDots/></div>}
                success={() => tree}
                failure={() => tree}/>
        </div>
    )
}

type RenderCategoryArgs = {
    presetService: PresetService
    expandedKeys: Set<string>
    allPresets: ReadonlyArray<PresetEntry>
    query: string
    matches: Predicate<PresetEntry>
    filterActive: boolean
    searching: boolean
    label: string
    color: Color
    categoryKey: PresetCategoryKey
    compoundLabel: string
    compoundCategory: "audio-unit" | "audio-effect-chain" | "midi-effect-chain"
    stockDevices: ReadonlyArray<StockDeviceMeta>
    lifecycle: Lifecycle
}

const renderCategory = (args: RenderCategoryArgs): HTMLElement => {
    const {
        presetService, expandedKeys, allPresets, query, matches, filterActive, searching,
        label, color, categoryKey, compoundLabel, compoundCategory, stockDevices, lifecycle
    } = args
    const section: HTMLElement = <section className="category" style={{"--color": color.toString()}}/>
    section.appendChild(<h1>{label}</h1>)
    const dropKind: Nullable<DeviceDropKind> = categoryKey === "audio-effect" || categoryKey === "midi-effect"
        ? categoryKey
        : null
    const renderDevice = (device: StockDeviceMeta): void => {
        const devicePresets = device.presetless === true ? [] : allPresets
            .filter(entry => entry.category === categoryKey && deviceKeyOf(entry) === device.key)
            .filter(matches)
        if (query.length > 0) {
            const deviceMatchesQuery = device.name.toLowerCase().includes(query)
            if (!deviceMatchesQuery && devicePresets.length === 0) {return}
        }
        const onDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>> =
            isDefined(dropKind) && device.presetless !== true
                ? effects => presetService.saveAsSingleEffectPreset(dropKind, device.key, effects[0])
                : null
        const instrumentKey: Nullable<InstrumentFactories.Keys> = categoryKey === "instrument"
        && device.presetless !== true
        && Object.hasOwn(InstrumentFactories.Named, device.key)
            ? device.key as InstrumentFactories.Keys
            : null
        const deviceExpandKey = `device:${categoryKey}:${device.key}`
        section.appendChild(DeviceItem({
            presetService, expandedKeys, device, presets: devicePresets,
            expandOnRender: searching && devicePresets.length > 0,
            onCreate: () => presetService.createDevice(categoryKey, device.key),
            dropKind, onDrop, instrumentKey, expandKey: deviceExpandKey, lifecycle
        }))
    }
    stockDevices.forEach(renderDevice)
    const compoundPresets = allPresets
        .filter(entry => entry.category === compoundCategory)
        .filter(matches)
    if (!filterActive || compoundPresets.length > 0) {
        const chainKind = compoundCategory === "audio-effect-chain"
            ? PresetHeader.ChainKind.Audio
            : compoundCategory === "midi-effect-chain"
                ? PresetHeader.ChainKind.Midi
                : null
        const onChainDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>> =
            isDefined(dropKind) && isDefined(chainKind)
                ? effects => presetService.saveAsChainPreset(chainKind, effects)
                : null
        const onRackDrop = compoundCategory === "audio-unit"
            ? (instrumentUuid: UUID.String, effectUuids: ReadonlyArray<UUID.String>) =>
                presetService.handleRackDrop(instrumentUuid, effectUuids)
            : null
        const compoundExpandKey = `compound:${categoryKey}:${compoundCategory}`
        const compoundIcon = compoundCategory === "audio-unit" ? IconSymbol.Cube : IconSymbol.Chain
        section.appendChild(CompoundItem({
            presetService, expandedKeys, label: compoundLabel, icon: compoundIcon, presets: compoundPresets,
            expandOnRender: searching && compoundPresets.length > 0,
            dropKind, onDrop: onChainDrop, onRackDrop, expandKey: compoundExpandKey, lifecycle
        }))
    }
    return section
}

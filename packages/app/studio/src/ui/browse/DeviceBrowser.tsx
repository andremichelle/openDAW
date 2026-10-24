import css from "./DeviceBrowser.sass?inline"
import {
    asDefined,
    Color,
    DefaultObservableValue,
    EmptyExec,
    Exec,
    isDefined,
    Lifecycle,
    MutableObservableOption,
    Nullable,
    Provider,
    StringComparator,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {Runtime} from "@opendaw/lib-runtime"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Await, createElement} from "@opendaw/lib-jsx"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, PresetEntry} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService.ts"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {CommunityScript} from "@/opendaw-api/CommunityIndex"
import {deviceKeyOf, PresetCategoryKey} from "@/ui/browse/PresetService"
import {DeviceDropKind, DeviceItem, StockDeviceMeta} from "@/ui/browse/DeviceItem"
import {PresetItem} from "@/ui/browse/PresetItem"
import {ScriptItem} from "@/ui/browse/ScriptItem"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"
import {Checkbox} from "../components/Checkbox"
import {Icon} from "../components/Icon"
import {SearchInput} from "@/ui/components/SearchInput"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {ThreeDots} from "@/ui/spinner/ThreeDots"

const className = Html.adoptStyleSheet(css, "DeviceBrowser")

const instrumentDevices = (): ReadonlyArray<StockDeviceMeta> =>
    InstrumentFactories.Sorted.map(([key, factory]) => ({
        key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription,
        description: factory.description, presetless: key === "Tape"
    }))

const effectDevices = (records: Record<string, EffectFactory>): ReadonlyArray<StockDeviceMeta> =>
    Object.entries(records).map(([key, factory]) => ({
        key, name: factory.defaultName, icon: factory.defaultIcon, brief: factory.briefDescription,
        description: factory.description, externalIconUrl: factory.external ? "/images/tone3000.svg" : undefined
    }))

type Category = {
    readonly color: Color
    readonly kind: string
    readonly hint: string
    readonly devices: Provider<ReadonlyArray<StockDeviceMeta>>
    readonly scriptTarget: SpotlightCreate.ScriptTarget
    readonly scriptHost: string
}

const Categories: Record<PresetCategoryKey, Category> = {
    "instrument": {
        color: Colors.green, kind: "instrument", hint: "Double-click to create or drag to the timeline",
        devices: instrumentDevices, scriptTarget: "apparat", scriptHost: "Apparat"
    },
    "audio-effect": {
        color: Colors.blue, kind: "audio effect", hint: "Double-click to add or drag into a device chain",
        devices: () => effectDevices(EffectFactories.AudioNamed),
        scriptTarget: "werkstatt", scriptHost: "Werkstatt"
    },
    "midi-effect": {
        color: Colors.orange, kind: "MIDI effect", hint: "Double-click to add or drag into a device chain",
        devices: () => effectDevices(EffectFactories.MidiNamed),
        scriptTarget: "spielwerk", scriptHost: "Spielwerk"
    }
}

const enum Rank {Device, UserPreset, StockPreset, Script}

type Details = {
    readonly caption: string
    readonly text: string
}

type Row = {
    readonly key: string
    readonly details: Details
    readonly name: string
    readonly rank: Rank
    readonly terms: ReadonlyArray<string>
    readonly create: Provider<HTMLElement>
}

const compareRows = (left: Row, right: Row): number => {
    const order = StringComparator(left.name.toLowerCase(), right.name.toLowerCase())
    return order !== 0 ? order : left.rank - right.rank
}

const DetailsDuration = 200
const DoubleClickWindow = 200

const detailsAnimations = new WeakMap<Element, Terminable>()

// whole pixels each frame, fractional heights make the text and the rows below shimmer
const animateHeight = (block: HTMLElement, to: number, complete: Exec = EmptyExec): void => {
    const running = detailsAnimations.get(block)
    if (isDefined(running)) {running.terminate()}
    const from = block.getBoundingClientRect().height
    const start = performance.now()
    const animation: Terminable = AnimationFrame.add(() => {
        const progress = Math.min(1.0, (performance.now() - start) / DetailsDuration)
        block.style.height = `${Math.round(from + (to - from) * (1.0 - (1.0 - progress) ** 3))}px`
        if (progress < 1.0) {return}
        animation.terminate()
        detailsAnimations.delete(block)
        complete()
    })
    detailsAnimations.set(block, animation)
}

export type DeviceFilter = {
    readonly search: DefaultObservableValue<string>
    readonly showStock: DefaultObservableValue<boolean>
    readonly showUser: DefaultObservableValue<boolean>
    readonly showScripts: DefaultObservableValue<boolean>
}

export namespace DeviceFilter {
    export const create = (): DeviceFilter => ({
        search: new DefaultObservableValue(""),
        showStock: new DefaultObservableValue(true),
        showUser: new DefaultObservableValue(true),
        showScripts: new DefaultObservableValue(true)
    })
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    category: PresetCategoryKey
    filter: DeviceFilter
}

export const DeviceBrowser = ({lifecycle, service, category, filter}: Construct) => {
    const presets = service.presets
    const {color, kind, hint, devices, scriptTarget, scriptHost} = Categories[category]
    const {search, showStock, showUser, showScripts} = filter
    const stockDevices = devices()
    const deviceByKey = new Map(stockDevices.map(device => [device.key, device]))
    const hostDevice = asDefined(deviceByKey.get(scriptHost), `No script host '${scriptHost}'`)
    const scripts = new DefaultObservableValue<ReadonlyArray<CommunityScript>>([])
    const rows: HTMLElement = <div className="rows"/>
    const list: HTMLElement = (
        <div className="list" onConnect={element => lifecycle.own(installScrollbars(element))}>{rows}</div>
    )
    const itemLifecycle = lifecycle.own(new Terminator())
    const openKey = new MutableObservableOption<string>()
    const pendingClick = lifecycle.own(new Terminator())
    const createDetails = ({caption, text}: Details): HTMLElement => (
        <div className="details">
            <div className="card">
                <span className="caption">{caption}</span>
                {text.length > 0 && <p>{text}</p>}
                <span className="hint">{hint}</span>
            </div>
            <div className="spacer"/>
        </div>
    )
    const closeDetails = (): void => rows.querySelectorAll<HTMLElement>(":scope > div.details.open").forEach(block => {
        const row = block.previousElementSibling
        block.classList.remove("open")
        if (isDefined(row)) {row.classList.remove("open")}
        animateHeight(block, 0, () => block.remove())
    })
    const toggleDetails = (row: Row, element: HTMLElement): void => {
        closeDetails()
        if (openKey.contains(row.key)) {
            openKey.clear()
            return
        }
        openKey.wrap(row.key)
        const block = createDetails(row.details)
        block.classList.add("open")
        block.style.height = "0px"
        element.classList.add("open")
        element.after(block)
        animateHeight(block, block.scrollHeight, () => block.style.removeProperty("height"))
    }
    const mount = (row: Row): ReadonlyArray<HTMLElement> => {
        const element = row.create()
        itemLifecycle.ownAll(
            Events.subscribeSingleClick(element, () => {
                pendingClick.terminate()
                pendingClick.own(Runtime.scheduleTimeout(() => toggleDetails(row, element), DoubleClickWindow))
            }),
            Events.subscribe(element, "dblclick", () => pendingClick.terminate())
        )
        if (!openKey.contains(row.key)) {return [element]}
        const block = createDetails(row.details)
        element.classList.add("open")
        block.classList.add("open")
        return [element, block]
    }
    const dropKind: Nullable<DeviceDropKind> = category === "instrument" ? null : category
    const deviceRow = (device: StockDeviceMeta): Row => ({
        key: `device:${device.key}`, details: {caption: `Stock ${kind}`, text: device.description},
        name: device.name, rank: Rank.Device, terms: [device.name],
        create: () => {
            const onDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>> =
                isDefined(dropKind) && device.presetless !== true
                    ? effects => presets.saveAsSingleEffectPreset(dropKind, device.key, effects[0])
                    : null
            const instrumentKey: Nullable<InstrumentFactories.Keys> = category === "instrument"
            && device.presetless !== true
            && Object.hasOwn(InstrumentFactories.Named, device.key)
                ? device.key as InstrumentFactories.Keys
                : null
            return DeviceItem({
                presetService: presets, device, onCreate: () => presets.createDevice(category, device.key),
                dropKind, onDrop, instrumentKey, lifecycle: itemLifecycle
            })
        }
    })
    // TODO racks and chains (audio-unit, audio-effect-chain, midi-effect-chain) are not listed yet
    const presetRows = (): ReadonlyArray<Row> => presets.presets()
        .filter(entry => entry.category === category)
        .filter(entry => entry.source === "user" ? showUser.getValue() : showStock.getValue())
        .flatMap((entry: PresetEntry): ReadonlyArray<Row> => {
            const device = deviceByKey.get(deviceKeyOf(entry))
            if (!isDefined(device)) {return []}
            return [{
                key: `preset:${entry.uuid}`, details: {
                    caption: `${entry.source === "user" ? "User" : "Stock"} preset for ${device.name}`,
                    text: entry.description
                },
                name: entry.name, rank: entry.source === "user" ? Rank.UserPreset : Rank.StockPreset,
                terms: [entry.name, device.name],
                create: () => PresetItem({entry, device, presetService: presets, lifecycle: itemLifecycle})
            }]
        })
    const scriptRows = (): ReadonlyArray<Row> => showScripts.getValue()
        ? scripts.getValue()
            .filter(script => script.target === scriptTarget)
            .map((script): Row => ({
                key: `script:${script.uuid}`, details: {
                    caption: `Community script by ${script.author.name}`, text: script.description
                },
                name: script.name, rank: Rank.Script, terms: [script.name, script.author.name, ...script.tags],
                create: () => ScriptItem({service, script, device: hostDevice, lifecycle: itemLifecycle})
            }))
        : []
    const render = () => {
        itemLifecycle.terminate()
        const query = search.getValue().trim().toLowerCase()
        rows.replaceChildren(...[...stockDevices.map(deviceRow), ...presetRows(), ...scriptRows()]
            .filter(row => query.length === 0 || row.terms.some(term => term.toLowerCase().includes(query)))
            .toSorted(compareRows)
            .flatMap(mount))
    }
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
    const scriptToggle: HTMLElement = (
        <Checkbox lifecycle={lifecycle}
                  model={showScripts}
                  appearance={{tooltip: "Show community scripts", activeColor: Colors.blue, framed: true, landscape: true}}>
            <Icon symbol={IconSymbol.Code}/>
        </Checkbox>
    )
    lifecycle.ownAll(
        search.subscribe(render),
        showStock.subscribe(render),
        showUser.subscribe(render),
        showScripts.subscribe(render),
        presets.userIndex.subscribe(render),
        presets.cloudIndex.subscribe(render),
        scripts.subscribe(render)
    )
    render()
    return (
        <div className={className} style={{"--color": color.toString()}}>
            <div className="filter-bar">
                {stockToggle}
                {userToggle}
                {scriptToggle}
                <SearchInput lifecycle={lifecycle} model={search}/>
            </div>
            <Await
                factory={() => Promise.all([
                    presets.cloudReady,
                    CommunityAPI.get().scripts().then(index => scripts.setValue(index.scripts))
                ])}
                loading={() => <div className="loading"><ThreeDots/></div>}
                success={() => list}
                failure={() => list}/>
        </div>
    )
}

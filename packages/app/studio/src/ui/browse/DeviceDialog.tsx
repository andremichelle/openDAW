import css from "./DeviceDialog.sass?inline"
import {
    Color,
    DefaultObservableValue,
    isDefined,
    MutableObservableOption,
    Nullable,
    Option,
    Terminator
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {PresetEntry} from "@opendaw/studio-core"
import {Devices} from "@opendaw/studio-adapters"
import type {StudioService} from "@/service/StudioService"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {Dialog} from "@/ui/components/Dialog"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Button} from "@/ui/components/Button"
import {SearchInput} from "@/ui/components/SearchInput"
import {installScrollbars} from "@/ui/components/Scrollbars"
import {Surface} from "@/ui/surface/Surface"
import {ThreeDots} from "@/ui/spinner/ThreeDots"
import {SpotlightCreate} from "@/ui/spotlight/SpotlightCreate"
import {DeviceBundle, DeviceCatalog, DeviceEntry, DeviceEntryKind} from "@/ui/browse/DeviceCatalog"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {DeviceAudition} from "@/ui/browse/DeviceAudition"
import {DeviceSlot} from "@/ui/browse/DeviceSlot"
import {PresetCategoryKey} from "@/ui/browse/PresetService"
import {DevicePiano} from "@/ui/browse/DevicePiano"
import {MidiAccessButton} from "@/ui/header/MidiAccessButton"
import {AccessKey} from "@/opendaw-api/AccessKey"

const className = Html.adoptStyleSheet(css, "DeviceDialog")

const Gap = 16
const MinHeight = 240

const filter = {
    search: new DefaultObservableValue(""),
    showStock: new DefaultObservableValue(true),
    showUser: new DefaultObservableValue(true),
    showPresets: new DefaultObservableValue(true),
    showScripts: new DefaultObservableValue(true),
    showWclaps: new DefaultObservableValue(true)
}

const colorOf: Record<PresetCategoryKey, Color> = {
    "instrument": Colors.green, "audio-effect": Colors.blue, "midi-effect": Colors.orange
}

const headlineOf = (slot: DeviceSlot): string => {
    switch (slot.type) {
        case "insert":
            return slot.accepts === "midi" ? "Add MIDI Effect" : "Add Audio Effect"
        case "replace-effect":
            return slot.accepts === "midi" ? "Replace MIDI Effect" : "Replace Audio Effect"
        case "replace-instrument":
            return "Replace Instrument"
        case "new-instrument":
            return "Add Instrument"
    }
}

const hintOf = (slot: DeviceSlot): string => {
    const noun = DeviceSlot.categoryOf(slot) === "instrument" ? "an instrument" : "an effect"
    return DeviceSlot.isReplace(slot)
        ? `Select ${noun} to replace and preview it`
        : `Select ${noun} to create and preview it`
}

const bundleOf: Record<DeviceBundle, { icon: IconSymbol, text: string }> = {
    rack: {icon: IconSymbol.Stack, text: "Rack: a complete track with instrument and effects"},
    chain: {icon: IconSymbol.Chain, text: "Chain: several effects in a row"}
}

const badgeOf: Record<DeviceEntryKind, Nullable<IconSymbol>> = {
    "device": null, "user-preset": IconSymbol.UserFolder, "stock-preset": IconSymbol.CloudFolder,
    "script": IconSymbol.Code, "wclap": IconSymbol.WebClap
}

const isVisible = (entry: DeviceEntry): boolean => {
    switch (entry.kind) {
        case "device":
            return true
        case "user-preset":
            return filter.showPresets.getValue() && filter.showUser.getValue()
        case "stock-preset":
            return filter.showPresets.getValue() && filter.showStock.getValue()
        case "script":
            return filter.showScripts.getValue() && filter.showStock.getValue()
        case "wclap":
            return filter.showWclaps.getValue() && (entry.local ? filter.showUser.getValue() : filter.showStock.getValue())
    }
}

const matches = (entry: DeviceEntry, query: string): boolean => {
    const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 0)
    if (words.length === 0) {return true}
    const text = [entry.name, entry.brief, ...entry.tags, ...entry.facts.map(({value}) => value)].join(" ").toLowerCase()
    return words.every(word => text.includes(word))
}

// between the app header and the device panel, so the auditioned device stays in sight
const placeAbovePanel = (dialog: HTMLDialogElement): void => {
    const panel = document.querySelector<HTMLElement>("[data-device-panel]")
    const header = document.querySelector<HTMLElement>("[data-app-header]")
    if (!isDefined(panel) || panel.getBoundingClientRect().height === 0) {return}
    const top = (isDefined(header) ? header.getBoundingClientRect().bottom : 0) + Gap
    const bottom = panel.getBoundingClientRect().top - Gap
    if (bottom - top < MinHeight) {return}
    dialog.style.height = `${bottom - top}px`
    dialog.style.maxHeight = `${bottom - top}px`
    dialog.style.top = `${top}px`
    dialog.style.transform = "translate(-50%, 0)"
}

export namespace DeviceDialog {
    export const open = (service: StudioService, slot: DeviceSlot): void => {
        if (!service.hasProfile) {return}
        const lifecycle = new Terminator()
        const audition = lifecycle.own(new DeviceAudition(service, slot))
        const category = DeviceSlot.categoryOf(slot)
        const color = colorOf[category]
        const sources = new DefaultObservableValue<DeviceCatalog.Sources>({presets: [], scripts: [], wclaps: []})
        const selected = new MutableObservableOption<DeviceEntry>()
        const elements = new Map<string, HTMLElement>()
        const visible: Array<DeviceEntry> = []
        const approved = {value: false}
        const currentKey = DeviceSlot.currentDeviceKey(slot)
        const rows: HTMLElement = <div className="rows"/>
        const list: HTMLElement = (
            <div className="list" onConnect={element => lifecycle.own(installScrollbars(element))}>{rows}</div>
        )
        const card: HTMLElement = (
            <div className="card" onConnect={element => lifecycle.own(installScrollbars(element))}/>
        )
        const search: HTMLElement = <SearchInput lifecycle={lifecycle} model={filter.search} placeholder="Search names and tags"/>
        const toggle = (model: DefaultObservableValue<boolean>, tooltip: string, symbol: IconSymbol) => (
            <Checkbox lifecycle={lifecycle} model={model}
                      appearance={{tooltip, activeColor: Colors.blue, framed: true, landscape: true}}>
                <Icon symbol={symbol}/>
            </Checkbox>
        )
        const renderCard = (): void => {
            const entry = selected.unwrapOrNull()
            if (!isDefined(entry)) {
                card.replaceChildren(<p className="placeholder">{hintOf(slot)}</p>)
                return
            }
            const loading = audition.loading.getValue() && selected.contains(entry)
            const parts: ReadonlyArray<Nullable<Node>> = [
                <h2>{entry.name}</h2>,
                <span className="caption">{loading ? "Loading..." : entry.caption}</span>,
                entry.description.length > 0 ? <p className="description">{entry.description}</p> : null,
                entry.facts.length > 0 ? (
                    <div className="facts">
                        {entry.facts.map(({label, value}) => [<span>{label}</span>, <span>{value}</span>])}
                    </div>
                ) : null,
                entry.tags.length > 0 ? (
                    <div className="tags">
                        {entry.tags.map(tag => <button className="tag" onclick={() => filter.search.setValue(tag)}>{tag}</button>)}
                    </div>
                ) : null,
                entry.preset.mapOr(preset => preset.source === "user" ? presetActions(preset) : null, null)
            ]
            card.replaceChildren(...parts.filter(isDefined))
        }
        const cardLifecycle = lifecycle.own(new Terminator())
        const presetActions = (preset: PresetEntry): HTMLElement => {
            cardLifecycle.terminate()
            const presets = service.presets
            const action = (label: string, run: () => Promise<void>) => (
                <Button lifecycle={cardLifecycle} onClick={() => run().catch(console.warn)}
                        appearance={{color: Colors.shadow, framed: true}}>{label}</Button>
            )
            return (
                <div className="actions">
                    {action("Edit…", () => presets.editPreset(preset))}
                    {action("Duplicate", () => presets.duplicatePreset(preset))}
                    {AccessKey.get().nonEmpty() && action("Upload", () => presets.uploadPreset(preset))}
                    {action("Delete", () => presets.deletePreset(preset))}
                    {action("Save to Disk…", () => presets.savePresetToDisk(preset))}
                </div>
            )
        }
        const elementOf = (entry: DeviceEntry): HTMLElement => {
            const existing = elements.get(entry.key)
            if (isDefined(existing)) {return existing}
            const badge = badgeOf[entry.kind]
            const bundle: HTMLElement = (
                <span className="bundle">{entry.bundle.mapOr(bundle => <Icon symbol={bundleOf[bundle].icon}/>, null)}</span>
            )
            entry.bundle.ifSome(kind => lifecycle.own(TextTooltip.default(bundle, () => bundleOf[kind].text)))
            const element: HTMLElement = (
                <div className="entry" onclick={() => pick(entry)}>
                    {entry.iconUrl.match({
                        none: () => <div className="icon"><Icon symbol={entry.icon}/></div>,
                        some: url => <div className="icon external"><img src={url} alt=""/></div>
                    })}
                    <span className="name">{entry.name}</span>
                    {entry.brief.length > 0
                        ? <span className="brief">{entry.brief}</span>
                        : <span className="brief missing">No description</span>}
                    {bundle}
                    <span className="badge">{isDefined(badge) ? <Icon symbol={badge}/> : null}</span>
                </div>
            )
            elements.set(entry.key, element)
            return element
        }
        const markSelection = (): void => elements.forEach((element, key) =>
            element.classList.toggle("selected", selected.mapOr(entry => entry.key === key, false)))
        const ready = {value: false}
        const render = (): void => {
            if (!ready.value) {
                rows.replaceChildren(<div className="loading"><ThreeDots/></div>)
                return
            }
            const query = filter.search.getValue().trim()
            visible.splice(0, visible.length, ...DeviceCatalog.entriesFor(slot, sources.getValue())
                .filter(entry => isVisible(entry) && matches(entry, query)))
            rows.replaceChildren(...visible.map(elementOf))
            if (visible.length === 0) {rows.appendChild(<span className="empty">Nothing matches.</span>)}
            markSelection()
            if (query.length > 0 && visible.length === 1 && !selected.mapOr(entry => entry.key === visible[0].key, false)) {
                pick(visible[0])
            }
        }
        const select = (entry: DeviceEntry): void => {
            selected.wrap(entry)
            elementOf(entry).scrollIntoView({block: "nearest"})
        }
        const pick = (entry: DeviceEntry): void => {
            select(entry)
            audition.pick(entry)
        }
        const step = (delta: number): void => {
            if (visible.length === 0) {return}
            const index = selected.mapOr(entry => visible.findIndex(({key}) => key === entry.key), -1)
            const next = index < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, index + delta))
            if (next !== index) {pick(visible[next])}
        }
        const approve = async (): Promise<void> => {
            await audition.approve()
            approved.value = true
            dialog.close("approve")
        }
        const togglePlayback = (): void => {
            const {engine} = service
            if (engine.isPlaying.getValue()) {engine.stop()} else {engine.play()}
        }
        const {captureDevices, userEditingManager, boxAdapters} = service.project
        const armedBefore = new Set(captureDevices.allCaptures().filter(capture => capture.armed.getValue()))
        const armEditing = (): void => (slot.type === "new-instrument"
            ? userEditingManager.audioUnit.get().map(vertex => boxAdapters.adapterFor(vertex.box, Devices.isHost))
            : Option.wrap(slot.host)).ifSome(host => captureDevices.get(host.audioUnitBoxAdapter().uuid)
            .ifSome(target => captureDevices.allCaptures().forEach(capture => capture.armed.setValue(capture === target))))
        const piano: Nullable<SVGElement> = DeviceSlot.takesNotes(slot) ? <DevicePiano lifecycle={lifecycle}/> : null
        const onKeyDown = (event: KeyboardEvent): void => {
            const typing = Events.isTextInput(event.target) && filter.search.getValue().length > 0
            if (event.code === "ArrowDown" || event.code === "ArrowUp") {
                step(event.code === "ArrowDown" ? 1 : -1)
            } else if (event.code === "Enter" || event.code === "NumpadEnter") {
                approve().catch(console.warn)
            } else if (event.code === "Space" && !typing) {
                togglePlayback()
            } else {
                return
            }
            event.preventDefault()
            event.stopPropagation()
        }
        const content: HTMLElement = (
            <div className={className} style={{"--color": color.toString()}}>
                <div className="filter-bar">
                    {toggle(filter.showStock, "Show what comes from the openDAW cloud", IconSymbol.CloudFolder)}
                    {toggle(filter.showUser, "Show what is stored on this device", IconSymbol.UserFolder)}
                    <div className="separator"/>
                    {toggle(filter.showPresets, "Show presets", IconSymbol.Folder)}
                    {toggle(filter.showScripts, "Show community scripts", IconSymbol.Code)}
                    {category !== "midi-effect" && toggle(filter.showWclaps, "Show WebCLAP plugins", IconSymbol.WebClap)}
                    {search}
                </div>
                {list}
                {card}
                {piano}
            </div>
        )
        const dialog: HTMLDialogElement = (
            <Dialog headline={headlineOf(slot)}
                    icon={IconSymbol.Add}
                    cancelable={true}
                    growWidth={true}
                    leading={isDefined(piano) ? <MidiAccessButton lifecycle={lifecycle} style={{fontSize: "16px"}}/> : undefined}
                    style={{width: "min(56em, 90vw)", height: "min(36em, 75vh)"}}
                    buttons={[
                        {text: "Cancel", onClick: () => dialog.close()},
                        {text: "Ok", primary: true, onClick: () => {approve().catch(console.warn)}}
                    ]}>
                <div style={{height: "1em"}}/>
                {content}
            </Dialog>
        )
        lifecycle.ownAll(
            Events.subscribe(dialog, "keydown", onKeyDown),
            filter.search.subscribe(render),
            filter.showStock.subscribe(render),
            filter.showUser.subscribe(render),
            filter.showPresets.subscribe(render),
            filter.showScripts.subscribe(render),
            filter.showWclaps.subscribe(render),
            sources.subscribe(render),
            service.presets.userIndex.subscribe(() => sources.setValue({...sources.getValue(), presets: service.presets.presets()})),
            service.presets.cloudIndex.subscribe(() => sources.setValue({...sources.getValue(), presets: service.presets.presets()})),
            selected.subscribe(() => {
                markSelection()
                renderCard()
            }),
            audition.applied.subscribe(() => {if (isDefined(piano)) {armEditing()}}),
            audition.loading.subscribe(renderCard),
            service.projectProfileService.subscribe(() => dialog.close())
        )
        render()
        renderCard()
        Promise.all([
            service.presets.cloudReady,
            CommunityAPI.get().scripts().then(index => index.scripts, (reason: unknown) => {
                console.warn(reason)
                return []
            }),
            SpotlightCreate.wclaps()
        ]).then(([_, scripts, wclaps]) => {
            if (!dialog.open) {return}
            ready.value = true
            sources.setValue({presets: service.presets.presets(), scripts, wclaps})
            currentKey.ifSome(key => Option.wrap(visible.find(entry => entry.kind === "device" && entry.deviceKey === key))
                .ifSome(select))
        })
        if (isDefined(piano)) {armEditing()}
        dialog.addEventListener("close", () => {
            if (!approved.value) {audition.cancel()}
            if (isDefined(piano)) {captureDevices.allCaptures().forEach(capture => capture.armed.setValue(armedBefore.has(capture)))}
            lifecycle.terminate()
        }, {once: true})
        Surface.get().body.appendChild(dialog)
        placeAbovePanel(dialog)
        dialog.showModal()
        search.focus()
    }
}

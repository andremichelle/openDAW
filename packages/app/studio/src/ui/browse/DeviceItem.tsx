import css from "./DeviceItem.sass?inline"
import {isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData, DragDevice} from "@/ui/AnyDragData"
import {PresetService} from "@/ui/browse/PresetService"
import {Icon} from "../components/Icon"

const className = Html.adoptStyleSheet(css, "DeviceItem")

export type StockDeviceMeta = {
    key: string
    name: string
    icon: IconSymbol
    brief: string
    description: string
    externalIconUrl?: string
    presetless?: boolean
}
export type DeviceDropKind = "audio-effect" | "midi-effect"

export const DeviceIcon = ({device}: { device: StockDeviceMeta }): HTMLElement => isDefined(device.externalIconUrl)
    ? <div className="icon external"><img src={device.externalIconUrl} alt=""/></div>
    : <div className="icon"><Icon symbol={device.icon}/></div>

type Construct = {
    presetService: PresetService
    device: StockDeviceMeta
    onCreate: () => void
    dropKind: Nullable<DeviceDropKind>
    onDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>>
    instrumentKey: Nullable<InstrumentFactories.Keys>
    lifecycle: Lifecycle
}

export const DeviceItem = ({
                               presetService, device, onCreate, dropKind, onDrop, instrumentKey, lifecycle
                           }: Construct): HTMLElement => {
    const item: HTMLElement = (
        <div className={className}>
            <DeviceIcon device={device}/>
            <span className="name">{device.name}</span>
            <span className="brief">{device.brief}</span>
        </div>
    )
    lifecycle.own(Events.subscribe(item, "dblclick", onCreate))
    if (dropKind === "audio-effect") {
        DragAndDrop.installSource(item, () => ({
            type: "audio-effect",
            uuids: null,
            device: device.key as EffectFactories.AudioEffectKeys
        } satisfies DragDevice))
    } else if (dropKind === "midi-effect") {
        DragAndDrop.installSource(item, () => ({
            type: "midi-effect",
            uuids: null,
            device: device.key as EffectFactories.MidiEffectKeys
        } satisfies DragDevice))
    } else {
        DragAndDrop.installSource(item, () => ({
            type: "instrument",
            device: device.key as InstrumentFactories.Keys
        } satisfies DragDevice))
    }
    const acceptsEffect = isDefined(dropKind) && isDefined(onDrop)
    const acceptsInstrument = isDefined(instrumentKey)
    const isRackIntentEffect = (dragData: AnyDragData): boolean =>
        (dragData.type === "audio-effect" || dragData.type === "midi-effect")
        && dragData.uuids !== null
        && isDefined(dragData.instrument)
    const isBareInstrument = (dragData: AnyDragData): boolean =>
        dragData.type === "instrument" && dragData.device === null && dragData.effects.length === 0
    if (acceptsEffect || acceptsInstrument) {
        DragAndDrop.installTarget(item, {
            drag: (_event, dragData) => {
                if (acceptsEffect && !isRackIntentEffect(dragData)) {
                    const effects = presetService.resolveEffectBoxesFromDrag(dropKind, dragData)
                    if (effects.length === 1 && EffectFactories.keyOfBox(effects[0]) === device.key) {
                        return true
                    }
                }
                if (acceptsInstrument && isBareInstrument(dragData)) {
                    return presetService.resolveDraggedInstrumentKey(dragData) === instrumentKey
                }
                return false
            },
            drop: (_event, dragData) => {
                if (acceptsEffect && !isRackIntentEffect(dragData)) {
                    const effects = presetService.resolveEffectBoxesFromDrag(dropKind, dragData)
                    if (effects.length === 1 && EffectFactories.keyOfBox(effects[0]) === device.key) {
                        onDrop(effects).catch(console.warn)
                        item.classList.remove("accept-drop")
                        return
                    }
                }
                if (acceptsInstrument && isBareInstrument(dragData)
                    && presetService.resolveDraggedInstrumentKey(dragData) === instrumentKey
                    && dragData.type === "instrument" && dragData.device === null) {
                    presetService.saveAsInstrumentPreset(instrumentKey, dragData.uuid).catch(console.warn)
                }
                item.classList.remove("accept-drop")
            },
            enter: allowDrop => item.classList.toggle("accept-drop", allowDrop),
            leave: () => item.classList.remove("accept-drop")
        })
    }
    return item
}

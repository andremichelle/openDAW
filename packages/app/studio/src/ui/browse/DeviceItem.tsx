import css from "./DeviceItem.sass?inline"
import {isDefined, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IndexedBox} from "@opendaw/lib-box"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {EffectFactories, PresetEntry} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData, DragDevice} from "@/ui/AnyDragData"
import {LibraryActions} from "@/ui/browse/LibraryActions"
import {PresetItems} from "@/ui/browse/PresetItem"
import {Icon} from "../components/Icon"

const className = Html.adoptStyleSheet(css, "DeviceItem")

export type StockDeviceMeta = {key: string, name: string, icon: IconSymbol, brief: string}
export type DeviceDropKind = "audio-effect" | "midi-effect"

type Construct = {
    actions: LibraryActions
    expandedKeys: Set<string>
    device: StockDeviceMeta
    presets: ReadonlyArray<PresetEntry>
    expandOnRender: boolean
    onCreate: () => void
    dropKind: Nullable<DeviceDropKind>
    onDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>>
    instrumentKey: Nullable<InstrumentFactories.Keys>
    expandKey: string
}

export const DeviceItem = ({
                               actions, expandedKeys, device, presets, expandOnRender,
                               onCreate, dropKind, onDrop, instrumentKey, expandKey
                           }: Construct): HTMLElement => {
    const empty = presets.length === 0
    const item: HTMLElement = <div className={Html.buildClassList(className, empty && "empty")}/>
    const triangle: HTMLElement = <span className="triangle"/>
    const header: HTMLElement = (
        <div className="device-header">
            {triangle}
            <div className="icon">
                <Icon symbol={device.icon}/>
            </div>
            <span className="name">{device.name}</span>
            <span className="brief">{device.brief}</span>
        </div>
    )
    const presetList: HTMLElement = <div className="preset-list hidden"/>
    presetList.append(...PresetItems(presets, actions))
    const shouldExpand = !empty && (expandedKeys.has(expandKey) || expandOnRender)
    if (shouldExpand) {
        presetList.classList.remove("hidden")
        item.classList.add("expanded")
    }
    triangle.onclick = (event: MouseEvent) => {
        event.stopPropagation()
        if (empty) {return}
        const open = !presetList.classList.toggle("hidden")
        item.classList.toggle("expanded", open)
        if (open) {expandedKeys.add(expandKey)} else {expandedKeys.delete(expandKey)}
    }
    header.onclick = () => onCreate()
    if (dropKind === "audio-effect") {
        DragAndDrop.installSource(header, () => ({
            type: "audio-effect",
            uuids: null,
            device: device.key as EffectFactories.AudioEffectKeys
        } satisfies DragDevice))
    } else if (dropKind === "midi-effect") {
        DragAndDrop.installSource(header, () => ({
            type: "midi-effect",
            uuids: null,
            device: device.key as EffectFactories.MidiEffectKeys
        } satisfies DragDevice))
    } else {
        DragAndDrop.installSource(header, () => ({
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
        DragAndDrop.installTarget(header, {
            drag: (_event, dragData) => {
                if (acceptsEffect && !isRackIntentEffect(dragData)) {
                    const effects = actions.resolveEffectBoxesFromDrag(dropKind, dragData)
                    if (effects.length === 1 && effects[0].name.replace(/DeviceBox$/, "") === device.key) {
                        return true
                    }
                }
                if (acceptsInstrument && isBareInstrument(dragData)) {
                    return actions.resolveDraggedInstrumentKey(dragData) === instrumentKey
                }
                return false
            },
            drop: (_event, dragData) => {
                if (acceptsEffect && !isRackIntentEffect(dragData)) {
                    const effects = actions.resolveEffectBoxesFromDrag(dropKind, dragData)
                    if (effects.length === 1 && effects[0].name.replace(/DeviceBox$/, "") === device.key) {
                        onDrop(effects).catch(console.warn)
                        header.classList.remove("accept-drop")
                        return
                    }
                }
                if (acceptsInstrument && isBareInstrument(dragData)
                    && actions.resolveDraggedInstrumentKey(dragData) === instrumentKey
                    && dragData.type === "instrument" && dragData.device === null) {
                    actions.saveAsInstrumentPreset(instrumentKey, dragData.uuid).catch(console.warn)
                }
                header.classList.remove("accept-drop")
            },
            enter: allowDrop => header.classList.toggle("accept-drop", allowDrop),
            leave: () => header.classList.remove("accept-drop")
        })
    }
    item.appendChild(header)
    item.appendChild(presetList)
    return item
}

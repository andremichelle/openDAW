import css from "./CompoundItem.sass?inline"
import {isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IndexedBox} from "@opendaw/lib-box"
import {PresetEntry} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
import {AnyDragData} from "@/ui/AnyDragData"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {LibraryActions} from "@/ui/browse/LibraryActions"
import {DeviceDropKind} from "@/ui/browse/DeviceItem"
import {PresetItems} from "@/ui/browse/PresetItem"
import {Icon} from "../components/Icon"

const className = Html.adoptStyleSheet(css, "CompoundItem")

type RackPayload = {instrumentUuid: UUID.String, effectUuids: ReadonlyArray<UUID.String>}

const rackPayload = (dragData: AnyDragData): Nullable<RackPayload> => {
    if (dragData.type === "instrument" && dragData.device === null) {
        return {instrumentUuid: dragData.uuid, effectUuids: dragData.effects}
    }
    if ((dragData.type === "audio-effect" || dragData.type === "midi-effect")
        && dragData.uuids !== null
        && isDefined(dragData.instrument)) {
        return {instrumentUuid: dragData.instrument, effectUuids: dragData.uuids}
    }
    return null
}

const isRackIntentEffect = (dragData: AnyDragData): boolean =>
    (dragData.type === "audio-effect" || dragData.type === "midi-effect")
    && dragData.uuids !== null
    && isDefined(dragData.instrument)

type Construct = {
    actions: LibraryActions
    expandedKeys: Set<string>
    label: string
    presets: ReadonlyArray<PresetEntry>
    expandOnRender: boolean
    dropKind: Nullable<DeviceDropKind>
    onDrop: Nullable<(effects: ReadonlyArray<IndexedBox>) => Promise<void>>
    onRackDrop: Nullable<(instrumentUuid: UUID.String, effectUuids: ReadonlyArray<UUID.String>) => Promise<void>>
    expandKey: string
}

export const CompoundItem = ({
                                 actions, expandedKeys, label, presets, expandOnRender,
                                 dropKind, onDrop, onRackDrop, expandKey
                             }: Construct): HTMLElement => {
    const empty = presets.length === 0
    const item: HTMLElement = <div className={Html.buildClassList(className, empty && "empty")}/>
    const header: HTMLElement = (
        <div className="compound-header">
            <span className="triangle"/>
            <div className="icon">
                <Icon symbol={IconSymbol.Cube}/>
            </div>
            <span className="name">{label}</span>
            <span className="brief"/>
        </div>
    )
    const presetList: HTMLElement = <div className="preset-list hidden"/>
    presetList.append(...PresetItems(presets, actions))
    const shouldExpand = !empty && (expandedKeys.has(expandKey) || expandOnRender)
    if (shouldExpand) {
        presetList.classList.remove("hidden")
        item.classList.add("expanded")
    }
    if (!empty) {
        header.onclick = () => {
            const open = !presetList.classList.toggle("hidden")
            item.classList.toggle("expanded", open)
            if (open) {expandedKeys.add(expandKey)} else {expandedKeys.delete(expandKey)}
        }
    }
    const acceptsEffectChain = isDefined(dropKind) && isDefined(onDrop)
    const acceptsRack = isDefined(onRackDrop)
    if (acceptsEffectChain || acceptsRack) {
        DragAndDrop.installTarget(header, {
            drag: (_event, dragData) => {
                if (acceptsEffectChain && !isRackIntentEffect(dragData)) {
                    if (actions.resolveEffectBoxesFromDrag(dropKind, dragData).length > 0) {return true}
                }
                if (acceptsRack && isDefined(rackPayload(dragData))) {return true}
                return false
            },
            drop: (_event, dragData) => {
                if (acceptsEffectChain && !isRackIntentEffect(dragData)) {
                    const effects = actions.resolveEffectBoxesFromDrag(dropKind, dragData)
                    if (effects.length > 0) {
                        onDrop(effects).catch(console.warn)
                        header.classList.remove("accept-drop")
                        return
                    }
                }
                if (acceptsRack) {
                    const payload = rackPayload(dragData)
                    if (isDefined(payload)) {
                        onRackDrop(payload.instrumentUuid, payload.effectUuids).catch(console.warn)
                    }
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

import css from "./MixerDeviceList.sass?inline"
import {DefaultObservableValue, int, Lifecycle, ObservableValue, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Html} from "@opendaw/lib-dom"
import {AudioUnitBoxAdapter, DeviceHost, EffectDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {Orientation, Scroller} from "@/ui/components/Scroller"
import {ScrollModel} from "@/ui/components/ScrollModel"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {DeviceDialog} from "@/ui/browse/DeviceDialog"
import {EffectDrop} from "@/ui/devices/EffectDrop"
import {MixerDeviceCell} from "@/ui/mixer/MixerDeviceCell"
import {MixerDeviceRows} from "@/ui/mixer/MixerDeviceRows"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "MixerDeviceList")

const AutoScrollMargin = 6

type Cell = { uuid: UUID.Bytes, element: HTMLElement, terminator: Terminator }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    unit: AudioUnitBoxAdapter
    kind: "midi" | "audio"
    collapsed: ObservableValue<boolean>
}

export const MixerDeviceList = ({lifecycle, service, unit, kind, collapsed}: Construct) => {
    const {project} = service
    const chain = DeviceHost.chainOf(unit, kind)
    const scroll: HTMLElement = <div className="scroll"/>
    const scrollModel = new ScrollModel()
    const count: HTMLElement = <div className="count"/>
    const add: HTMLElement = (
        <div className="add" onclick={() => {
            if (frozen.getValue()) {return}
            DeviceDialog.open(service, {
                type: "insert", host: unit, accepts: kind, index: chain.mapOr(collection => collection.adapters().length, 0)
            })
        }}>
            <Icon symbol={IconSymbol.Add}/>
        </div>
    )
    const element: HTMLElement = (
        <div className={Html.buildClassList(className, kind)} data-mixer-devices
             style={{"--max-device-rows": String(MixerDeviceRows.maxRowsOf(kind) - 1)}}>
            <div className="body">
                {scroll}
                <div className="scrollbar">
                    <Scroller lifecycle={lifecycle} model={scrollModel} orientation={Orientation.vertical}/>
                </div>
            </div>
            {add}
            {count}
        </div>
    )
    const frozen = new DefaultObservableValue(project.audioUnitFreeze.isFrozen(unit))
    const cells = UUID.newSet<Cell>(cell => cell.uuid)
    const takes = (): boolean => DeviceHost.takesEffect(unit, kind)
    const updateScroller = (): void => {
        scrollModel.visibleSize = scroll.clientHeight
        scrollModel.contentSize = scroll.scrollHeight
        element.classList.toggle("scrollable", scrollModel.scrollable())
    }
    const adapters = (): ReadonlyArray<EffectDeviceBoxAdapter> => chain.mapOr(collection => collection.adapters(), [])
    const updateTakes = (): void => {
        element.classList.toggle("refuses", !takes())
        element.classList.toggle("void", !takes() && adapters().length === 0)
    }
    const update = deferNextFrame(() => {
        const ordered = adapters()
        const alive = UUID.newSet<EffectDeviceBoxAdapter>(adapter => adapter.uuid)
        alive.addMany(ordered)
        cells.values().filter(cell => !alive.hasKey(cell.uuid)).forEach(cell => {
            cells.removeByKey(cell.uuid)
            cell.terminator.terminate()
            cell.element.remove()
        })
        ordered.forEach((adapter, index) => {
            const cell = cells.opt(adapter.uuid).unwrapOrElse(() => {
                const terminator = new Terminator()
                const created: Cell = {
                    uuid: adapter.uuid, terminator,
                    element: MixerDeviceCell({lifecycle: terminator, service, unit, adapter, frozen})
                }
                cells.add(created)
                return created
            })
            const current = scroll.children.item(index)
            if (current !== cell.element) {scroll.insertBefore(cell.element, current)}
        })
        count.textContent = String(ordered.length)
        element.classList.toggle("empty", ordered.length === 0)
        updateTakes()
        updateScroller()
    })
    const clearMarker = (): void => {
        scroll.classList.remove("insert-end")
        scroll.querySelectorAll(".insert-before").forEach(cell => cell.classList.remove("insert-before"))
    }
    const insertIndex = (event: DragEvent): int => collapsed.getValue()
        ? adapters().length
        : DragAndDrop.findInsertLocationVertical(event, scroll)[0]
    const accepted = (dragData: AnyDragData): Option<EffectDrop.Data> =>
        frozen.getValue() || !takes() ? Option.None : EffectDrop.asEffect(dragData, kind)
    lifecycle.ownAll(
        {terminate: () => cells.forEach(cell => cell.terminator.terminate())},
        update,
        chain.mapOr(collection => collection.catchupAndSubscribe({
            onAdd: () => update.request(), onRemove: () => update.request(), onReorder: () => update.request()
        }), Terminable.Empty),
        (() => {
            update.request()
            return Terminable.Empty
        })(),
        unit.input.catchupAndSubscribe(updateTakes),
        collapsed.catchupAndSubscribe(owner => element.classList.toggle("collapsed", owner.getValue())),
        frozen.catchupAndSubscribe(owner => element.classList.toggle("frozen", owner.getValue())),
        project.audioUnitFreeze.subscribe(uuid => {
            if (UUID.equals(uuid, unit.uuid)) {frozen.setValue(project.audioUnitFreeze.isFrozen(unit))}
        }),
        scrollModel.subscribe(() => scroll.scrollTop = scrollModel.position),
        Html.watchResize(scroll, updateScroller),
        TextTooltip.default(add, () => kind === "midi" ? "Add MIDI Effect" : "Add Audio Effect"),
        Events.subscribe(element, "wheel", (event: WheelEvent) => {
            if (!scrollModel.scrollable() || event.deltaY === 0) {return}
            event.preventDefault()
            scrollModel.moveBy(event.deltaY)
        }, {passive: false}),
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, dragData: AnyDragData): boolean => {
                clearMarker()
                if (accepted(dragData).isEmpty()) {return false}
                if (!collapsed.getValue()) {
                    const [, successor] = DragAndDrop.findInsertLocationVertical(event, scroll)
                    if (successor instanceof HTMLElement) {
                        successor.classList.add("insert-before")
                    } else {
                        scroll.classList.add("insert-end")
                    }
                    const {top, bottom} = scroll.getBoundingClientRect()
                    if (event.clientY < top + AutoScrollMargin) {
                        scrollModel.moveBy(-2)
                    } else if (event.clientY > bottom - AutoScrollMargin) {
                        scrollModel.moveBy(2)
                    }
                }
                return true
            },
            drop: (event: DragEvent, dragData: AnyDragData): void => {
                clearMarker()
                accepted(dragData).ifSome(effect => DeviceHost.chainFieldOf(unit, kind).ifSome(field =>
                    EffectDrop.apply(project, effect, field, insertIndex(event), DragAndDrop.isCopy(event, dragData))))
            },
            enter: () => {},
            leave: clearMarker
        })
    )
    return element
}

import css from "./ClipsArea.sass?inline"
import {
    clamp,
    int,
    isNotNull,
    Lifecycle,
    Option,
    quantizeFloor,
    RuntimeNotifier,
    Selection,
    Unhandled,
    ValueAxis
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {AnyClipBoxAdapter, ClipAdapters, isVertexOfBox, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ClipCaptureTarget, ClipCapturing} from "@/ui/timeline/tracks/audio-unit/clips/ClipCapturing.ts"
import {TimelineSelectableLocator} from "@/ui/timeline/TimelineSelectableLocator.ts"
import {createClipSelectableLocator} from "@/ui/timeline/tracks/audio-unit/clips/ClipSelectableLocator.ts"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {ClipMoveModifier} from "@/ui/timeline/tracks/audio-unit/clips/ClipMoveModifier.ts"
import {ClipWidth} from "@/ui/timeline/tracks/audio-unit/clips/constants.ts"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {installClipContextMenu} from "@/ui/timeline/tracks/audio-unit/clips/ClipContextMenu.ts"
import {PanelType} from "@/ui/workspace/PanelType"
import {ClipDragAndDrop} from "./ClipDragAndDrop.ts"
import {Dragging, Events, Html, Keyboard} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop.ts"
import {AnyDragData} from "@/ui/AnyDragData"
import {Dialogs} from "@/ui/components/dialogs"
import {ElementCapturing} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ClipsArea")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    manager: TracksManager
    scrollModel: ScrollModel
    scrollContainer: HTMLElement
}

export const ClipsArea = ({lifecycle, service, manager, scrollModel, scrollContainer}: Construct) => {
    const {project} = service
    const {selection, boxAdapters, editing, userEditingManager} = project
    const dropPreview: HTMLElement = (<div className="drop-target" tabIndex={-1}/>)
    const element: HTMLElement = (<div className={className} tabIndex={-1}>{dropPreview}</div>)
    const clipSelection: Selection<AnyClipBoxAdapter> = lifecycle.own(selection
        .createFilteredSelection(isVertexOfBox(UnionBoxTypes.isClipBox), {
            fx: (adapter: AnyClipBoxAdapter) => adapter.box,
            fy: vertex => ClipAdapters.for(boxAdapters, vertex.box)
        }))

    const capturing: ElementCapturing<ClipCaptureTarget> = ClipCapturing.create(element, manager)
    const locator: TimelineSelectableLocator<AnyClipBoxAdapter> = createClipSelectableLocator(capturing, manager)
    const dragAndDrop = new ClipDragAndDrop(service, capturing)
    element.appendChild(
        <SelectionRectangle
            lifecycle={lifecycle}
            locator={locator}
            selection={clipSelection}
            target={element}
            xAxis={{
                axisToValue: (axis: number): number => clamp(axis, 0, element.clientWidth),
                valueToAxis: (value: number): number => value
            }}
            yAxis={{
                axisToValue: (axis: number): number => clamp(axis + scrollContainer.scrollTop,
                    0, scrollContainer.scrollTop + element.scrollHeight),
                valueToAxis: (value: number): number => value - scrollContainer.scrollTop
            }}/>
    )
    const xAxis: ValueAxis = {
        valueToAxis: (index: int): number => index * ClipWidth + element.getBoundingClientRect().left,
        axisToValue: (axis: number): int => Math.floor(Math.max(0, axis - element.getBoundingClientRect().left) / ClipWidth)
    }
    const yAxis: ValueAxis = {
        valueToAxis: (index: int): number => manager.indexToGlobal(index),
        axisToValue: (axis: number): int => manager.globalToIndex(axis)
    }
    const {style} = dropPreview
    lifecycle.ownAll(
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                const option = dragAndDrop.canDrop(event, data)
                if (option.isEmpty()) {
                    style.display = "none"
                    return false
                }
                const type = option.unwrap()
                if (type === "instrument") {
                    style.display = "none"
                    return true
                }
                let x: number
                let y: number
                const target = capturing.captureEvent(event)
                if (isNotNull(target)) {
                    const trackBoxAdapter = target.track.trackBoxAdapter
                    if (target.type === "track") {
                        const clipIndex = target.clipIndex
                        x = clipIndex * ClipWidth
                    } else if (target.type === "clip") {
                        const clipIndex = target.clip.indexField.getValue()
                        x = clipIndex * ClipWidth
                    } else {
                        return Unhandled(target)
                    }
                    y = trackBoxAdapter.listIndex * ClipWidth - scrollContainer.scrollTop
                } else {
                    const rect = element.getBoundingClientRect()
                    x = quantizeFloor(event.clientX - rect.left, ClipWidth)
                    y = manager.tracksLocalBottom() - scrollContainer.scrollTop
                }
                style.transform = `translate(${x}px, ${y}px)`
                style.display = "block"
                return true
            },
            drop: (event: DragEvent, data: AnyDragData) => {
                style.display = "none"
                const dialog = Dialogs.processMonolog("Import Sample")
                dragAndDrop.drop(event, data).finally(() => dialog.close())
            },
            enter: (_allowDrop: boolean) => {},
            leave: () => style.display = "none"
        }),
        installAutoScroll(element, (_deltaX, deltaY) => {if (deltaY !== 0) {scrollModel.moveBy(deltaY)}}),
        clipSelection.catchupAndSubscribe({
            onSelected: (selectable: AnyClipBoxAdapter) => selectable.onSelected(),
            onDeselected: (selectable: AnyClipBoxAdapter) => selectable.onDeselected()
        }),
        Events.subscribeDblDwn(element, event => {
            const target = capturing.captureEvent(event)
            if (target === null) {return}
            if (target.type === "clip") {
                editing.modify(() => userEditingManager.timeline.edit(target.clip.box), false)
                service.panelLayout.showIfAvailable(PanelType.ContentEditor)
            } else if (target.type === "track") {
                editing.modify(() => {
                    const trackBoxAdapter = target.track.trackBoxAdapter
                    const clipIndex = target.clipIndex
                    switch (trackBoxAdapter.type) {
                        case TrackType.Audio:
                            RuntimeNotifier.info({
                                headline: "Cannot Create Audio Clip",
                                message: "Drag a sample from the sample-library or your hard-drive instead."
                            }).finally()
                            return
                        case TrackType.Notes:
                            return project.api.createNoteClip(trackBoxAdapter.box, clipIndex)
                        case TrackType.Value:
                            return project.api.createValueClip(trackBoxAdapter.box, clipIndex)
                        default:
                            return
                    }
                })
            }
        }),
        Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
            if (Keyboard.isDeselectAll(event)) {
                clipSelection.deselectAll()
            } else if (Keyboard.isSelectAll(event)) {
                clipSelection.select(...manager.tracks()
                    .flatMap(({trackBoxAdapter: {clips}}) => clips.collection.adapters()))
            } else if (Keyboard.isDelete(event)) {
                editing.modify(() => clipSelection.selected()
                    .forEach(clip => clip.box.delete()))
            }
        }),
        installClipContextMenu({element, project, capturing, selection: clipSelection}),
        Dragging.attach(element, event => {
            const target = capturing.captureEvent(event)
            if (target === null) {return Option.None}
            return manager.startClipModifier(ClipMoveModifier.start({
                project,
                manager,
                selection: clipSelection,
                xAxis,
                yAxis,
                pointerClipIndex: xAxis.axisToValue(event.clientX),
                pointerTrackIndex: yAxis.axisToValue(event.clientY)
            }))
        })
    )
    return element
}
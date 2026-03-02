import css from "./RegionsArea.sass?inline"
import {clamp, DefaultObservableValue, EmptyExec, Lifecycle, Nullable, Option, Unhandled} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CutCursor} from "@/ui/timeline/CutCursor.tsx"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {Config} from "@/ui/timeline/Config.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {AnyRegionBoxAdapter, RegionEditing} from "@opendaw/studio-adapters"
import {createRegionLocator} from "@/ui/timeline/tracks/audio-unit/regions/RegionSelectionLocator.ts"
import {installRegionContextMenu} from "@/ui/timeline/tracks/audio-unit/regions/RegionContextMenu.ts"
import {RegionCaptureTarget, RegionCapturing} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {StudioService} from "@/service/StudioService.ts"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {Cursor} from "@/ui/Cursors.ts"
import {CursorEvent, installCursor} from "@/ui/hooks/cursor.ts"
import {RegionStartModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionStartModifier.ts"
import {RegionDurationModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionDurationModifier.ts"
import {RegionMoveModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionMoveModifier.ts"
import {RegionLoopDurationModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionLoopDurationModifier.ts"
import {RegionContentStartModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionContentStartModifier.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {RegionDragAndDrop} from "@/ui/timeline/tracks/audio-unit/regions/RegionDragAndDrop.ts"
import {PanelType} from "@/ui/workspace/PanelType.ts"
import {CssUtils, Dragging, Events, Html, Keyboard, ShortcutManager} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {Dialogs} from "@/ui/components/dialogs"
import {ClipboardManager, ElementCapturing, RegionsClipboard, TimelineRange} from "@opendaw/studio-core"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"

const className = Html.adoptStyleSheet(css, "RegionsArea")

const CursorMap = Object.freeze({
    "position": "auto",
    "start": Cursor.LoopStart,
    "complete": Cursor.LoopEnd,
    "loop-duration": Cursor.ExpandWidth,
    "content-start": Cursor.ExpandWidth,
    "content-complete": Cursor.ExpandWidth,
    "fading-in": "ew-resize",
    "fading-out": "ew-resize"
}) satisfies Record<string, CssUtils.Cursor | Cursor>

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    manager: TracksManager
    scrollModel: ScrollModel
    scrollContainer: HTMLElement
    range: TimelineRange
}

export const RegionsArea = ({lifecycle, service, manager, scrollModel, scrollContainer, range}: Construct) => {
    const {project, timeline} = service
    const {snapping} = timeline
    const {selection, regionSelection, editing, boxAdapters, timelineBox, userEditingManager} = project
    const markerPosition = lifecycle.own(new DefaultObservableValue<Nullable<ppqn>>(null))
    const element: HTMLElement = (
        <div className={className} tabIndex={-1} data-scope="regions">
            <CutCursor lifecycle={lifecycle} position={markerPosition} range={range}/>
        </div>
    )
    const capturing: ElementCapturing<RegionCaptureTarget> = RegionCapturing.create(element, manager, range, project.audioUnitFreeze)
    const {audioUnitFreeze} = project
    const regionLocator = createRegionLocator(manager, range, regionSelection, audioUnitFreeze)
    const dragAndDrop = new RegionDragAndDrop(service, capturing, timeline.snapping)
    const shortcuts = ShortcutManager.get().createContext(element, "Regions")
    const {engine, boxGraph, overlapResolver, timelineFocus} = project
    const clipboardHandler = RegionsClipboard.createHandler({
        getEnabled: () => !engine.isPlaying.getValue(),
        getPosition: () => engine.position.getValue(),
        setPosition: position => engine.setPosition(position),
        editing,
        selection: regionSelection,
        boxGraph,
        boxAdapters,
        getTracks: () => manager.tracks().map(track => track.trackBoxAdapter),
        getFocusedTrack: () => timelineFocus.track,
        overlapResolver
    })

    lifecycle.ownAll(
        regionSelection.catchupAndSubscribe({
            onSelected: (selectable: AnyRegionBoxAdapter) => selectable.onSelected(),
            onDeselected: (selectable: AnyRegionBoxAdapter) => selectable.onDeselected()
        }),
        shortcuts,
        ClipboardManager.install(element, clipboardHandler),
        shortcuts.register(RegionsShortcuts["select-all"].shortcut, () => {
            regionSelection.select(...manager.tracks()
                .filter(track => !audioUnitFreeze.isFrozen(track.audioUnitBoxAdapter))
                .flatMap(({trackBoxAdapter: {regions}}) => regions.collection.asArray()))
        }),
        shortcuts.register(RegionsShortcuts["deselect-all"].shortcut, () => regionSelection.deselectAll()),
        shortcuts.register(RegionsShortcuts["delete-selection"].shortcut, () => {
            const selected = regionSelection.selected()
            if (selected.length === 0) {return false}
            editing.modify(() => selected.forEach(region => region.box.delete()))
            return true
        }),
        shortcuts.register(RegionsShortcuts["toggle-mute"].shortcut, () => {
            const selected = regionSelection.selected()
            if (selected.length === 0) {return false}
            editing.modify(() => selected.forEach(({box: {mute}}) => mute.toggle()))
            return true
        }),
        installRegionContextMenu({timelineBox, element, service, capturing, selection: regionSelection, range}),
        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            const target = capturing.captureEvent(event)
            timelineFocus.clear()
            if (target === null) {return}
            if (target.type === "region") {
                timelineFocus.focusRegion(target.region)
            } else if (target.type === "track") {
                timelineFocus.focusTrack(target.track.trackBoxAdapter)
            }
        }),
        Events.subscribeDblDwn(element, event => {
            const target = capturing.captureEvent(event)
            if (target === null) {return}
            if (target?.type === "region") {
                editing.modify(() => {
                    userEditingManager.timeline.edit(target.region.box)
                    service.panelLayout.showIfAvailable(PanelType.ContentEditor)
                })
            } else if (target.type === "track") {
                if (audioUnitFreeze.isFrozen(target.track.audioUnitBoxAdapter)) {return}
                const {trackBoxAdapter} = target.track
                const x = event.clientX - element.getBoundingClientRect().left
                let {position, complete} = snapping.xToBarInterval(x)
                position = Math.max(position,
                    (trackBoxAdapter.regions.collection
                        .lowerEqual(position)?.complete ?? Number.NEGATIVE_INFINITY))
                complete = Math.min(complete,
                    (trackBoxAdapter.regions.collection
                        .greaterEqual(position + 1)?.position ?? Number.POSITIVE_INFINITY))
                if (complete <= position) {return}
                editing.modify(() => project.api.createTrackRegion(trackBoxAdapter.box, position, complete - position)
                    .ifSome(region => selection.select(region)))
            }
        }),
        Dragging.attach(element, (event: PointerEvent) => {
            const target = capturing.captureEvent(event)
            if (target === null) {
                if (Keyboard.isControlKey(event)) {
                    const trackIndex = manager.globalToIndex(event.clientY)
                    if (trackIndex === manager.numTracks()) {return Option.None}
                    return Option.wrap({
                        update: EmptyExec // TODO Create Region
                    })
                } else {
                    return Option.None
                }
            } else if (target.type === "region" && event.altKey) {
                if (!regionSelection.isSelected(target.region)) {
                    regionSelection.deselectAll()
                    regionSelection.select(target.region)
                }
                const clientRect = element.getBoundingClientRect()
                const pointerPulse = snapping.xToUnitRound(event.clientX - clientRect.left)
                editing.modify(() => regionSelection.selected()
                    .slice()
                    .forEach(region => RegionEditing.cut(region, pointerPulse, !event.shiftKey)))
                return Option.wrap({update: EmptyExec}) // prevent selection or tools
            }
            return Option.None
        })
    )
    element.appendChild(
        <SelectionRectangle target={element}
                            lifecycle={lifecycle}
                            selection={regionSelection}
                            locator={regionLocator}
                            xAxis={range.valueAxis}
                            yAxis={{
                                axisToValue: y => clamp(y + scrollContainer.scrollTop,
                                    0, scrollContainer.scrollTop + element.scrollHeight),
                                valueToAxis: value => value - scrollContainer.scrollTop
                            }}/>
    )
    lifecycle.ownAll(
        installAutoScroll(element, (deltaX, deltaY) => {
            if (deltaY !== 0) {scrollModel.moveBy(deltaY)}
            if (deltaX !== 0) {range.moveUnitBy(deltaX * range.unitsPerPixel * Config.AutoScrollHorizontalSpeed)}
        }, {
            measure: () => {
                const {left, right} = element.getBoundingClientRect()
                const {top, bottom} = scrollContainer.getBoundingClientRect()
                return ({xMin: left, xMax: right, yMin: top, yMax: bottom})
            }, padding: Config.AutoScrollPadding
        }),
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                const option = dragAndDrop.canDrop(event, data)
                if (option.isEmpty()) {
                    markerPosition.setValue(null)
                    return false
                }
                if (data.type === "instrument") {
                    markerPosition.setValue(null)
                    return true
                }
                const rect = element.getBoundingClientRect()
                const position = snapping.xToUnitFloor(event.clientX - rect.left)
                markerPosition.setValue(Math.max(0, position))
                return true
            },
            drop: (event: DragEvent, data: AnyDragData) => {
                const dialog = Dialogs.processMonolog("Import Sample")
                dragAndDrop.drop(event, data).finally(() => dialog.close())
            },
            enter: (_allowDrop: boolean) => {},
            leave: () => markerPosition.setValue(null)
        }),
        Events.subscribe(element, "wheel", (event: WheelEvent) => {
            if (event.shiftKey) {
                event.preventDefault()
                event.stopPropagation()
                const scale = event.deltaY * 0.01
                const rect = element.getBoundingClientRect()
                range.scaleBy(scale, range.xToValue(event.clientX - rect.left))
            } else if (event.altKey) {
                event.preventDefault()
                event.stopPropagation()
                range.moveUnitBy(Math.sign(event.deltaY) * PPQN.SemiQuaver * 2)
            } else {
                const deltaX = event.deltaX
                const threshold = 5.0
                const clamped = Math.max(deltaX - threshold, 0.0) + Math.min(deltaX + threshold, 0.0)
                if (Math.abs(clamped) > 0) {
                    event.preventDefault()
                    range.moveBy(clamped * 0.0003)
                }
            }
        }, {passive: false}),
        installCursor(element, capturing, {
            get: (target: Nullable<RegionCaptureTarget>, event: CursorEvent) => {
                const units = snapping.xToUnitRound(event.clientX - element.getBoundingClientRect().left)
                markerPosition.setValue(
                    event.altKey && target !== null && target.type === "region"
                    && target.region.position < units && units < target.region.complete
                        ? units
                        : null)
                return target === null || target.type === "track"
                    ? null
                    : event.altKey
                        ? Cursor.Scissors
                        : CursorMap[target.part]
            },
            leave: () => markerPosition.setValue(null)
        }),
        Dragging.attach(element, (event: PointerEvent) => {
                const target: Nullable<RegionCaptureTarget> = capturing.captureEvent(event)
                if (target === null || target.type !== "region") {return Option.None}
                const clientRect = element.getBoundingClientRect()
                const pointerPulse = range.xToUnit(event.clientX - clientRect.left)
                const reference = target.region
                switch (target.part) {
                    case "start":
                        return manager.startRegionModifier(RegionStartModifier.create(regionSelection.selected(),
                            {project, element, snapping, pointerPulse, reference}))
                    case "complete":
                        return manager.startRegionModifier(RegionDurationModifier.create(regionSelection.selected(),
                            {project, element, snapping, pointerPulse, bounds: [reference.position, reference.complete]}))
                    case "position":
                        const pointerIndex = manager.globalToIndex(event.clientY)
                        return manager.startRegionModifier(RegionMoveModifier.create(manager, regionSelection,
                            {element, snapping, pointerPulse, pointerIndex, reference}))
                    case "content-start":
                        return manager.startRegionModifier(RegionContentStartModifier.create(regionSelection.selected(),
                            {project, element, snapping, pointerPulse, reference}))
                    case "loop-duration":
                    case "content-complete":
                        return manager.startRegionModifier(RegionLoopDurationModifier.create(regionSelection.selected(),
                            {
                                project, element, snapping, pointerPulse, reference,
                                resize: target.part === "content-complete"
                            }))
                    case "fading-in":
                    case "fading-out": {
                        const audioRegion = target.region
                        const isFadeIn = target.part === "fading-in"
                        const {position, duration, complete, fading} = audioRegion
                        if (event.shiftKey) {
                            const slopeField = isFadeIn ? fading.inSlopeField : fading.outSlopeField
                            const originalSlope = slopeField.getValue()
                            const startY = event.clientY
                            return Option.wrap({
                                update: (dragEvent: Dragging.Event) => {
                                    const deltaY = startY - dragEvent.clientY
                                    const newSlope = clamp(originalSlope + deltaY * 0.01, 0.001, 0.999)
                                    editing.modify(() => slopeField.setValue(newSlope), false)
                                },
                                approve: () => editing.mark(),
                                cancel: () => editing.modify(() => slopeField.setValue(originalSlope))
                            } satisfies Dragging.Process)
                        }
                        const originalFadeIn = fading.in
                        const originalFadeOut = fading.out
                        return Option.wrap({
                            update: (dragEvent: Dragging.Event) => {
                                const pointerPpqn = range.xToUnit(dragEvent.clientX - clientRect.left)
                                editing.modify(() => {
                                    if (isFadeIn) {
                                        const newFadeIn = clamp(pointerPpqn - position, 0, duration)
                                        fading.inField.setValue(newFadeIn)
                                        if (newFadeIn + fading.out > duration) {
                                            fading.outField.setValue(duration - newFadeIn)
                                        }
                                    } else {
                                        const newFadeOut = clamp(complete - pointerPpqn, 0, duration)
                                        fading.outField.setValue(newFadeOut)
                                        if (fading.in + newFadeOut > duration) {
                                            fading.inField.setValue(duration - newFadeOut)
                                        }
                                    }
                                }, false)
                            },
                            approve: () => editing.mark(),
                            cancel: () => editing.modify(() => {
                                fading.inField.setValue(originalFadeIn)
                                fading.outField.setValue(originalFadeOut)
                            })
                        } satisfies Dragging.Process)
                    }
                    default: {
                        return Unhandled(target)
                    }
                }
            }, {permanentUpdates: true}
        )
    )
    return element
}
import css from "./RegionsArea.sass?inline"
import {TourAnchors} from "@/ui/tour/TourAnchors"
import {firstTrackRect} from "@/ui/timeline/tracks/audio-unit/FirstTrackRect"
import {
    clamp,
    DefaultObservableValue,
    EmptyExec,
    isDefined,
    isInstanceOf,
    Lifecycle,
    Nullable,
    Option,
    Unhandled
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CutCursor} from "@/ui/timeline/CutCursor.tsx"
import {ppqn} from "@opendaw/lib-dsp"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {Config} from "@/ui/timeline/Config.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {AnyRegionBoxAdapter, AudioRegionBoxAdapter, RegionEditing, TrackType} from "@opendaw/studio-adapters"
import {createRegionLocator} from "@/ui/timeline/tracks/audio-unit/regions/RegionSelectionLocator.ts"
import {installRegionContextMenu, loopRegionSelection} from "@/ui/timeline/tracks/audio-unit/regions/RegionContextMenu.ts"
import {RegionCaptureTarget, RegionCapturing} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {duplicateSelectedRegions} from "./duplicateSelectedRegions"
import {StudioService} from "@/service/StudioService.ts"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle.tsx"
import {Cursor} from "@/ui/Cursors.ts"
import {CursorEvent, installCursor} from "@/ui/hooks/cursor.ts"
import {RegionStartModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionStartModifier.ts"
import {RegionDurationModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionDurationModifier.ts"
import {RegionMoveModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionMoveModifier.ts"
import {RegionLoopDurationModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionLoopDurationModifier.ts"
import {RegionContentStartModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionContentStartModifier.ts"
import {AudioFadeCurveDrag} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeCurveDrag.ts"
import {AudioFadeLengthDrag} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeLengthDrag.ts"
import {AudioFadeHandles} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeHandles.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {RegionDragAndDrop} from "@/ui/timeline/tracks/audio-unit/regions/RegionDragAndDrop.ts"
import {PanelType} from "@/ui/workspace/PanelType.ts"
import {CssUtils, Dragging, Events, Html, Keyboard, ShortcutManager} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {Layers} from "@/ui/surface/Layers"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {AnyDragData} from "@/ui/AnyDragData"
import {Dialogs} from "@/ui/components/dialogs"
import {ClipboardManager, ElementCapturing, RegionsClipboard, StudioPreferences, TimelineRange} from "@opendaw/studio-core"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {moveByWheelPixels} from "@/ui/timeline/editors/WheelScroll"

const className = Html.adoptStyleSheet(css, "RegionsArea")

const CursorMap = Object.freeze({
    "position": "auto",
    "start": Cursor.LoopStart,
    "complete": Cursor.LoopEnd,
    "loop-duration": Cursor.ExpandWidth,
    "content-start": Cursor.ExpandWidth,
    "fading-in": "ew-resize",
    "fading-out": "ew-resize",
    "fading-in-slope": AudioFadeHandles.SlopeOnCenterAxis ? "ns-resize" : "move",
    "fading-out-slope": AudioFadeHandles.SlopeOnCenterAxis ? "ns-resize" : "move"
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
    const {
        selection,
        regionSelection,
        editing,
        boxAdapters,
        timelineBox,
        userEditingManager
    } = project
    const markerPosition = lifecycle.own(new DefaultObservableValue<Nullable<ppqn>>(null))
    const element: HTMLElement = (
        <div className={className} tabIndex={-1} data-scope="regions">
            <CutCursor lifecycle={lifecycle} position={markerPosition} range={range}/>
        </div>
    )
    TourAnchors.registerRect(lifecycle, element, () => firstTrackRect(element, manager), "regions")
    const capturing: ElementCapturing<RegionCaptureTarget> = RegionCapturing.create(element, manager, range, project.audioUnitFreeze)
    const {audioUnitFreeze} = project
    const regionLocator = createRegionLocator(manager, range, regionSelection, audioUnitFreeze)
    const dragAndDrop = new RegionDragAndDrop(service, capturing, timeline.snapping)
    const shortcuts = ShortcutManager.get().createContext(element, "Regions", 1)
    const {engine, boxGraph, overlapResolver, trackFocus} = project
    const clipboardHandler = RegionsClipboard.createHandler({
        getEnabled: () => !engine.isPlaying.getValue(),
        getPosition: () => engine.position.getValue(),
        setPosition: position => engine.setPosition(position),
        editing,
        selection: regionSelection,
        boxGraph,
        boxAdapters,
        getTracks: () => manager.tracks().map(track => track.trackBoxAdapter),
        getFocusedTrack: () => trackFocus.track,
        overlapResolver
    })

    const pointer = {clientX: 0, clientY: 0, inside: false}
    let fadeDragging = false
    const hoverAudioRegion = (target: Nullable<RegionCaptureTarget>, clientX: number) => {
        if (fadeDragging) {return}
        const unit = range.xToUnit(clientX - element.getBoundingClientRect().left)
        const region = isDefined(target) && target.type === "region" ? target.region : null
        manager.hoveredAudioRegion.wrap(isInstanceOf(region, AudioRegionBoxAdapter)
            && region.position <= unit && unit < region.complete ? region : null)
    }
    const fadeHandleOf = (target: Nullable<RegionCaptureTarget>): Nullable<{ region: AudioRegionBoxAdapter, part: AudioFadeHandles.Part }> => {
        if (!isDefined(target) || target.type !== "region") {return null}
        switch (target.part) {
            case "fading-in":
            case "fading-in-slope":
            case "fading-out":
            case "fading-out-slope":
                return {region: target.region, part: target.part}
            default:
                return null
        }
    }
    const fadeHover: { handle: Nullable<{ region: AudioRegionBoxAdapter, part: AudioFadeHandles.Part }> } = {handle: null}
    const showFadeValue = (region: AudioRegionBoxAdapter, part: AudioFadeHandles.Part): void => {
        const layers = Layers.get(element)
        layers.textTooltip.forceHide()
        layers.valueTooltip.show(() => ({
            ...AudioFadeHandles.printValue(region, part), clientX: pointer.clientX + 12, clientY: pointer.clientY + 16
        }))
    }
    // as a knob: the value shows while the pointer rests on a fade handle and stays through its drag
    const hoverFadeHandle = (target: Nullable<RegionCaptureTarget>): void => {
        if (fadeDragging) {return}
        const handle = fadeHandleOf(target)
        const current = fadeHover.handle
        if (handle?.region === current?.region && handle?.part === current?.part) {return}
        fadeHover.handle = handle
        if (isDefined(handle)) {showFadeValue(handle.region, handle.part)} else {Layers.get(element).valueTooltip.hide()}
    }
    const holdFadeHover = (process: Dragging.Process, region: AudioRegionBoxAdapter,
                           part: AudioFadeHandles.Part): Option<Dragging.Process> => {
        fadeDragging = true
        fadeHover.handle = {region, part}
        showFadeValue(region, part)
        return Option.wrap({
            ...process,
            update: event => {
                process.update(event)
                pointer.clientX = event.clientX
                pointer.clientY = event.clientY
            },
            finally: () => {
                fadeDragging = false
                if (pointer.inside) {
                    const target = capturing.capturePoint(pointer.clientX, pointer.clientY)
                    hoverAudioRegion(target, pointer.clientX)
                    hoverFadeHandle(target)
                } else {
                    manager.hoveredAudioRegion.clear()
                    hoverFadeHandle(null)
                }
            }
        })
    }
    const emptyLaneHint = () => ({
        clientX: pointer.clientX + 8, clientY: pointer.clientY + 16, text: "Double-click to create a note-region"
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
                .filter(track => !track.audioUnitBoxAdapter.mapOr(unit => audioUnitFreeze.isFrozen(unit), false))
                .flatMap(({trackBoxAdapter: {regions}}) => regions.collection.asArray()))
        }),
        shortcuts.register(RegionsShortcuts["duplicate-regions"].shortcut, () => {
            duplicateSelectedRegions(project)
            return true
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
        shortcuts.register(RegionsShortcuts["loop-selection"].shortcut, () =>
            loopRegionSelection(editing, timelineBox, regionSelection)),
        shortcuts.register(RegionsShortcuts["snapping-finer"].shortcut, () => snapping.stepFiner(), {allowRepeat: true}),
        shortcuts.register(RegionsShortcuts["snapping-coarser"].shortcut, () => snapping.stepCoarser(), {allowRepeat: true}),
        installRegionContextMenu({timelineBox, element, service, capturing, selection: regionSelection, range}),
        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            const target = capturing.captureEvent(event)
            trackFocus.clear()
            if (target === null) {return}
            if (target.type === "region") {
                target.region.trackBoxAdapter.ifSome(track => trackFocus.focus(track))
                const optDeviceChain = target.region.trackBoxAdapter
                    .flatMap(track => track.optAudioUnit)
                    .map(unit => unit.editing)
                const switchDeviceChain = optDeviceChain
                    .mapOr(vertex => !userEditingManager.audioUnit.isEditing(vertex), false)
                // If the ContentEditor panel is open, clicking a region
                // (whether already selected or not) brings it into
                // edit-mode. No-op when that region is already the
                // current edit target.
                const switchRegion = service.panelLayout.getByType(PanelType.ContentEditor).isVisible
                    && !userEditingManager.timeline.isEditing(target.region.box)
                if (switchDeviceChain || switchRegion) {
                    // Sealed into its own history entry: the edit pointers write unmarked, and a leftover
                    // unmarked pending is folded into the NEXT marked modify, so an unsealed switch rides along
                    // with whatever the user edits next and undoing that edit jumps region and device chain back.
                    editing.modify(() => {
                        if (switchDeviceChain) {userEditingManager.audioUnit.edit(optDeviceChain.unwrap("editing"))}
                        if (switchRegion) {userEditingManager.timeline.edit(target.region.box)}
                    })
                }
            } else if (target.type === "track") {
                trackFocus.focus(target.track.trackBoxAdapter)
            }
        }),
        Events.subscribe(element, "pointermove", (event: PointerEvent) => {
            pointer.clientX = event.clientX
            pointer.clientY = event.clientY
            pointer.inside = true
            const target = capturing.captureEvent(event)
            hoverAudioRegion(target, event.clientX)
            if (fadeDragging) {return}
            hoverFadeHandle(target)
            const tooltip = Layers.get(element).textTooltip
            if (TextTooltip.enabled && StudioPreferences.settings.visibility["visible-help-hints"] && target?.type === "track" && target.track.trackBoxAdapter.type === TrackType.Notes
                && target.track.trackBoxAdapter.regions.collection.length() === 0) {
                tooltip.show(emptyLaneHint)
            } else {
                tooltip.hide()
            }
        }),
        Events.subscribe(element, "pointerleave", () => {
            pointer.inside = false
            if (!fadeDragging) {manager.hoveredAudioRegion.clear()}
            hoverFadeHandle(null)
            Layers.get(element).textTooltip.hide()
        }),
        Events.subscribe(scrollContainer, "scroll", () => {
            if (!pointer.inside) {return}
            const {clientX, clientY} = pointer
            hoverAudioRegion(capturing.capturePoint(clientX, clientY), clientX)
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
                if (target.track.audioUnitBoxAdapter.mapOr(unit => audioUnitFreeze.isFrozen(unit), false)) {return}
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
                    .ifSome(region => {
                        selection.select(region)
                        userEditingManager.timeline.edit(region)
                        service.panelLayout.showIfAvailable(PanelType.ContentEditor)
                    }))
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
                            }}
        />
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
            }, padding: Config.AutoScrollPadding, dragPadding: Config.AutoScrollDragPadding
        }),
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                const option = dragAndDrop.canDrop(event, data)
                if (option.isEmpty()) {
                    markerPosition.setValue(null)
                    return false
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
                WheelScaling.apply(element, range, event)
            } else if (event.altKey) {
                event.preventDefault()
                event.stopPropagation()
                moveByWheelPixels(range, event)
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
                        return manager.startRegionModifier(RegionLoopDurationModifier.create(regionSelection.selected(),
                            {project, element, snapping, pointerPulse, reference}))
                    case "fading-in":
                    case "fading-in-slope":
                    case "fading-out-slope":
                    case "fading-out": {
                        const {region: audioRegion, track} = target
                        const isFadeIn = target.part === "fading-in" || target.part === "fading-in-slope"
                        const {duration, fading} = audioRegion
                        const slopeHandle = target.part === "fading-in-slope" || target.part === "fading-out-slope"
                        if (slopeHandle) {
                            const startX = event.clientX, startY = event.clientY
                            const fadeLength = (isFadeIn ? fading.in : fading.out) * AudioFadeHandles.scale(fading, duration)
                            const fadeWidth = Math.abs(range.unitToX(audioRegion.position + fadeLength)
                                - range.unitToX(audioRegion.position))
                            const drag = AudioFadeCurveDrag.create(audioRegion, isFadeIn, fadeWidth, track.size, editing)
                            return holdFadeHover({
                                update: dragEvent => drag.update(
                                    dragEvent.clientX - startX, dragEvent.clientY - startY, dragEvent.shiftKey),
                                approve: () => drag.approve(),
                                cancel: () => drag.cancel()
                            }, audioRegion, target.part)
                        }
                        const startPointer = range.xToUnit(event.clientX - clientRect.left)
                        const drag = AudioFadeLengthDrag.create(fading, duration, isFadeIn, startPointer, editing)
                        return holdFadeHover({
                            update: (dragEvent: Dragging.Event) =>
                                drag.update(range.xToUnit(dragEvent.clientX - clientRect.left), dragEvent.shiftKey),
                            approve: () => drag.approve(),
                            cancel: () => drag.cancel()
                        }, audioRegion, target.part)
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
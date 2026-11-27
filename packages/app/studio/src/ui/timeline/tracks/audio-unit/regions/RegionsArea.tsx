import {installTimelineClickSeeking} from "@/ui/timeline/TimelineClickSeeking"
import css from "./RegionsArea.sass?inline"
import {TourAnchors} from "@/ui/tour/TourAnchors"
import {firstTrackRect} from "@/ui/timeline/tracks/audio-unit/FirstTrackRect"
import {DefaultObservableValue, Lifecycle, Nullable, Terminator} from "@opendaw/lib-std"
import {TimeSelectionOverlay} from "@/ui/timeline/tracks/audio-unit/regions/TimeSelectionOverlay"
import {RegionPointerTool} from "@/ui/timeline/tracks/audio-unit/regions/RegionPointerTool"
import {TimeSelectionTool} from "@/ui/timeline/tracks/audio-unit/regions/TimeSelectionTool"
import {RegionsToolContext} from "@/ui/timeline/tracks/audio-unit/regions/RegionsToolContext"
import {createElement} from "@opendaw/lib-jsx"
import {CutCursor} from "@/ui/timeline/CutCursor.tsx"
import {ppqn} from "@opendaw/lib-dsp"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {Config} from "@/ui/timeline/Config.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {AnyRegionBoxAdapter} from "@opendaw/studio-adapters"
import {createRegionLocator} from "@/ui/timeline/tracks/audio-unit/regions/RegionSelectionLocator.ts"
import {RegionCaptureTarget, RegionCapturing} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {StudioService} from "@/service/StudioService.ts"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {RegionDragAndDrop} from "@/ui/timeline/tracks/audio-unit/regions/RegionDragAndDrop.ts"
import {Events, Html, ShortcutManager} from "@opendaw/lib-dom"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {WheelAxis} from "@/ui/timeline/WheelAxis"
import {Dialogs} from "@/ui/components/dialogs"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"
import {WheelScaling} from "@/ui/timeline/WheelScaling"
import {moveByWheelPixels} from "@/ui/timeline/editors/WheelScroll"
import {AudioReversals} from "@/service/AudioReversals"

const className = Html.adoptStyleSheet(css, "RegionsArea")

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
    const {snapping, tool, timeSelection} = timeline
    const {regionSelection, audioUnitFreeze} = project
    const markerPosition = lifecycle.own(new DefaultObservableValue<Nullable<ppqn>>(null))
    const element: HTMLElement = (
        <div className={className} tabIndex={-1} data-scope="regions">
            <CutCursor lifecycle={lifecycle} position={markerPosition} range={range}/>
            <TimeSelectionOverlay lifecycle={lifecycle} manager={manager} range={range}
                                  scrollContainer={scrollContainer} selection={timeSelection}/>
        </div>
    )
    TourAnchors.registerRect(lifecycle, element, () => firstTrackRect(element, manager), "regions")
    const capturing: ElementCapturing<RegionCaptureTarget> = RegionCapturing.create(element, manager, range, audioUnitFreeze)
    const regionLocator = createRegionLocator(manager, range, regionSelection, audioUnitFreeze)
    const dragAndDrop = new RegionDragAndDrop(service, capturing, timeline.snapping)
    const shortcuts = ShortcutManager.get().createContext(element, "Regions")
    const context: RegionsToolContext = {service, manager, scrollContainer, range, element, capturing, regionLocator, shortcuts, markerPosition}
    const toolLifecycle = lifecycle.own(new Terminator())
    lifecycle.own({terminate: () => timeSelection.clear()})
    lifecycle.ownAll(
        installTimelineClickSeeking(element, x =>
            engine.setPosition(snapping.round(Math.max(0, range.xToUnit(x)))),
            () => !engine.isPlaying.getValue()),
        regionSelection.catchupAndSubscribe({
            onSelected: (selectable: AnyRegionBoxAdapter) => selectable.onSelected(),
            onDeselected: (selectable: AnyRegionBoxAdapter) => selectable.onDeselected()
        }),
        shortcuts,
        shortcuts.register(RegionsShortcuts["reverse-audio"].shortcut,
            () => AudioReversals.reverseSelection(service, regionSelection.selected())),
        shortcuts.register(RegionsShortcuts["snapping-finer"].shortcut, () => snapping.stepFiner(), {allowRepeat: true}),
        shortcuts.register(RegionsShortcuts["snapping-coarser"].shortcut, () => snapping.stepCoarser(), {allowRepeat: true}),
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
            if (event.ctrlKey || event.shiftKey) {
                event.preventDefault()
                event.stopPropagation()
                WheelScaling.apply(element, range, event)
            } else if (event.altKey) {
                event.preventDefault()
                event.stopPropagation()
                moveByWheelPixels(range, event)
            } else {
                if (WheelAxis.of(event) === "horizontal") {
                    event.preventDefault()
                    event.stopPropagation()
                    range.moveBy(event.deltaX * 0.0003)
                }
            }
        }, {passive: false}),
        tool.catchupAndSubscribe(owner => {
            toolLifecycle.terminate()
            if (owner.getValue() !== "time-selection") {timeSelection.clear()}
            toolLifecycle.own(owner.getValue() === "time-selection" ? TimeSelectionTool.install(context) : RegionPointerTool.install(context))
        })
    )
    return element
}

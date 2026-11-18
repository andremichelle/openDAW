import {Lifecycle, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html, ShortcutManager} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {TimeSelectionActions} from "@/ui/timeline/TimeSelectionActions"
import {TimeSelectionGestures} from "@/ui/timeline/TimeSelectionGestures"
import {installAutoScroll} from "@/ui/AutoScroll"
import {Config} from "@/ui/timeline/Config"
import {attachWheelScroll} from "@/ui/timeline/editors/WheelScroll"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const PrimaryTimeSelectionOverlay = ({lifecycle, service}: Construct) => {
    const {project, timeline: {range, snapping, tool, timeSelection}} = service
    const rect: SVGRectElement = (
        <rect x="0" y="0" width="0" height="0"
              stroke={Colors.green}
              fill={Colors.green}
              fill-opacity={0.08}
              stroke-width={1}
              stroke-dasharray="4 3"/>
    )
    const svg: SVGSVGElement = <svg width="100%" height="100%">{rect}</svg>
    const element: HTMLElement = <div className="time-selection" tabIndex={-1}>{svg}</div>
    const update = (): void => {
        if (timeSelection.isEmpty() || !timeSelection.unwrap().global) {
            svg.classList.add("hidden")
            return
        }
        svg.classList.remove("hidden")
        const {position, complete} = timeSelection.unwrap()
        const x0 = Math.floor(range.unitToX(position)) + 0.5
        const x1 = Math.floor(range.unitToX(complete)) + 0.5
        rect.x.baseVal.value = x0
        rect.y.baseVal.value = 0.5
        rect.width.baseVal.value = Math.max(x1 - x0, 1)
        rect.height.baseVal.value = Math.max(svg.clientHeight - 1, 1)
    }
    const shortcuts = lifecycle.own(ShortcutManager.get().createContext(element, "PrimaryTimeSelection"))
    const toolLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        timeSelection.subscribe(update),
        range.subscribe(update),
        Html.watchResize(svg, update),
        tool.catchupAndSubscribe(owner => {
            toolLifecycle.terminate()
            const active = owner.getValue() === "time-selection"
            element.classList.toggle("active", active)
            if (!active) {return}
            toolLifecycle.ownAll(
                TimeSelectionGestures.install({
                    element, range, snapping, shortcuts, timeSelection,
                    owns: selection => selection.global,
                    covers: selection => selection.global,
                    originAt: () => 0,
                    scopeAt: () => ({rows: UUID.newSet<UUID.Bytes>(uuid => uuid), global: true}),
                    moveRows: selection => selection.rows,
                    apply: (selection, action) => TimeSelectionActions.apply(service, selection,
                        TimeSelectionActions.allTracks(project), action)
                }),
                attachWheelScroll(element, range),
                installAutoScroll(element, deltaX => {
                    if (deltaX !== 0) {range.moveUnitBy(deltaX * range.unitsPerPixel * Config.AutoScrollHorizontalSpeed)}
                }, {padding: Config.AutoScrollPadding, dragPadding: Config.AutoScrollDragPadding})
            )
        })
    )
    update()
    return element
}

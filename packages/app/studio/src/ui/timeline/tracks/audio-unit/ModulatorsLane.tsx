import {Arrays, Lifecycle, MutableObservableValue, Terminator} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon.tsx"
import {
    ClipLaneClassName,
    RegionLaneClassName,
    TrackClassName,
    TrackHeaderClassName
} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"
import {StudioService} from "@/service/StudioService.ts"


type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    collapsed: MutableObservableValue<boolean>
}

// The face of the modulator group: a unit-like head lane with no content of its own, carrying only the
// collapse toggle for the automation lanes below it.
export const ModulatorsLane = ({lifecycle, service, collapsed}: Construct) => {
    const collapse: HTMLElement = <Icon symbol={IconSymbol.Dropdown} className="collapse-automation visible"/>
    const header: HTMLElement = (
        <div className={Html.buildClassList(TrackHeaderClassName, "is-primary")} tabindex={-1}>
            <div className="icon-container">
                <Icon symbol={IconSymbol.Modulation} style={{color: "var(--color)"}}/>
            </div>
            {collapse}
            <div className="labels">
                <h5 className="device-name" style={{color: Colors.dark.toString()}}>Modulators</h5>
                <h5 className="control-label"/>
            </div>
            <div/>
            <div/>
        </div>
    )
    const clipArea: HTMLElement = <div className={Html.buildClassList(ClipLaneClassName, "deactive")}/>
    const element: HTMLElement = (
        <div className={Html.buildClassList(TrackClassName, "unit-lane")} tabindex={-1}>
            {header}
            {clipArea}
            <div className={Html.buildClassList(RegionLaneClassName, "deactive")}/>
        </div>
    )
    element.style.setProperty("--guide-display", "none")
    const clipCellsLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        // The clip column mirrors the ClipLane's placeholder cells, exactly like a unit's synthetic lane.
        service.timeline.clips.visible.catchupAndSubscribe(visibleOwner => {
            clipCellsLifecycle.terminate()
            Html.empty(clipArea)
            if (visibleOwner.getValue()) {
                clipCellsLifecycle.own(service.timeline.clips.count.catchupAndSubscribe(countOwner => {
                    Html.empty(clipArea)
                    Arrays.create(index => (
                        <div style={{gridColumn: `${index + 1} / ${index + 2}`}}>
                            <div className="placeholder"/>
                        </div>
                    ), countOwner.getValue()).forEach(cell => clipArea.appendChild(cell))
                }))
            }
        }),
        Events.subscribe(collapse, "pointerdown", (event: PointerEvent) => {
            event.stopPropagation()
            collapsed.setValue(!collapsed.getValue())
        }),
        collapsed.catchupAndSubscribe(owner => collapse.classList.toggle("collapsed", owner.getValue()))
    )
    return element
}

import {Errors, Lifecycle, panic} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon.tsx"
import {Surface} from "@/ui/surface/Surface"
import {trackHeaderClassName} from "@/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackBoxAdapter: TrackBoxAdapter
}

// A modulator's automation lane: the same header a unit's value lane gets (icon, device name, control name,
// tree guides), minus the unit duties it has no owner for.
export const ModulatorTrackHeader = ({lifecycle, service, trackBoxAdapter}: Construct) => {
    const {project} = service
    const nameLabel: HTMLElement = <h5 className="device-name" style={{color: Colors.dark.toString()}}/>
    const controlLabel: HTMLElement = <h5 className="control-label" style={{color: Colors.shadow.toString()}}/>
    const element: HTMLElement = (
        <div className={Html.buildClassList(trackHeaderClassName, "is-primary")} tabindex={-1}>
            <div className="icon-container">
                <Icon symbol={IconSymbol.Automation} className="automation-icon"/>
            </div>
            <div className="labels">
                {nameLabel}
                {controlLabel}
            </div>
            <div/>
            <div/>
        </div>
    )
    lifecycle.ownAll(
        trackBoxAdapter.catchupAndSubscribePath(option => option.match({
            none: () => {
                nameLabel.textContent = ""
                controlLabel.textContent = ""
            },
            some: ([device, target]) => {
                nameLabel.textContent = device
                controlLabel.textContent = target
            }
        })),
        project.timelineFocus.track.catchupAndSubscribe(optTrack =>
            element.classList.toggle("focused", optTrack.mapOr(track => track === trackBoxAdapter, false))),
        Events.subscribeDblDwn(nameLabel, async event => {
            const {status, error, value} = await Promises.tryCatch(Surface.get(nameLabel)
                .requestFloatingTextInput(event, trackBoxAdapter.targetName.unwrapOrElse("")))
            if (status === "rejected") {
                if (!Errors.isAbort(error)) {return panic(error)}
            } else {
                project.editing.modify(() => trackBoxAdapter.targetName = value)
            }
        }),
        Events.subscribe(element, "pointerdown", () => project.timelineFocus.focusTrack(trackBoxAdapter))
    )
    return element
}

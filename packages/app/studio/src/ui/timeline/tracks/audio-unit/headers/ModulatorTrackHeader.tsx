import {Errors, Lifecycle, Option, panic} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ParameterTracks, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Surface} from "@/ui/surface/Surface"
import {TrackHeaderClassName} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"

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
    // The lane's owner is the modulator, not an audio unit, so it is reached through the parameter the lane
    // targets (the same route the knob's "Remove Automation" takes).
    const optTracks = (): Option<ParameterTracks> => trackBoxAdapter.target.targetVertex
        .flatMap(vertex => project.parameterFieldAdapters.opt(vertex.address))
        .flatMap(parameter => parameter.optTracks())
    const deleteLane = () => optTracks()
        .ifSome(tracks => project.editing.modify(() => tracks.delete(trackBoxAdapter)))
    const element: HTMLElement = (
        <div className={Html.buildClassList(TrackHeaderClassName, "is-primary")} tabindex={-1}>
            <div className="icon-container">
                <Icon symbol={IconSymbol.Automation} className="automation-icon"/>
            </div>
            <div className="labels">
                {nameLabel}
                {controlLabel}
            </div>
            <div/>
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                MenuItem.default({label: "Enabled", checked: trackBoxAdapter.enabled.getValue()})
                    .setTriggerProcedure(() => project.editing.modify(() => trackBoxAdapter.enabled.toggle())),
                MenuItem.default({label: "Remove Automation", separatorBefore: true})
                    .setTriggerProcedure(deleteLane)))}
                        style={{minWidth: "0", justifySelf: "end"}}
                        appearance={{color: Colors.shadow, activeColor: Colors.cream}}>
                <Icon symbol={IconSymbol.Menu} style={{fontSize: "0.75em"}}/>
            </MenuButton>
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
        Events.subscribe(element, "pointerdown", () => project.timelineFocus.focusTrack(trackBoxAdapter)),
        Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
            if (!Keyboard.isDelete(event)) {return}
            deleteLane()
        })
    )
    return element
}

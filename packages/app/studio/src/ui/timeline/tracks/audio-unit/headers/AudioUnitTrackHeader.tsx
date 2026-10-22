import {installTrackSelection, installGroupTrackDrag} from "@/ui/timeline/tracks/audio-unit/TrackGrouping"
import {DefaultObservableValue, Errors, Lifecycle, Option, panic, Terminator, UUID} from "@opendaw/lib-std"
import {createElement, Group, replaceChildren} from "@opendaw/lib-jsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {AudioUnitBoxAdapter, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitChannelControls} from "@/ui/timeline/tracks/audio-unit/AudioUnitChannelControls.tsx"
import {installTrackHeaderMenu} from "@/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts"
import {CollapseAutomationButton} from "@/ui/timeline/tracks/audio-unit/headers/CollapseAutomationButton.tsx"
import {TrackIcon} from "@/ui/timeline/tracks/audio-unit/headers/TrackIcon.tsx"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {TrackHeaderClassName} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"
import {Promises} from "@opendaw/lib-runtime"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {createHoverEditSwitch, isDeviceDrag} from "./HoverEditSwitch"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackManager: TracksManager
    trackBoxAdapter: TrackBoxAdapter
    audioUnitBoxAdapter: AudioUnitBoxAdapter
    unitHead: DefaultObservableValue<boolean>
}

export const AudioUnitTrackHeader = ({lifecycle, service, trackManager, trackBoxAdapter, audioUnitBoxAdapter, unitHead}: Construct) => {
    const nameLabel: HTMLElement = <h5 className="device-name" style={{color: Colors.dark.toString()}}/>
    const controlLabel: HTMLElement = <h5 className="control-label" style={{color: Colors.shadow.toString()}}/>
    const {project} = service
    const populateMenu = installTrackHeaderMenu(service, audioUnitBoxAdapter, Option.wrap(trackBoxAdapter))
    lifecycle.own(
        trackBoxAdapter.catchupAndSubscribePath(option => option.match({
            none: () => {
                nameLabel.textContent = ""
                controlLabel.textContent = ""
            },
            some: ([device, target]) => {
                nameLabel.textContent = device
                controlLabel.textContent = target
            }
        }))
    )
    // A value lane never speaks for the unit (content lanes and the synthetic lane sort before it), so it marks
    // the start of the unit's automation section instead: the automation glyph, deduped per value-lane run.
    const iconContainer: HTMLElement = trackBoxAdapter.type === TrackType.Value
        ? <div className="icon-container">
            <Icon symbol={IconSymbol.Automation} className="automation-icon"/>
        </div>
        : <TrackIcon lifecycle={lifecycle} service={service} audioUnitBoxAdapter={audioUnitBoxAdapter}/>
    const labels: HTMLElement = (
        <div className="labels">
            {nameLabel}
            {controlLabel}
        </div>
    )
    const element: HTMLElement = (
        <div className={Html.buildClassList(TrackHeaderClassName, "is-primary")} tabindex={-1}>
            {iconContainer}
            <CollapseAutomationButton lifecycle={lifecycle} service={service}
                                      audioUnitBoxAdapter={audioUnitBoxAdapter} head={unitHead}/>
            {labels}
            <Group onInit={element => {
                const channelLifeCycle = lifecycle.own(new Terminator())
                unitHead
                    .catchupAndSubscribe(owner => {
                        channelLifeCycle.terminate()
                        Html.empty(element)
                        if (owner.getValue()) {
                            replaceChildren(element, (
                                <AudioUnitChannelControls lifecycle={channelLifeCycle}
                                                          service={service}
                                                          adapter={audioUnitBoxAdapter}/>
                            ))
                        } else {
                            replaceChildren(element, <div/>)
                        }
                    })
            }}/>
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(populateMenu)}
                        style={{minWidth: "0", justifySelf: "end"}}
                        appearance={{color: Colors.shadow, activeColor: Colors.cream}}>
                <Icon symbol={IconSymbol.Menu} style={{fontSize: "0.75em"}}/>
            </MenuButton>
        </div>
    )
    installTrackSelection(lifecycle, project, element, audioUnitBoxAdapter.box, populateMenu)
    const audioUnitEditing = project.userEditingManager.audioUnit
    const hoverSwitch = createHoverEditSwitch(lifecycle, project, audioUnitBoxAdapter)
    // The whole head header moves the channel; controls and resize handles keep their own gestures.
    const dragLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        unitHead.catchupAndSubscribe(owner => {
            dragLifecycle.terminate()
            iconContainer.draggable = false
            if (owner.getValue() && !audioUnitBoxAdapter.isOutput) {
                dragLifecycle.own(installGroupTrackDrag(element, project, audioUnitBoxAdapter.box))
            }
        }),
        DragAndDrop.installSource(labels, () =>
            unitHead.getValue() || trackManager.groupMembers(trackBoxAdapter.uuid).length < 2
                ? null // a single-lane group has nowhere to go: veto, no ghost
                : {uuid: UUID.toString(trackBoxAdapter.uuid), type: "track"}, element),
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
        Events.subscribe(element, "pointerdown", () => {
            project.timelineFocus.focusTrack(trackBoxAdapter)
            if (!audioUnitEditing.isEditing(audioUnitBoxAdapter.box.editing)) {
                audioUnitEditing.edit(audioUnitBoxAdapter.box.editing)
            }
        }),
        Events.subscribe(element, "keydown", (event) => {
            if (!Keyboard.isDelete(event)) {return}
            // Deleting the LAST content track keeps the unit: its synthetic lane takes over (deleting the
            // unit itself is the synthetic lane's / menu's job).
            project.editing.modify(() => audioUnitBoxAdapter.deleteTrack(trackBoxAdapter))
        }),
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => {
                if (isDeviceDrag(data)) {hoverSwitch.hover()}
                return ((data.type === "midi-effect" && !audioUnitBoxAdapter.box.isGroup.getValue()) || data.type === "audio-effect") && data.uuids === null
            },
            drop: (_event: DragEvent, data: AnyDragData) => {
                hoverSwitch.cancel()
                if (data.type === "midi-effect") {
                    if (data.uuids !== null) {return}
                    const factory = EffectFactories.MidiNamed[data.device]
                    if (factory.type !== audioUnitBoxAdapter.input.adapter().unwrapOrNull()?.accepts) {
                        return
                    }
                    const effectField = audioUnitBoxAdapter.box.midiEffects
                    project.editing.modify(() =>
                        factory.create(project, effectField, effectField.pointerHub.incoming().length))
                } else if (data.type === "audio-effect") {
                    if (data.uuids !== null) {return}
                    const factory = EffectFactories.AudioNamed[data.device]
                    const effectField = audioUnitBoxAdapter.box.audioEffects
                    project.editing.modify(() =>
                        factory.create(project, effectField, effectField.pointerHub.incoming().length))
                }
            },
            enter: (allowDrop: boolean) => element.classList.toggle("accept-drop", allowDrop),
            leave: () => {
                element.classList.remove("accept-drop")
                hoverSwitch.cancel()
            }
        })
    )
    return element
}
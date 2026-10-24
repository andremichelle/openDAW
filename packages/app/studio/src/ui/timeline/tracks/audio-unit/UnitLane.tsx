import {Surface} from "@/ui/surface/Surface"
import {Promises} from "@opendaw/lib-runtime"
import {TracksManager} from "./TracksManager"
import {installTrackResize} from "./TrackResize"
import {GroupOverview} from "./GroupOverview"
import {installTrackSelection, installGroupTrackDrag} from "@/ui/timeline/tracks/audio-unit/TrackGrouping"
import {Arrays, DefaultObservableValue, Errors, Lifecycle, Option, panic, Terminator, UUID} from "@opendaw/lib-std"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {createElement, Group, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitBoxAdapter, InstrumentFactories, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {Colors, IconSymbol, TransientPlayMode} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon.tsx"
import {
    ClipLaneClassName,
    RegionLaneClassName,
    TrackClassName,
    TrackHeaderClassName
} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {AudioContentFactory, MenuItem} from "@opendaw/studio-core"
import {AudioUnitChannelControls} from "@/ui/timeline/tracks/audio-unit/AudioUnitChannelControls.tsx"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {CollapseAutomationButton} from "@/ui/timeline/tracks/audio-unit/headers/CollapseAutomationButton.tsx"
import {AnyDragData} from "@/ui/AnyDragData"
import {TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {installTrackHeaderMenu} from "@/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts"
import {TrackIcon} from "@/ui/timeline/tracks/audio-unit/headers/TrackIcon.tsx"


type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackManager: TracksManager
    audioUnitBoxAdapter: AudioUnitBoxAdapter
}

// The synthetic lane of a unit WITHOUT notes/audio tracks (an aux, a group, an instrument driven by its own
// note generator): the unit's face in the timeline, rendered like the former TrackType.Undefined placeholder
// (header + deactive body), carrying the unit head duties (channel controls, menu, editing focus, unit drag).
export const UnitLane = ({lifecycle, service, trackManager, audioUnitBoxAdapter}: Construct) => {
    const {project} = service
    const populateMenu = installTrackHeaderMenu(service, audioUnitBoxAdapter, Option.None)
    const nameLabel: HTMLElement = <h5 className="device-name" style={{color: Colors.dark.toString()}}/>
    const iconHost: HTMLElement = (
        <TrackIcon lifecycle={lifecycle} service={service} audioUnitBoxAdapter={audioUnitBoxAdapter}/>
    )
    if (audioUnitBoxAdapter.box.isGroup.getValue()) {
        const toggle = () => {
            project.editing.modify(() => audioUnitBoxAdapter.box.groupCollapsed.toggle())
            project.trackSelection.set([audioUnitBoxAdapter.box])
        }
        const button: HTMLButtonElement = <button className="folder-toggle" title="Collapse or expand group" onclick={toggle}/>
        lifecycle.own(audioUnitBoxAdapter.box.groupCollapsed.catchupAndSubscribe(field => {
            button.textContent = field.getValue() ? "▸" : "▾"
            button.setAttribute("aria-expanded", String(!field.getValue()))
            button.setAttribute("aria-label", field.getValue() ? "Expand group" : "Collapse group")
        }))
        iconHost.replaceChildren(button)
        lifecycle.own(Events.subscribeDblDwn(nameLabel, async event => {
            const {status, error, value} = await Promises.tryCatch(Surface.get(nameLabel)
                .requestFloatingTextInput(event, audioUnitBoxAdapter.input.label.unwrapOrElse("")))
            if (status === "rejected") {
                if (!Errors.isAbort(error)) {return panic(error)}
            } else if (audioUnitBoxAdapter.box.isAttached()) {
                project.editing.modify(() => audioUnitBoxAdapter.input.label = value)
            }
        }))
    }
    iconHost.title = "Drag to move this track"
    nameLabel.title = audioUnitBoxAdapter.box.isGroup.getValue() ? "Double-click to rename; drag to move this group" : ""
    const header: HTMLElement = (
        <div className={Html.buildClassList(TrackHeaderClassName, "is-primary")} tabindex={-1}>
            {iconHost}
            <CollapseAutomationButton lifecycle={lifecycle} service={service}
                                      audioUnitBoxAdapter={audioUnitBoxAdapter}
                                      head={new DefaultObservableValue<boolean>(true)}/>
            <div className="labels">
                {nameLabel}
                <h5 className="control-label"/>
            </div>
            <Group onInit={element => {
                const controlsLifecycle = lifecycle.own(new Terminator())
                replaceChildren(element, (
                    <AudioUnitChannelControls lifecycle={controlsLifecycle}
                                              service={service}
                                              adapter={audioUnitBoxAdapter}/>
                ))
            }}/>
            {/* The same menu the track header mounts, minus the track-scoped entries (#309 follow-up): this lane
                is the unit's only face while it has no notes/audio track, so it must offer the unit's actions. */}
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(populateMenu)}
                        style={{minWidth: "0", justifySelf: "end"}}
                        appearance={{color: Colors.shadow, activeColor: Colors.cream}}>
                <Icon symbol={IconSymbol.Menu} style={{fontSize: "0.75em"}}/>
            </MenuButton>
        </div>
    )
    const regionArea: HTMLElement = audioUnitBoxAdapter.box.isGroup.getValue()
        ? GroupOverview({lifecycle, service, unit: audioUnitBoxAdapter.box})
        : <div className={Html.buildClassList(RegionLaneClassName, "deactive")}/>
    const clipArea: HTMLElement = <div className={Html.buildClassList(ClipLaneClassName, "deactive")}/>
    const element: HTMLElement = (
        <div className={Html.buildClassList(TrackClassName, "unit-lane")} tabindex={-1}>
            {header}
            {clipArea}
            {regionArea}
        </div>
    )
    element.style.setProperty("--guide-display", "none")
    installTrackResize(lifecycle, service, trackManager, audioUnitBoxAdapter.box.userInterface.height, element)
    const isSampleDrag = (data: AnyDragData): boolean => data.type === "sample" || data.type === "file"
    const acceptsAudio = () => audioUnitBoxAdapter.input.adapter()
        .mapOr(adapter => !audioUnitBoxAdapter.box.isGroup.getValue() && adapter.accepts === "audio", false)
    installTrackSelection(lifecycle, project, header, audioUnitBoxAdapter.box, populateMenu)
    const audioUnitEditing = project.userEditingManager.audioUnit
    const clipCellsLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        service.timeline.clips.scroll.catchupAndSubscribe(owner => clipArea.scrollLeft = owner.getValue()),
        // A sample dropped on an audio-accepting unit's synthetic lane creates the real audio track plus the
        // region at the drop position — the content track mounts and this lane disappears.
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => isSampleDrag(data) && acceptsAudio(),
            drop: (event: DragEvent, data: AnyDragData) => {
                if (!isSampleDrag(data) || !acceptsAudio()) {return}
                const pointerX = event.clientX - regionArea.getBoundingClientRect().left
                TimelineDragAndDrop.resolveSamples(service, data).then(resolved => {
                    // The samples resolved asynchronously; the unit may have been deleted meanwhile.
                    if (resolved.length === 0 || !audioUnitBoxAdapter.box.isAttached()) {return}
                    const {editing, boxGraph, api} = project
                    const position = Math.max(Math.floor(service.timeline.range.xToUnit(pointerX)), 0)
                    editing.modify(() => resolved.forEach(({sample, type, audioFileBoxFactory}, index) => {
                        const targetTrack = index === 0
                            ? TrackBox.create(boxGraph, UUID.generate(), box => {
                                box.type.setValue(TrackType.Audio)
                                box.tracks.refer(audioUnitBoxAdapter.box.tracks)
                                box.index.setValue(audioUnitBoxAdapter.tracks.collection.getMinFreeIndex())
                                box.target.refer(audioUnitBoxAdapter.box)
                            })
                            : api.createInstrument(InstrumentFactories.Tape).trackBox
                        const audioFileBox = audioFileBoxFactory()
                        if (type === "file" || sample.bpm === 0) {
                            AudioContentFactory.createNotStretchedRegion({
                                boxGraph, targetTrack, audioFileBox, sample, position
                            })
                        } else {
                            AudioContentFactory.createTimeStretchedRegion({
                                boxGraph, targetTrack, audioFileBox, sample, position,
                                playbackRate: 1.0, transientPlayMode: TransientPlayMode.Pingpong
                            })
                        }
                    }))
                })
            },
            enter: (allowDrop: boolean) => header.classList.toggle("accept-drop", allowDrop),
            leave: () => header.classList.remove("accept-drop")
        }),
        audioUnitBoxAdapter.input.catchupAndSubscribeLabelChange(option =>
            nameLabel.textContent = option.unwrapOrElse("")),
        // The clip column mirrors the ClipLane's placeholder cells (no clips can exist on this lane).
        service.timeline.clips.visible.catchupAndSubscribe(visibleOwner => {
            clipCellsLifecycle.terminate()
            Html.empty(clipArea)
            if (visibleOwner.getValue()) {
                clipCellsLifecycle.own(service.timeline.clips.columns.catchupAndSubscribe(countOwner => {
                    clipArea.style.setProperty("--clip-columns", String(countOwner.getValue()))
                    Html.empty(clipArea)
                    Arrays.create(index => (
                        <div style={{gridColumn: `${index + 1} / ${index + 2}`}}>
                            <div className="placeholder"/>
                        </div>
                    ), countOwner.getValue()).forEach(cell => clipArea.appendChild(cell))
                    clipArea.scrollLeft = service.timeline.clips.scroll.getValue()
                }))
            }
        }),
        installGroupTrackDrag(header, project, audioUnitBoxAdapter.box),
        Events.subscribe(header, "pointerdown", () => {
            if (!audioUnitEditing.isEditing(audioUnitBoxAdapter.box.editing)) {
                audioUnitEditing.edit(audioUnitBoxAdapter.box.editing)
            }
        }),
        Events.subscribe(header, "keydown", (event) => {
            if (!Keyboard.isDelete(event)) {return}
            // The output unit is mandatory: never delete it (the engine rejects the transaction and desyncs).
            if (audioUnitBoxAdapter.isOutput) {return}
            project.editing.modify(() => project.api.deleteAudioUnit(audioUnitBoxAdapter.box))
        })
    )
    return element
}

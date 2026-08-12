import trackCss from "./Track.sass?inline"
import headerCss from "./headers/TrackHeader.sass?inline"
import clipCss from "./clips/ClipLane.sass?inline"
import regionCss from "./regions/RegionLane.sass?inline"
import {Arrays, DefaultObservableValue, Lifecycle, Option, Terminator, UUID} from "@opendaw/lib-std"
import {Events, Html, Keyboard} from "@opendaw/lib-dom"
import {createElement, Group, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {Colors, IconSymbol, TransientPlayMode} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {AudioContentFactory, MenuItem} from "@opendaw/studio-core"
import {AudioUnitChannelControls} from "@/ui/timeline/tracks/audio-unit/AudioUnitChannelControls.tsx"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {CollapseAutomationButton} from "@/ui/timeline/tracks/audio-unit/headers/CollapseAutomationButton.tsx"
import {AnyDragData} from "@/ui/AnyDragData"
import {TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {installTrackHeaderMenu} from "@/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts"
import {TrackIcon} from "@/ui/timeline/tracks/audio-unit/headers/TrackIcon.tsx"

const trackClassName = Html.adoptStyleSheet(trackCss, "Track")
const headerClassName = Html.adoptStyleSheet(headerCss, "TrackHeader")
const clipClassName = Html.adoptStyleSheet(clipCss, "ClipLane")
const regionClassName = Html.adoptStyleSheet(regionCss, "RegionLane")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    audioUnitBoxAdapter: AudioUnitBoxAdapter
}

// The synthetic lane of a unit WITHOUT notes/audio tracks (an aux, a group, an instrument driven by its own
// note generator): the unit's face in the timeline, rendered like the former TrackType.Undefined placeholder
// (header + deactive body), carrying the unit head duties (channel controls, menu, editing focus, unit drag).
export const UnitLane = ({lifecycle, service, audioUnitBoxAdapter}: Construct) => {
    const {project} = service
    const nameLabel: HTMLElement = <h5 className="device-name" style={{color: Colors.dark.toString()}}/>
    const iconHost: HTMLElement = (
        <TrackIcon lifecycle={lifecycle} service={service} audioUnitBoxAdapter={audioUnitBoxAdapter}/>
    )
    const header: HTMLElement = (
        <div className={Html.buildClassList(headerClassName, "is-primary")} tabindex={-1}>
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
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(
                installTrackHeaderMenu(service, audioUnitBoxAdapter, Option.None))}
                        style={{minWidth: "0", justifySelf: "end"}}
                        appearance={{color: Colors.shadow, activeColor: Colors.cream}}>
                <Icon symbol={IconSymbol.Menu} style={{fontSize: "0.75em"}}/>
            </MenuButton>
        </div>
    )
    const regionArea: HTMLElement = <div className={Html.buildClassList(regionClassName, "deactive")}/>
    const clipArea: HTMLElement = <div className={Html.buildClassList(clipClassName, "deactive")}/>
    const element: HTMLElement = (
        <div className={Html.buildClassList(trackClassName, "unit-lane")} tabindex={-1}>
            {header}
            {clipArea}
            {regionArea}
        </div>
    )
    element.style.setProperty("--guide-display", "none")
    const isSampleDrag = (data: AnyDragData): boolean => data.type === "sample" || data.type === "file"
    const acceptsAudio = () => audioUnitBoxAdapter.input.adapter()
        .mapOr(adapter => adapter.accepts === "audio", false)
    const audioUnitEditing = project.userEditingManager.audioUnit
    const clipCellsLifecycle = lifecycle.own(new Terminator())
    lifecycle.ownAll(
        // A sample dropped on an audio-accepting unit's synthetic lane creates the real audio track plus the
        // region at the drop position — the content track mounts and this lane disappears.
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => isSampleDrag(data) && acceptsAudio(),
            drop: (event: DragEvent, data: AnyDragData) => {
                if (!isSampleDrag(data) || !acceptsAudio()) {return}
                const pointerX = event.clientX - regionArea.getBoundingClientRect().left
                TimelineDragAndDrop.resolveSample(service, data).then(option =>
                    option.ifSome(({sample, type, audioFileBoxFactory}) => {
                        // The sample resolved asynchronously; the unit may have been deleted meanwhile.
                        if (!audioUnitBoxAdapter.box.isAttached()) {return}
                        const {editing, boxGraph} = project
                        const position = Math.max(Math.floor(service.timeline.range.xToUnit(pointerX)), 0)
                        editing.modify(() => {
                            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                                box.type.setValue(TrackType.Audio)
                                box.tracks.refer(audioUnitBoxAdapter.box.tracks)
                                box.index.setValue(audioUnitBoxAdapter.tracks.collection.getMinFreeIndex())
                                box.target.refer(audioUnitBoxAdapter.box)
                            })
                            const audioFileBox = audioFileBoxFactory()
                            if (type === "file" || sample.bpm === 0) {
                                AudioContentFactory.createNotStretchedRegion({
                                    boxGraph, targetTrack: trackBox, audioFileBox, sample, position
                                })
                            } else {
                                AudioContentFactory.createTimeStretchedRegion({
                                    boxGraph, targetTrack: trackBox, audioFileBox, sample, position,
                                    playbackRate: 1.0, transientPlayMode: TransientPlayMode.Pingpong
                                })
                            }
                        })
                    }))
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
        DragAndDrop.installSource(iconHost, () => audioUnitBoxAdapter.isOutput ? null : ({
            uuid: UUID.toString(audioUnitBoxAdapter.uuid),
            type: "channelstrip",
            start_index: audioUnitBoxAdapter.indexField.getValue()
        }), header),
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

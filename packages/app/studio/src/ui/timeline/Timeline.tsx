import css from "./Timeline.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {TracksFooter} from "@/ui/timeline/tracks/footer/TracksFooter.tsx"
import {TimelineHeader} from "@/ui/timeline/TimelineHeader.tsx"
import {TimelineNavigation} from "@/ui/timeline/TimelineNavigation.tsx"
import {PrimaryTracks} from "./tracks/primary/PrimaryTracks"
import {AudioUnitsTimeline} from "./tracks/audio-unit/AudioUnitsTimeline.tsx"
import {ClipsHeader} from "@/ui/timeline/tracks/audio-unit/clips/ClipsHeader.tsx"
import {ppqn} from "@opendaw/lib-dsp"
import {deferNextFrame, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Timeline")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Timeline = ({lifecycle, service}: Construct) => {
    const {project, timeline} = service
    const {engine} = project
    const {snapping, clips, followCursor, primaryVisibility: {markers, tempo}} = timeline
    const snappingName = Inject.value(snapping.unit.name)
    lifecycle.own(snapping.subscribe(snapping => {snappingName.value = snapping.unit.name}))
    const timelineHeader = <TimelineHeader lifecycle={lifecycle} service={service}/>
    const tracksFooter = <TracksFooter lifecycle={lifecycle} service={service}/>
    const element: HTMLElement = (
        <div className={className}>
            {timelineHeader}
            <ClipsHeader lifecycle={lifecycle} service={service}/>
            <TimelineNavigation lifecycle={lifecycle} service={service}/>
            <PrimaryTracks lifecycle={lifecycle} service={service}/>
            <AudioUnitsTimeline lifecycle={lifecycle} service={service}/>
            {tracksFooter}
        </div>
    )
    const updateRecordingState = () =>
        element.classList.toggle("recording", engine.isRecording.getValue() || engine.isCountingIn.getValue())
    const {request} = lifecycle.own(deferNextFrame(() =>
        element.classList.toggle("primary-tracks-visible", markers.getValue() || tempo.getValue())))
    lifecycle.ownAll(
        Html.watchResize(element, () => {
            const cursorHeight = element.clientHeight
                - timelineHeader.clientHeight
                - tracksFooter.clientHeight
            element.style.setProperty("--cursor-height", `${cursorHeight - 1}px`)
        }),
        engine.isRecording.subscribe(updateRecordingState),
        engine.isCountingIn.subscribe(updateRecordingState),
        engine.position.subscribe((() => {
            let lastPosition: ppqn = 0
            return owner => {
                if (!followCursor.getValue() || service.regionModifierInProgress) {return}
                const range = service.timeline.range
                const position = owner.getValue()
                if (lastPosition <= range.unitMax && position > range.unitMax) {
                    range.moveUnitBy(range.unitMax - range.unitMin)
                } else if (lastPosition >= range.unitMin && position < range.unitMin) {
                    range.moveUnitBy(range.unitMin - range.unitMax)
                }
                lastPosition = position
            }
        })()),
        clips.visible.catchupAndSubscribe(owner => { return element.classList.toggle("clips-visible", owner.getValue()) }),
        clips.count.catchupAndSubscribe(owner => element.style.setProperty("--clips-count", String(owner.getValue()))),
        markers.catchupAndSubscribe(request),
        tempo.catchupAndSubscribe(request)
    )
    return element
}
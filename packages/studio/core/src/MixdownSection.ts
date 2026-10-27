import {asInstanceOf, isDefined, Optional, UUID} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {MarkerBox} from "@opendaw/studio-boxes"
import {Project} from "./project"

export type MixdownSection = {
    type: "song" | "loop" | "marker"
    key: string
    label: string
    start: ppqn
    end: ppqn
    passes: 1 | 2
    tail: boolean
}

export namespace MixdownSection {
    export const collect = (project: Project): ReadonlyArray<MixdownSection> => {
        const {timelineBox: {loopArea, markerTrack}} = project
        const songEnd = project.lastRegionAction()
        const sections: Array<MixdownSection> = [
            {type: "song", key: "song", label: "Entire song", start: 0, end: songEnd, passes: 1, tail: true}
        ]
        const loopStart = loopArea.from.getValue()
        const loopEnd = loopArea.to.getValue()
        if (loopEnd > loopStart) {
            sections.push(
                {type: "loop", key: "loop", label: "Loop Area", start: loopStart, end: loopEnd, passes: 1, tail: false},
                {
                    type: "loop", key: "loop-two-passes", label: "Loop Area (two passes)",
                    start: loopStart, end: loopEnd, passes: 2, tail: false
                })
        }
        const markers = markerTrack.markers.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, MarkerBox))
            .sort((a, b) => a.position.getValue() - b.position.getValue())
        markers.forEach((marker, index) => {
            const start = marker.position.getValue()
            const next: Optional<MarkerBox> = markers[index + 1]
            const tail = !isDefined(next)
            const end = tail ? songEnd : next.position.getValue()
            if (end <= start) {return}
            const label = marker.label.getValue().trim()
            sections.push({
                type: "marker", key: UUID.toString(marker.address.uuid),
                label: label.length > 0 ? label : `Marker ${index + 1}`, start, end, passes: 1, tail
            })
        })
        return sections
    }

    export const find = (sections: ReadonlyArray<MixdownSection>, key: string): MixdownSection =>
        sections.find(section => section.key === key) ?? sections[0]
}

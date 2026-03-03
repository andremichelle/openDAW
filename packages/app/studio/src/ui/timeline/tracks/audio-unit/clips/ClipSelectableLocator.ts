import {TimelineSelectableLocator} from "@/ui/timeline/TimelineSelectableLocator.ts"
import {AnyClipBoxAdapter} from "@opendaw/studio-adapters"
import {Coordinates, Iterables} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {ClipWidth} from "@/ui/timeline/tracks/audio-unit/clips/constants.ts"
import {ClipCaptureTarget} from "@/ui/timeline/tracks/audio-unit/clips/ClipCapturing.ts"
import {ElementCapturing} from "@opendaw/studio-core"

export const createClipSelectableLocator = (capturing: ElementCapturing<ClipCaptureTarget>, manager: TracksManager)
    : TimelineSelectableLocator<AnyClipBoxAdapter> => ({
    selectableAt: (coordinates: Coordinates<ppqn, number>) => {
        const target = capturing.captureLocalPoint(coordinates.u, coordinates.v - manager.scrollableContainer.scrollTop)
        return target === null || target.type === "track" ? Iterables.empty() : Iterables.one(target.clip)
    },
    selectablesBetween: ({u: u0, v: v0}, {u: u1, v: v1}) => {
        const tracks = manager.tracks()
        const startIndex = manager.localToIndex(v0)
        if (startIndex < 0 || startIndex >= tracks.length) {return Iterables.empty()}
        const clips: Array<AnyClipBoxAdapter> = []
        for (let trackIndex = startIndex; trackIndex < tracks.length; trackIndex++) {
            const track = tracks[trackIndex]
            if (track.position >= v1) {break}
            const clipIndex0 = Math.floor(u0 / ClipWidth)
            const clipIndex1 = Math.floor(u1 / ClipWidth)
            track.trackBoxAdapter.clips.collection.adapters()
                .forEach(adapter => {
                    const clipIndex = adapter.indexField.getValue()
                    if (clipIndex0 <= clipIndex && clipIndex <= clipIndex1) {
                        clips.push(adapter)
                    }
                })
        }
        return clips
    },
    selectable: () => manager.tracks().flatMap(track => track.trackBoxAdapter.clips.collection.adapters())
})
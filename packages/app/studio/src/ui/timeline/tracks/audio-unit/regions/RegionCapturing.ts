import {
    AnyLoopableRegionBoxAdapter,
    AnyRegionBoxAdapter,
    AudioRegionBoxAdapter,
    UnionAdapterTypes
} from "@opendaw/studio-adapters"
import {BinarySearch, Geom, isDefined, isInstanceOf, Nullable, NumberComparator} from "@opendaw/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"
import {AudioUnitFreeze, ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {RegionLabel} from "@/ui/timeline/RegionLabel"

export type RegionCaptureTarget =
    | { type: "region", part: "position", region: AnyRegionBoxAdapter }
    | { type: "region", part: "start", region: AnyLoopableRegionBoxAdapter }
    | { type: "region", part: "complete", region: AnyRegionBoxAdapter }
    | { type: "region", part: "content-start", region: AnyRegionBoxAdapter }
    | { type: "region", part: "content-complete", region: AnyRegionBoxAdapter }
    | { type: "region", part: "loop-duration", region: AnyRegionBoxAdapter }
    | { type: "region", part: "fading-in", region: AudioRegionBoxAdapter }
    | { type: "region", part: "fading-out", region: AudioRegionBoxAdapter }
    | { type: "track", track: TrackContext }

export namespace RegionCapturing {
    export const create = (element: Element, manager: TracksManager, range: TimelineRange, audioUnitFreeze: AudioUnitFreeze) =>
        new ElementCapturing<RegionCaptureTarget>(element, {
            capture: (x: number, y: number): Nullable<RegionCaptureTarget> => {
                y += manager.scrollableContainer.scrollTop
                if (y > manager.scrollableContainer.scrollHeight - ExtraSpace) {
                    return null
                }
                const tracks = manager.tracks()
                const trackIndex = BinarySearch
                    .rightMostMapped(tracks, y, NumberComparator, component => component.position)
                if (trackIndex < 0 || trackIndex >= tracks.length) {return null}
                const track = tracks[trackIndex]
                if (audioUnitFreeze.isFrozen(track.audioUnitBoxAdapter)) {
                    return {type: "track", track}
                }
                const position = Math.floor(range.xToUnit(x))
                const threshold = range.unitsPerPixel * PointerRadiusDistance
                const collection = track.trackBoxAdapter.regions.collection
                let edgeCapture: Nullable<RegionCaptureTarget> = null
                let edgeDistance = Infinity
                let edgeIsInside = false
                let bodyRegion: Nullable<AnyRegionBoxAdapter> = null
                for (const region of collection.iterateFrom(position - threshold)) {
                    if (region.position > position + threshold) { break }
                    if (position >= region.complete + threshold) { continue }
                    const x0 = range.unitToX(region.position)
                    const x1 = range.unitToX(region.complete)
                    if (isInstanceOf(region, AudioRegionBoxAdapter)) {
                        const {fading} = region
                        const handleRadius = 3
                        const handleY = track.position + RegionLabel.labelHeight()
                        const fadeInX = range.unitToX(region.position + fading.in)
                        const fadeOutX = range.unitToX(region.position + region.duration - fading.out)
                        if (Geom.isInsideCircle(x, y, fadeInX, handleY, handleRadius)) {
                            return {type: "region", part: "fading-in", region}
                        }
                        if (Geom.isInsideCircle(x, y, fadeOutX, handleY, handleRadius)) {
                            return {type: "region", part: "fading-out", region}
                        }
                    }
                    if (UnionAdapterTypes.isLoopableRegion(region)) {
                        const bottomEdge = y > track.position + RegionLabel.labelHeight()
                        const cursorInside = position >= region.position && position < region.complete
                        const isBetter = (distance: number): boolean =>
                            distance < PointerRadiusDistance
                            && (cursorInside && !edgeIsInside
                                || cursorInside === edgeIsInside && distance < edgeDistance)
                        const completeDistance = Math.abs(x - x1)
                        if (isBetter(completeDistance)) {
                            edgeDistance = completeDistance
                            edgeIsInside = cursorInside
                            edgeCapture = bottomEdge
                                ? {type: "region", part: "content-complete", region}
                                : {type: "region", part: "complete", region}
                        }
                        const startDistance = Math.abs(x - x0)
                        if (isBetter(startDistance)) {
                            edgeDistance = startDistance
                            edgeIsInside = cursorInside
                            edgeCapture = bottomEdge
                                ? {type: "region", part: "content-start", region}
                                : {type: "region", part: "start", region}
                        }
                        if (bottomEdge) {
                            const loopDistance = Math.abs(x - range.unitToX(region.offset + region.loopDuration))
                            if (isBetter(loopDistance)) {
                                edgeDistance = loopDistance
                                edgeIsInside = cursorInside
                                edgeCapture = {type: "region", part: "loop-duration", region}
                            }
                        }
                    }
                    bodyRegion = region
                }
                if (isDefined(edgeCapture)) { return edgeCapture }
                if (isDefined(bodyRegion)) { return {type: "region", part: "position", region: bodyRegion} }
                return {type: "track", track}
            }
        })
}
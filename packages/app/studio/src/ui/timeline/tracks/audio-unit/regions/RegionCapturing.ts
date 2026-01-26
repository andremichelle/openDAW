import {
    AnyLoopableRegionBoxAdapter,
    AnyRegionBoxAdapter,
    AudioRegionBoxAdapter,
    UnionAdapterTypes
} from "@opendaw/studio-adapters"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {BinarySearch, Geom, isInstanceOf, Nullable, NumberComparator} from "@opendaw/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"
import {TimelineRange} from "@opendaw/studio-core"
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
    export const create = (element: Element, manager: TracksManager, range: TimelineRange) =>
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
                const position = Math.floor(range.xToUnit(x))
                const region = track.trackBoxAdapter.regions.collection.lowerEqual(position)
                if (region === null || position >= region.complete) {
                    return {type: "track", track}
                }
                const x0 = range.unitToX(region.position)
                const x1 = range.unitToX(region.complete)
                if (x1 - x0 <= PointerRadiusDistance * 2) {
                    // too small to have other sensitive areas
                    return {type: "region", part: "position", region}
                }
                if (isInstanceOf(region, AudioRegionBoxAdapter)) {
                    const {fading} = region
                    const handleRadius = 6
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
                    if (x - x0 < PointerRadiusDistance * 2) {
                        return bottomEdge
                            ? {type: "region", part: "content-start", region}
                            : {type: "region", part: "start", region}
                    }
                    if (x1 - x < PointerRadiusDistance * 2) {
                        return bottomEdge
                            ? {type: "region", part: "content-complete", region}
                            : {type: "region", part: "complete", region}
                    }
                    if (bottomEdge
                        && Math.abs(x - range.unitToX(region.offset + region.loopDuration)) <= PointerRadiusDistance) {
                        return {type: "region", part: "loop-duration", region}
                    }
                }
                return {type: "region", part: "position", region}
            }
        })
}
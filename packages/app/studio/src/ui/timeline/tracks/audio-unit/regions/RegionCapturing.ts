import {AnyLoopableRegionBoxAdapter, AnyRegionBoxAdapter, UnionAdapterTypes} from "@opendaw/studio-adapters"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {BinarySearch, Nullable, NumberComparator} from "@opendaw/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"
import {TimelineRange} from "@opendaw/studio-core"

export type RegionCaptureTarget =
    | { type: "region", part: "position", region: AnyRegionBoxAdapter }
    | { type: "region", part: "start", region: AnyLoopableRegionBoxAdapter }
    | { type: "region", part: "complete", region: AnyRegionBoxAdapter }
    | { type: "region", part: "content-resize", region: AnyRegionBoxAdapter }
    | { type: "region", part: "loop-duration", region: AnyRegionBoxAdapter }
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
                const size = track.size
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
                if (UnionAdapterTypes.isLoopableRegion(region)) {
                    if (x - x0 < PointerRadiusDistance * 2) {
                        return {type: "region", part: "start", region}
                    }
                    const bottomEdge = y > track.position + size / 3 * 2
                    if (x1 - x < PointerRadiusDistance * 2) {
                        return bottomEdge
                            ? {type: "region", part: "content-resize", region}
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
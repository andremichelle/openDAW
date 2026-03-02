import {AnyLoopableRegionBoxAdapter, AnyRegionBoxAdapter, UnionAdapterTypes} from "@opendaw/studio-adapters"
import {isDefined, Nullable, Option, Provider} from "@opendaw/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"

export type CaptureTarget =
    | { type: "region-position", region: AnyRegionBoxAdapter }
    | { type: "region-start", region: AnyLoopableRegionBoxAdapter }
    | { type: "region-complete", region: AnyRegionBoxAdapter }
    | { type: "loop-duration", region: AnyRegionBoxAdapter }

export const createRegionCapturing = (canvas: Element,
                                      regionProvider: Provider<Option<AnyRegionBoxAdapter>>,
                                      range: TimelineRange) => new ElementCapturing<CaptureTarget>(canvas, {
    capture: (x: number, _y: number): Nullable<CaptureTarget> => {
        const trackAdapter = regionProvider().unwrapOrNull()?.trackBoxAdapter?.unwrapOrNull()
        if (!isDefined(trackAdapter)) {return null}
        const position = Math.floor(range.xToUnit(x))
        const region = trackAdapter.regions.collection.lowerEqual(position)
        if (region === null || position >= region.complete) {return null}
        const x0 = range.unitToX(region.position)
        const x1 = range.unitToX(region.complete)
        if (x1 - x0 <= PointerRadiusDistance * 4) {
            // too small to have other sensitive areas
            return {type: "region-position", region}
        }
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            if (x - x0 < PointerRadiusDistance * 2) {
                return {type: "region-start", region}
            } else if (Math.abs(x - range.unitToX(region.offset + region.loopDuration)) <= PointerRadiusDistance) {
                return {type: "loop-duration", region}
            } else if (x1 - x < PointerRadiusDistance * 2) {
                return {type: "region-complete", region}
            }
        }
        return {type: "region-position", region}
    }
})
import {EventCollection, ppqn} from "@opendaw/lib-dsp"
import {Nullable} from "@opendaw/lib-std"
import {WarpMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"

export namespace WarpMarkerUtils {
    export const findAdjacent = (position: ppqn,
                                 warpMarkers: EventCollection<WarpMarkerBoxAdapter>,
                                 includePosition: boolean)
        : [Nullable<WarpMarkerBoxAdapter>, Nullable<WarpMarkerBoxAdapter>] => {
        const left = warpMarkers.lowerEqual(includePosition ? position : position - 1)
        const right = warpMarkers.greaterEqual(position + 1)
        return [left, right]
    }

    export const createCapturing = (element: Element,
                                    range: TimelineRange,
                                    reader: AudioEventOwnerReader,
                                    markerRadius: number) => new ElementCapturing<WarpMarkerBoxAdapter>(element, {
        capture: (x: number, _y: number): Nullable<WarpMarkerBoxAdapter> => {
            const optWarpMarkers = reader.audioContent.optWarpMarkers
            if (optWarpMarkers.isEmpty()) {return null}
            const u0 = range.xToUnit(x - markerRadius) - reader.offset
            const u1 = range.xToUnit(x + markerRadius) - reader.offset
            let closest: Nullable<{ marker: WarpMarkerBoxAdapter, distance: number }> = null
            for (const marker of optWarpMarkers.unwrap().iterateRange(u0, u1)) {
                const dx = x - range.unitToX(marker.position + reader.offset)
                const distance = Math.abs(dx)
                if (distance <= markerRadius) {
                    if (closest === null) {
                        closest = {marker, distance}
                    } else if (closest.distance < distance) {
                        closest.marker = marker
                        closest.distance = distance
                    }
                }
            }
            if (closest === null) {return null}
            return closest.marker
        }
    })
}
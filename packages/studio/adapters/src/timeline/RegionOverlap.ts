import {int, Option} from "@opendaw/lib-std"
import {ppqn, TimeBase} from "@opendaw/lib-dsp"
import {AudioRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {AnyRegionBox, UnionBoxTypes} from "../unions"
import {BoxAdapters} from "../BoxAdapters"
import {RegionAdapters} from "./RegionBoxAdapter"

export namespace RegionOverlap {
    const Float32RelativeEpsilon = 2 ** -23 // float32 has 23 mantissa bits

    export const boundaryTolerance = (value: ppqn): ppqn => Math.abs(value) * Float32RelativeEpsilon + 1e-3

    // The end of a seconds region moves with the tempo. It ends where the next region starts, never an error.
    export const endsAtSuccessor = (box: AnyRegionBox): boolean =>
        box instanceof AudioRegionBox && box.timeBase.getValue() !== TimeBase.Musical

    export const sortedRegions = (trackBox: TrackBox): Array<AnyRegionBox> => trackBox.regions.pointerHub.incoming()
        .map(({box}) => UnionBoxTypes.asRegionBox(box))
        .sort((left, right) => left.position.getValue() - right.position.getValue())

    export const find = (sorted: ReadonlyArray<AnyRegionBox>): Option<int> => {
        for (let index = 1; index < sorted.length; index++) {
            const prev = sorted[index - 1]
            if (endsAtSuccessor(prev)) {continue}
            const position = sorted[index].position.getValue()
            if (prev.position.getValue() + prev.duration.getValue() > position + boundaryTolerance(position)) {
                return Option.wrap(index)
            }
        }
        return Option.None
    }

    export const hasSpace = (boxAdapters: BoxAdapters, trackBox: TrackBox, position: ppqn, complete: ppqn): boolean =>
        trackBox.regions.pointerHub.incoming().every(({box}) => {
            const region = RegionAdapters.for(boxAdapters, box)
            return region.resolveComplete(region.position) <= position || region.position >= complete
        })
}

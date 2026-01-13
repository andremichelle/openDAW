import {TimelineCoordinates, TimelineSelectableLocator} from "@/ui/timeline/TimelineSelectableLocator.ts"
import {AnyRegionBoxAdapter} from "@moises-ai/studio-adapters"
import {isDefined, Iterables, Selection} from "@moises-ai/lib-std"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

export const createRegionLocator = (manager: TracksManager,
                                    regionSelection: Selection<AnyRegionBoxAdapter>)
    : TimelineSelectableLocator<AnyRegionBoxAdapter> => ({
    selectableAt: ({u, v}: TimelineCoordinates): Iterable<AnyRegionBoxAdapter> => {
        const tracks = manager.tracks()
        const index = manager.localToIndex(v)
        if (index < 0 || index >= tracks.length) {return Iterables.empty()}
        const component = tracks[index]
        const region = component.trackBoxAdapter.regions.collection.lowerEqual(u)
        if (isDefined(region) && u < region.complete) {
            return Iterables.one(region)
        }
        return Iterables.empty()
    },
    selectablesBetween: ({u: u0, v: v0}, {u: u1, v: v1}): Iterable<AnyRegionBoxAdapter> => {
        const tracks = manager.tracks()
        const startIndex = manager.localToIndex(v0)
        if (startIndex < 0 || startIndex >= tracks.length) {return Iterables.empty()}
        const regions: Array<AnyRegionBoxAdapter> = []
        for (let index = startIndex; index < tracks.length; index++) {
            const component = tracks[index]
            if (component.position >= v1) {break}
            regions.push(...component.trackBoxAdapter.regions.collection.iterateRange(u0, u1))
        }
        return regions
    },
    selectable: (): Iterable<AnyRegionBoxAdapter> => regionSelection.selected()
})
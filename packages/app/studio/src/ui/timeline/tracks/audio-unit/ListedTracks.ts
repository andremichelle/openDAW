import {clamp, Func, int, Option} from "@opendaw/lib-std"
import {TrackBoxAdapter} from "@opendaw/studio-adapters"
import type {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"

export namespace ListedTracks {
    // listIndex is only kept current for tracks in the manager's list
    export const indexOf = (manager: TracksManager, track: Option<TrackBoxAdapter>): Option<int> =>
        track.flatMap(adapter => manager.getByIndex(adapter.listIndex)
            .flatMap(({trackBoxAdapter}) => trackBoxAdapter === adapter ? Option.wrap(adapter.listIndex) : Option.None))

    export const withIndices = <T>(manager: TracksManager,
                                   items: ReadonlyArray<T>,
                                   trackOf: Func<T, Option<TrackBoxAdapter>>): ReadonlyArray<[T, int]> =>
        items.flatMap(item => indexOf(manager, trackOf(item)).mapOr<Array<[T, int]>>(index => [[item, index]], []))

    export const clampDelta = (delta: int, indices: ReadonlyArray<int>, maxIndex: int): int => {
        const lowest = indices.reduce((min, index) => Math.min(min, index), Number.POSITIVE_INFINITY)
        const highest = indices.reduce((max, index) => Math.max(max, index), Number.NEGATIVE_INFINITY)
        return clamp(delta, -lowest, maxIndex - highest)
    }
}

import {Arrays} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"

// Delete and Undo mid-drag leave the modifier holding an orphaned region instance (live error 1095)
export namespace RegionModifierSelection {
    export const isIntact = (adapters: ReadonlyArray<AnyRegionBoxAdapter>): boolean =>
        adapters.every(adapter => adapter.trackBoxAdapter.nonEmpty())

    export const tracksOf = (adapters: ReadonlyArray<AnyRegionBoxAdapter>): ReadonlyArray<TrackBoxAdapter> =>
        Arrays.removeDuplicates(adapters.map(adapter => adapter.trackBoxAdapter.unwrap("trackBoxAdapter")))
}

import {Arrays} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"

// A drag outlives what it captured: pressing Delete and then Undo mid-drag re-creates the region under the
// SAME uuid, and `Box.isAttached()` is uuid-based (`graph.findBox(uuid).nonEmpty()`), so it still answers true
// for the ORPHANED instance the modifier is holding — while that orphan's own pointer fields stay
// disconnected. `trackBoxAdapter` resolves live from one of those fields, so it is what tells a modifier
// whether the selection it captured is still the one on screen (live error 1095).
export namespace RegionModifierSelection {
    export const isIntact = (adapters: ReadonlyArray<AnyRegionBoxAdapter>): boolean =>
        adapters.every(adapter => adapter.trackBoxAdapter.nonEmpty())

    export const tracksOf = (adapters: ReadonlyArray<AnyRegionBoxAdapter>): ReadonlyArray<TrackBoxAdapter> =>
        Arrays.removeDuplicates(adapters.map(adapter => adapter.trackBoxAdapter.unwrap("trackBoxAdapter")))
}

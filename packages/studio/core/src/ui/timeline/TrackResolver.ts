import {AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"

/**
 * Function to resolve the target track for a region.
 * Used by overlap resolvers to provide track overrides for copy operations.
 */
export type TrackResolver = (adapter: AnyRegionBoxAdapter, defaultTrack: TrackBoxAdapter) => TrackBoxAdapter

export namespace TrackResolver {
    /** Identity resolver - always returns the default track */
    export const Identity: TrackResolver = (_adapter, defaultTrack) => defaultTrack
}
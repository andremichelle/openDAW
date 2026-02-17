import {Exec, int} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {BoxEditing} from "@opendaw/lib-box"
import {AnyRegionBoxAdapter, BoxAdapters, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {RegionModifyStrategies} from "./RegionModifyStrategies"
import {RegionClipResolver} from "./RegionClipResolver"
import {RegionKeepExistingResolver} from "./RegionKeepExistingResolver"
import {RegionPushExistingResolver} from "./RegionPushExistingResolver"
import {StudioPreferences} from "../../StudioPreferences"
import {ProjectApi} from "../../project"
import {TrackResolver} from "./TrackResolver"

export class RegionOverlapResolver {
    readonly #editing: BoxEditing
    readonly #projectApi: ProjectApi
    readonly #boxAdapters: BoxAdapters

    constructor(editing: BoxEditing, projectApi: ProjectApi, boxAdapters: BoxAdapters) {
        this.#editing = editing
        this.#projectApi = projectApi
        this.#boxAdapters = boxAdapters
    }

    /**
     * For selection-based operations (move, resize, copy).
     * @param tracks - The tracks involved in the operation
     * @param adapters - The region adapters being modified
     * @param strategy - The modify strategy (determines if it's a copy, etc.)
     * @param deltaIndex - Track index delta (for cross-track moves)
     * @param changes - Callback that performs the actual changes. Receives a TrackResolver
     *                  that should be used to determine target tracks for copies.
     */
    apply(tracks: ReadonlyArray<TrackBoxAdapter>,
          adapters: ReadonlyArray<AnyRegionBoxAdapter>,
          strategy: RegionModifyStrategies,
          deltaIndex: int,
          changes: (trackResolver: TrackResolver) => void): void {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour === "clip") {
            const {postProcess, trackResolver} = RegionClipResolver.fromSelection(tracks, adapters, strategy, deltaIndex)
            this.#editing.modify(() => {
                changes(trackResolver)
                postProcess()
            })
            RegionClipResolver.validateTracks(tracks)
        } else if (behaviour === "push-existing") {
            const {postProcess, trackResolver} = RegionPushExistingResolver.fromSelection(
                tracks, adapters, strategy, deltaIndex, this.#projectApi, this.#boxAdapters)
            this.#editing.modify(() => {
                changes(trackResolver)
                postProcess()
            })
        } else {
            // keep-existing
            const {postProcess, trackResolver} = RegionKeepExistingResolver.fromSelection(
                tracks, adapters, strategy, deltaIndex, this.#projectApi, this.#boxAdapters)
            this.#editing.modify(() => {
                changes(trackResolver)
                postProcess()
            })
        }
    }

    /**
     * For range-based operations (drop, duplicate).
     * Returns the target track to use (may differ from input track for keep-existing mode).
     */
    resolveTargetTrack(track: TrackBoxAdapter, position: ppqn, complete: ppqn): TrackBoxAdapter {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour === "keep-existing") {
            return RegionKeepExistingResolver
                .resolveTargetTrack(track, position, complete, this.#projectApi, this.#boxAdapters)
        }
        return track
    }

    /**
     * Creates a resolver function for range-based operations (to be called inside an existing transaction).
     * Call this BEFORE creating the region to capture the "before" state.
     * Then call the returned function AFTER creating the region.
     */
    fromRange(track: TrackBoxAdapter, position: ppqn, complete: ppqn): Exec {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour === "clip") {
            const solver = RegionClipResolver.fromRange(track, position, complete)
            return () => {
                solver()
                RegionClipResolver.validateTrack(track)
            }
        } else if (behaviour === "push-existing") {
            return RegionPushExistingResolver.fromRange(track, position, complete, this.#projectApi, this.#boxAdapters)
        } else {
            // keep-existing: nothing to do after creation - caller should use resolveTargetTrack before creating
            return () => {}
        }
    }
}
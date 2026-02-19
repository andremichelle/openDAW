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

    static warnOverlaps(label: string, tracks: ReadonlyArray<TrackBoxAdapter>): void {
        for (const track of tracks) {
            const regions = track.regions.collection.asArray()
            for (let i = 1; i < regions.length; i++) {
                const prev = regions[i - 1]
                const next = regions[i]
                if (prev.complete > next.position) {
                    console.warn(`[RegionOverlapResolver] ${label}`, {
                        track: track.listIndex,
                        prev: {p: prev.position, d: prev.duration, c: prev.complete, sel: prev.isSelected, type: prev.toString()},
                        next: {p: next.position, d: next.duration, c: next.complete, sel: next.isSelected, type: next.toString()},
                        allRegions: regions.map(region => ({p: region.position, d: region.duration, c: region.complete, sel: region.isSelected})),
                        stack: new Error().stack
                    })
                }
            }
        }
    }

    apply(tracks: ReadonlyArray<TrackBoxAdapter>,
          adapters: ReadonlyArray<AnyRegionBoxAdapter>,
          strategy: RegionModifyStrategies,
          deltaIndex: int,
          changes: (trackResolver: TrackResolver) => void): void {
        RegionOverlapResolver.warnOverlaps("Overlap BEFORE apply", tracks)
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
            RegionOverlapResolver.warnOverlaps("Overlap AFTER apply (push-existing)", tracks)
        } else {
            // keep-existing
            const {postProcess, trackResolver} = RegionKeepExistingResolver.fromSelection(
                tracks, adapters, strategy, deltaIndex, this.#projectApi, this.#boxAdapters)
            this.#editing.modify(() => {
                changes(trackResolver)
                postProcess()
            })
            RegionOverlapResolver.warnOverlaps("Overlap AFTER apply (keep-existing)", tracks)
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
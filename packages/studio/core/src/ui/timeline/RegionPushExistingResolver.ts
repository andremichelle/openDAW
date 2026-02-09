import {EmptyExec, Exec, int, isDefined, Optional} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter, BoxAdapters, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {RegionModifyStrategies} from "./RegionModifyStrategies"
import {ProjectApi} from "../../project"
import {TrackResolver} from "./TrackResolver"

/**
 * Resolver for "push-existing" overlap behavior.
 * When overlap is detected, the EXISTING (overlapped) regions move to a track below.
 * Incoming regions stay where they were placed.
 */
export class RegionPushExistingResolver {
    /**
     * For selection-based operations (move, resize).
     * Returns:
     * - postProcess: function to call AFTER changes are applied
     * - trackResolver: Identity (incoming regions stay where placed)
     */
    static fromSelection(tracks: ReadonlyArray<TrackBoxAdapter>,
                         adapters: ReadonlyArray<AnyRegionBoxAdapter>,
                         strategy: RegionModifyStrategies,
                         deltaIndex: int,
                         projectApi: ProjectApi,
                         boxAdapters: BoxAdapters): { postProcess: Exec, trackResolver: TrackResolver } {
        const resolver = new RegionPushExistingResolver(projectApi, boxAdapters)
        // Capture overlapped regions BEFORE changes
        for (const track of tracks) {
            const selectedStrategy = strategy.selectedModifyStrategy()
            const overlapped: Array<AnyRegionBoxAdapter> = []
            for (const adapter of adapters) {
                const adapterTrackIndex = adapter.trackBoxAdapter.unwrap().listIndex + deltaIndex
                if (adapterTrackIndex !== track.listIndex) {continue}
                const position = selectedStrategy.readPosition(adapter)
                const complete = selectedStrategy.readComplete(adapter)
                for (const region of track.regions.collection.iterateRange(0, complete)) {
                    if (region.complete <= position) {continue}
                    if (region.position >= complete) {break}
                    if (region.isSelected && !strategy.showOrigin()) {continue}
                    if (!overlapped.includes(region)) {overlapped.push(region)}
                }
            }
            if (overlapped.length > 0) {
                resolver.#overlappedByTrack.set(track, overlapped)
            }
        }

        return {
            postProcess: () => resolver.#solve(),
            trackResolver: TrackResolver.Identity
        }
    }

    /**
     * For range-based operations (drop, duplicate).
     * Returns a function that should be called AFTER the region is created.
     */
    static fromRange(track: TrackBoxAdapter,
                     position: ppqn,
                     complete: ppqn,
                     projectApi: ProjectApi,
                     boxAdapters: BoxAdapters): Exec {
        if (track.type === TrackType.Value) {return () => {}}
        // Find overlapped regions BEFORE changes
        const overlapped: Array<AnyRegionBoxAdapter> = []
        for (const region of track.regions.collection.iterateRange(0, complete)) {
            if (region.complete <= position) {continue}
            if (region.position >= complete) {break}
            overlapped.push(region)
        }
        if (overlapped.length === 0) {return EmptyExec}
        return () => {
            const targetTrack = RegionPushExistingResolver.#findOrCreateTrackBelow(
                track, overlapped, projectApi, boxAdapters)
            if (isDefined(targetTrack)) {
                for (const region of overlapped) {
                    region.box.regions.refer(targetTrack.box.regions)
                }
                track.regions.dispatchChange()
                targetTrack.regions.dispatchChange()
            }
        }
    }

    static #findOrCreateTrackBelow(sourceTrack: TrackBoxAdapter,
                                   regionsToPlace: ReadonlyArray<AnyRegionBoxAdapter>,
                                   projectApi: ProjectApi,
                                   boxAdapters: BoxAdapters): Optional<TrackBoxAdapter> {
        const trackType = sourceTrack.type
        if (trackType === TrackType.Value) {return undefined}
        const minPosition = Math.min(...regionsToPlace.map(region => region.position))
        const maxComplete = Math.max(...regionsToPlace.map(region => region.complete))
        const audioUnit = sourceTrack.audioUnit
        // Get all tracks of same type in this audio unit, sorted by index
        const siblingTracks = audioUnit.tracks.pointerHub.incoming()
            .map(vertex => vertex.box as TrackBox)
            .filter(trackBox => trackBox.type.getValue() === trackType)
            .sort((boxA, boxB) => boxA.index.getValue() - boxB.index.getValue())
        const sourceIndex = sourceTrack.indexField.getValue()
        // Look for existing track below with space
        for (const trackBox of siblingTracks) {
            if (trackBox.index.getValue() <= sourceIndex) {continue}
            if (RegionPushExistingResolver.#hasSpace(trackBox, minPosition, maxComplete)) {
                return boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
            }
        }
        // No suitable existing track found, create new track below source
        const insertIndex = sourceIndex + 1
        const newTrackBox = trackType === TrackType.Audio
            ? projectApi.createAudioTrack(audioUnit, insertIndex)
            : projectApi.createNoteTrack(audioUnit, insertIndex)
        return boxAdapters.adapterFor(newTrackBox, TrackBoxAdapter)
    }

    static #hasSpace(trackBox: TrackBox, position: ppqn, complete: ppqn): boolean {
        for (const vertex of trackBox.regions.pointerHub.incoming()) {
            const regionPosition = (vertex.box as any).position.getValue() as ppqn
            const regionDuration = (vertex.box as any).duration.getValue() as ppqn
            const regionComplete = regionPosition + regionDuration
            if (regionComplete <= position) {continue}
            if (regionPosition >= complete) {continue}
            return false
        }
        return true
    }

    readonly #projectApi: ProjectApi
    readonly #boxAdapters: BoxAdapters
    readonly #overlappedByTrack: Map<TrackBoxAdapter, Array<AnyRegionBoxAdapter>>

    private constructor(projectApi: ProjectApi, boxAdapters: BoxAdapters) {
        this.#projectApi = projectApi
        this.#boxAdapters = boxAdapters
        this.#overlappedByTrack = new Map()
    }

    #solve(): void {
        const affectedTracks: Array<TrackBoxAdapter> = []
        for (const [track, overlapped] of this.#overlappedByTrack) {
            const targetTrack = RegionPushExistingResolver.#findOrCreateTrackBelow(
                track, overlapped, this.#projectApi, this.#boxAdapters)
            if (!isDefined(targetTrack)) {continue}
            if (!affectedTracks.includes(targetTrack)) {affectedTracks.push(targetTrack)}
            if (!affectedTracks.includes(track)) {affectedTracks.push(track)}

            for (const region of overlapped) {
                region.box.regions.refer(targetTrack.box.regions)
            }
        }
        // Dispatch change on all affected tracks to ensure UI updates
        affectedTracks.forEach(track => track.regions.dispatchChange())
    }
}
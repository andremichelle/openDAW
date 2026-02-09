import {Exec, int} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter, BoxAdapters, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {RegionModifyStrategies} from "./RegionModifyStrategies"
import {ProjectApi} from "../../project"
import {TrackResolver} from "./TrackResolver"

type OverlapInfo = {
    track: TrackBoxAdapter
    position: ppqn
    complete: ppqn
    adapter: AnyRegionBoxAdapter
}

/**
 * Resolver for "keep-existing" overlap behavior.
 * When overlap is detected, the INCOMING (selected/moved/copied) region moves to a track below.
 * Existing regions stay in place.
 */
export class RegionKeepExistingResolver {
    /**
     * For selection-based operations (move, resize, copy).
     * Returns:
     * - postProcess: function to call AFTER changes are applied (handles moves)
     * - trackResolver: function to get target track for copies (use BEFORE creating copy)
     *
     * NOTE: Track resolution is lazy - target tracks are computed when trackResolver is called
     * or when postProcess runs. This is necessary because creating new tracks requires being
     * inside a transaction.
     */
    static fromSelection(tracks: ReadonlyArray<TrackBoxAdapter>,
                         adapters: ReadonlyArray<AnyRegionBoxAdapter>,
                         strategy: RegionModifyStrategies,
                         deltaIndex: int,
                         projectApi: ProjectApi,
                         boxAdapters: BoxAdapters): { postProcess: Exec, trackResolver: TrackResolver } {
        const isCopy = strategy.showOrigin()
        // Collect overlap info - don't compute target tracks yet (need to be in transaction)
        const copyOverlaps: Array<OverlapInfo> = []
        const moveOverlaps: Array<OverlapInfo> = []
        for (const track of tracks) {
            const selectedStrategy = strategy.selectedModifyStrategy()
            for (const adapter of adapters) {
                const adapterTrackIndex = adapter.trackBoxAdapter.unwrap().listIndex + deltaIndex
                if (adapterTrackIndex !== track.listIndex) {continue}
                const position = selectedStrategy.readPosition(adapter)
                const complete = selectedStrategy.readComplete(adapter)
                let hasOverlap = false
                for (const region of track.regions.collection.iterateRange(0, complete)) {
                    // For moves: skip the adapter itself (it's being moved)
                    // For copies: DON'T skip - the copy might overlap with the original
                    if (!isCopy && region === adapter) {continue}
                    // For moves: skip other selected regions (they move together)
                    if (!isCopy && region.isSelected) {continue}
                    if (region.complete <= position) {continue}
                    if (region.position >= complete) {break}
                    hasOverlap = true
                    break
                }
                if (hasOverlap) {
                    const info: OverlapInfo = {track, position, complete, adapter}
                    if (isCopy) {
                        copyOverlaps.push(info)
                    } else {
                        moveOverlaps.push(info)
                    }
                }
            }
        }
        // Cache for lazily computed target tracks
        const targetTrackCache = new Map<AnyRegionBoxAdapter, TrackBoxAdapter>()
        // Track which tracks were affected by copy redirects (for dispatchChange)
        const copyAffectedTracks: Array<TrackBoxAdapter> = []
        const getTargetTrack = (info: OverlapInfo): TrackBoxAdapter => {
            let targetTrack = targetTrackCache.get(info.adapter)
            if (targetTrack === undefined) {
                targetTrack = RegionKeepExistingResolver.#findOrCreateTrackBelow(
                    info.track, info.position, info.complete, projectApi, boxAdapters)
                targetTrackCache.set(info.adapter, targetTrack)
            }
            return targetTrack
        }
        // Lazy track resolver for copies - called inside the transaction
        const trackResolver: TrackResolver = (adapter, defaultTrack) => {
            const info = copyOverlaps.find(overlap => overlap.adapter === adapter)
            if (info !== undefined) {
                const targetTrack = getTargetTrack(info)
                // Track affected tracks for dispatchChange in postProcess
                if (!copyAffectedTracks.includes(targetTrack)) {copyAffectedTracks.push(targetTrack)}
                if (!copyAffectedTracks.includes(info.track)) {copyAffectedTracks.push(info.track)}
                return targetTrack
            }
            return defaultTrack
        }
        // Post-process - handles moves and dispatches changes for copy-affected tracks
        const postProcess: Exec = () => {
            const affectedTracks: Array<TrackBoxAdapter> = [...copyAffectedTracks]
            for (const info of moveOverlaps) {
                const targetTrack = getTargetTrack(info)
                if (!affectedTracks.includes(targetTrack)) {affectedTracks.push(targetTrack)}
                if (!affectedTracks.includes(info.track)) {affectedTracks.push(info.track)}
                info.adapter.box.regions.refer(targetTrack.box.regions)
            }
            affectedTracks
                .filter(track => track.listIndex >= 0)
                .forEach(track => track.regions.dispatchChange())
        }
        return {postProcess, trackResolver}
    }

    /**
     * For range-based operations (drop, duplicate).
     * Returns the target track to use for creation (may be different from original if overlap exists).
     */
    static resolveTargetTrack(track: TrackBoxAdapter,
                              position: ppqn,
                              complete: ppqn,
                              projectApi: ProjectApi,
                              boxAdapters: BoxAdapters): TrackBoxAdapter {
        if (track.type === TrackType.Value) {return track}
        // Check for overlap
        for (const region of track.regions.collection.iterateRange(0, complete)) {
            if (region.complete <= position) {continue}
            if (region.position >= complete) {break}
            // Found overlap, find track below
            return RegionKeepExistingResolver.#findOrCreateTrackBelow(track, position, complete, projectApi, boxAdapters)
        }
        return track
    }

    static #findOrCreateTrackBelow(sourceTrack: TrackBoxAdapter,
                                   position: ppqn,
                                   complete: ppqn,
                                   projectApi: ProjectApi,
                                   boxAdapters: BoxAdapters): TrackBoxAdapter {
        const audioUnit = sourceTrack.audioUnit
        const trackType = sourceTrack.type

        // Get all tracks of same type in this audio unit, sorted by index
        const siblingTracks = audioUnit.tracks.pointerHub.incoming()
            .map(vertex => vertex.box as TrackBox)
            .filter(trackBox => trackBox.type.getValue() === trackType)
            .sort((boxA, boxB) => boxA.index.getValue() - boxB.index.getValue())

        const sourceIndex = sourceTrack.indexField.getValue()

        // Look for existing track below with space
        for (const trackBox of siblingTracks) {
            if (trackBox.index.getValue() <= sourceIndex) {continue}
            if (RegionKeepExistingResolver.#hasSpace(trackBox, position, complete)) {
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
}

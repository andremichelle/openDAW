import {Exec, int, isDefined, Optional} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {BoxEditing} from "@opendaw/lib-box"
import {AnyRegionBoxAdapter, BoxAdapters, TrackBoxAdapter, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {RegionModifyStrategies} from "./RegionModifyStrategies"
import {RegionClipResolver} from "./RegionClipResolver"
import {StudioPreferences} from "../../StudioPreferences"
import {ProjectApi} from "../../project"

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
     * For selection-based operations (move, resize).
     * @param tracks - Target tracks affected by the operation
     * @param adapters - Regions being modified
     * @param strategy - Modify strategy for reading positions
     * @param deltaIndex - Track index change
     * @param changes - Lambda to apply the position/track changes
     */
    apply(tracks: ReadonlyArray<TrackBoxAdapter>,
          adapters: ReadonlyArray<AnyRegionBoxAdapter>,
          strategy: RegionModifyStrategies,
          deltaIndex: int,
          changes: Exec): void {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour === "clip") {
            const solver = RegionClipResolver.fromSelection(tracks, adapters, strategy, deltaIndex)
            this.#editing.modify(() => {
                changes()
                solver()
            })
            RegionClipResolver.validateTracks(tracks)
        } else if (behaviour === "push-existing") {
            this.#applyPushExisting(tracks, adapters, strategy, deltaIndex, changes)
        } else {
            this.#applyKeepExisting(tracks, adapters, strategy, deltaIndex, changes)
        }
    }

    /**
     * For range-based operations (drop, duplicate).
     * @param track - Target track for the region
     * @param position - Start position of the region
     * @param complete - End position of the region
     * @param excludeRegion - Optional region to exclude from overlap detection
     * @param changes - Lambda to create the region
     */
    applyRange(track: TrackBoxAdapter,
               position: ppqn,
               complete: ppqn,
               excludeRegion: Optional<AnyRegionBoxAdapter>,
               changes: Exec): void {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour === "clip") {
            const solver = RegionClipResolver.fromRange(track, position, complete)
            this.#editing.modify(() => {
                changes()
                solver()
            })
            RegionClipResolver.validateTrack(track)
        } else if (behaviour === "push-existing") {
            this.#applyRangePushExisting(track, position, complete, excludeRegion, changes)
        } else {
            this.#applyRangeKeepExisting(track, position, complete, excludeRegion, changes)
        }
    }

    /**
     * Resolves the target track for keep-existing behavior.
     * For "clip" or "push-existing", returns the original track.
     * For "keep-existing", returns a track below if overlap exists.
     * NOTE: This must be called INSIDE an editing.modify() transaction if a new track might be created.
     */
    resolveTargetTrack(track: TrackBoxAdapter,
                       position: ppqn,
                       complete: ppqn): TrackBoxAdapter {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour !== "keep-existing") {return track}
        if (track.type === TrackType.Value) {return track}
        // Check for overlap
        for (const region of track.regions.collection.iterateRange(0, complete)) {
            if (region.complete <= position) {continue}
            if (region.position >= complete) {break}
            // Found overlap, get track below
            return this.#findOrCreateTrackBelowForRange(track, position, complete)
        }
        return track
    }

    /**
     * Creates a resolver function for range-based operations (to be called inside an existing transaction).
     * Returns a function that handles overlaps based on the current behaviour setting.
     * Call this BEFORE creating the region to capture the "before" state.
     * Then call the returned function AFTER creating the region.
     */
    fromRange(track: TrackBoxAdapter, position: ppqn, complete: ppqn): Exec {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        if (behaviour === "clip") {
            return RegionClipResolver.fromRange(track, position, complete)
        } else if (behaviour === "push-existing") {
            // Capture overlapped regions BEFORE creation
            const overlapped: Array<AnyRegionBoxAdapter> = []
            for (const region of track.regions.collection.iterateRange(0, complete)) {
                if (region.complete <= position) {continue}
                if (region.position >= complete) {break}
                overlapped.push(region)
            }
            return () => {
                if (overlapped.length > 0) {
                    const targetTrack = this.#findOrCreateTrackBelow(track, overlapped)
                    if (isDefined(targetTrack)) {
                        for (const region of overlapped) {
                            region.box.regions.refer(targetTrack.box.regions)
                        }
                    }
                }
            }
        } else {
            // keep-existing: nothing to do after creation - caller should use resolveTargetTrack before creating
            return () => {}
        }
    }

    #applyPushExisting(tracks: ReadonlyArray<TrackBoxAdapter>,
                       adapters: ReadonlyArray<AnyRegionBoxAdapter>,
                       strategy: RegionModifyStrategies,
                       deltaIndex: int,
                       changes: Exec): void {
        // Capture overlapped regions BEFORE changes
        const overlappedByTrack = new Map<TrackBoxAdapter, Array<AnyRegionBoxAdapter>>()
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
            if (overlapped.length > 0) {overlappedByTrack.set(track, overlapped)}
        }

        this.#editing.modify(() => {
            changes()
            // Push overlapped existing regions down
            for (const [track, overlapped] of overlappedByTrack) {
                const targetTrack = this.#findOrCreateTrackBelow(track, overlapped)
                if (!isDefined(targetTrack)) {continue}
                for (const region of overlapped) {
                    region.box.regions.refer(targetTrack.box.regions)
                }
            }
        })
    }

    #applyKeepExisting(
        tracks: ReadonlyArray<TrackBoxAdapter>,
        adapters: ReadonlyArray<AnyRegionBoxAdapter>,
        strategy: RegionModifyStrategies,
        deltaIndex: int,
        changes: Exec
    ): void {
        // Check for overlaps BEFORE changes to determine which incoming regions need to move
        const regionsToMove = new Map<AnyRegionBoxAdapter, TrackBoxAdapter>()
        for (const track of tracks) {
            const selectedStrategy = strategy.selectedModifyStrategy()
            for (const adapter of adapters) {
                const adapterTrackIndex = adapter.trackBoxAdapter.unwrap().listIndex + deltaIndex
                if (adapterTrackIndex !== track.listIndex) {continue}
                const position = selectedStrategy.readPosition(adapter)
                const complete = selectedStrategy.readComplete(adapter)
                let hasOverlap = false
                for (const region of track.regions.collection.iterateRange(0, complete)) {
                    if (region === adapter) {continue}
                    if (region.isSelected && !strategy.showOrigin()) {continue}
                    if (region.complete <= position) {continue}
                    if (region.position >= complete) {break}
                    hasOverlap = true
                    break
                }
                if (hasOverlap) {regionsToMove.set(adapter, track)}
            }
        }

        this.#editing.modify(() => {
            changes()
            // Move incoming regions down if they overlap
            for (const [adapter, originalTrack] of regionsToMove) {
                const targetTrack = this.#findOrCreateTrackBelow(originalTrack, [adapter])
                if (!isDefined(targetTrack)) {continue}
                adapter.box.regions.refer(targetTrack.box.regions)
            }
        })
    }

    #applyRangePushExisting(
        track: TrackBoxAdapter,
        position: ppqn,
        complete: ppqn,
        excludeRegion: Optional<AnyRegionBoxAdapter>,
        changes: Exec
    ): void {
        // Find overlapped regions BEFORE changes
        const overlapped: Array<AnyRegionBoxAdapter> = []
        for (const region of track.regions.collection.iterateRange(0, complete)) {
            if (region === excludeRegion) {continue}
            if (region.complete <= position) {continue}
            if (region.position >= complete) {break}
            overlapped.push(region)
        }

        this.#editing.modify(() => {
            changes()
            if (overlapped.length > 0) {
                const targetTrack = this.#findOrCreateTrackBelow(track, overlapped)
                if (isDefined(targetTrack)) {
                    for (const region of overlapped) {
                        region.box.regions.refer(targetTrack.box.regions)
                    }
                }
            }
        })
    }

    #applyRangeKeepExisting(
        track: TrackBoxAdapter,
        position: ppqn,
        complete: ppqn,
        excludeRegion: Optional<AnyRegionBoxAdapter>,
        changes: Exec
    ): void {
        // Check for overlaps BEFORE changes
        let hasOverlap = false
        for (const region of track.regions.collection.iterateRange(0, complete)) {
            if (region === excludeRegion) {continue}
            if (region.complete <= position) {continue}
            if (region.position >= complete) {break}
            hasOverlap = true
            break
        }

        if (!hasOverlap) {
            this.#editing.modify(changes)
            return
        }

        // For keep-existing with range-based operations,
        // we need to find the target track BEFORE creating the region
        const targetTrack = this.#findOrCreateTrackBelowForRange(track, position, complete)

        this.#editing.modify(() => {
            changes()
            // The region was just created on the original track,
            // now move the most recently added region to target track
            if (isDefined(targetTrack)) {
                const regions = track.regions.collection.asArray()
                const newRegion = regions.find(region =>
                    region.position === position && region !== excludeRegion)
                if (isDefined(newRegion)) {
                    newRegion.box.regions.refer(targetTrack.box.regions)
                }
            }
        })
    }

    #findOrCreateTrackBelow(sourceTrack: TrackBoxAdapter,
                            regionsToPlace: ReadonlyArray<AnyRegionBoxAdapter>): Optional<TrackBoxAdapter> {
        const trackType = sourceTrack.type
        if (trackType === TrackType.Value) {return undefined} // Don't push automation tracks
        const minPosition = Math.min(...regionsToPlace.map(region => region.position))
        const maxComplete = Math.max(...regionsToPlace.map(region => region.complete))
        return this.#findOrCreateTrackBelowForRange(sourceTrack, minPosition, maxComplete)
    }

    #findOrCreateTrackBelowForRange(sourceTrack: TrackBoxAdapter,
                                    position: ppqn,
                                    complete: ppqn): TrackBoxAdapter {
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
            if (this.#hasSpaceForRange(trackBox, position, complete)) {
                return this.#getTrackAdapter(trackBox)
            }
        }

        // No suitable existing track found, create new track below source
        const insertIndex = sourceIndex + 1
        const newTrackBox = trackType === TrackType.Audio
            ? this.#projectApi.createAudioTrack(audioUnit, insertIndex)
            : this.#projectApi.createNoteTrack(audioUnit, insertIndex)
        return this.#getTrackAdapter(newTrackBox)
    }

    #hasSpaceForRange(trackBox: TrackBox, position: ppqn, complete: ppqn): boolean {
        for (const vertex of trackBox.regions.pointerHub.incoming()) {
            const regionBox = UnionBoxTypes.asRegionBox(vertex.box)
            const regionPosition = regionBox.position.getValue()
            const regionComplete = regionPosition + regionBox.duration.getValue()
            if (regionComplete <= position) {continue}
            if (regionPosition >= complete) {continue}
            return false
        }
        return true
    }

    #getTrackAdapter(trackBox: TrackBox): TrackBoxAdapter {
        return this.#boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    }
}
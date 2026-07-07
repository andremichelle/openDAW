import {asDefined, assert, Exec, int, mod, panic} from "@opendaw/lib-std"
import {Event, EventCollection, ppqn, TimeBase} from "@opendaw/lib-dsp"
import {
    AnyRegionBoxAdapter,
    AudioRegionBoxAdapter,
    RegionEditing,
    TrackBoxAdapter,
    UnionAdapterTypes
} from "@opendaw/studio-adapters"
import {RegionModifyStrategies} from "./RegionModifyStrategies"
import {TrackResolver} from "./TrackResolver"

export type ClipTask = {
    type: "delete"
    region: AnyRegionBoxAdapter
} | {
    type: "separate"
    region: AnyRegionBoxAdapter
    begin: ppqn
    end: ppqn
} | {
    type: "start"
    region: AnyRegionBoxAdapter
    position: ppqn
} | {
    type: "complete"
    region: AnyRegionBoxAdapter
    position: ppqn
}

export interface Mask extends Event {complete: ppqn}

// AudioRegions in absolute time-domain are allowed to overlap. Their duration changes when the tempo changes,
// but we do not truncate them to keep the original durations.
const allowOverlap = (region: AnyRegionBoxAdapter) =>
    region instanceof AudioRegionBoxAdapter && region.timeBase !== TimeBase.Musical

// A region's duration is stored as float32, and seconds-based audio regions carry double-precision
// ppqn drift (their ppqn is derived from seconds via the tempo map, e.g. complete = mask.complete + 2e-12).
// So a clip whose remainder falls below ~one float32 ulp truncates to duration 0, and later trips
// validateTrack / createTasksFromMasks (#1003). Treat a region within this tolerance of a mask boundary
// as touching it, so it is deleted rather than clipped to a zero-width sliver. The tolerance tracks
// float32 precision at the boundary magnitude (so it scales with project length) and is musically nil.
const Float32RelativeEpsilon = 2 ** -23 // float32 has 23 mantissa bits
const boundaryTolerance = (value: ppqn): ppqn => Math.abs(value) * Float32RelativeEpsilon + 1e-3

export class RegionClipResolver {
    static fromSelection(tracks: ReadonlyArray<TrackBoxAdapter>,
                         adapters: ReadonlyArray<AnyRegionBoxAdapter>,
                         strategy: RegionModifyStrategies,
                         deltaIndex: int = 0): { postProcess: Exec, trackResolver: TrackResolver } {
        const clipResolvers: Map<int, RegionClipResolver> =
            new Map(tracks.map(track => ([track.listIndex, new RegionClipResolver(strategy, track)])))
        adapters.forEach(adapter => {
            const index = adapter.trackBoxAdapter.unwrap("trackBoxAdapter").listIndex + deltaIndex
            asDefined(clipResolvers.get(index), `Cannot find clip resolver for index(${index})`)
                .addMask(adapter)
        })
        const tasks = Array.from(clipResolvers.values()).flatMap(resolver => resolver.#createSolver())
        return {
            postProcess: () => tasks.forEach(task => task()),
            trackResolver: TrackResolver.Identity
        }
    }

    static fromRange(track: TrackBoxAdapter, position: ppqn, complete: ppqn): Exec {
        // IdentityIncludeOrigin will include selected regions
        const clipResolver = new RegionClipResolver(RegionModifyStrategies.IdentityIncludeOrigin, track)
        clipResolver.addMaskRange(position, complete)
        return clipResolver.#createSolver()
    }

    static validateTracks(tracks: ReadonlyArray<TrackBoxAdapter>): void {
        for (const track of tracks) {this.validateTrack(track)}
    }

    static validateTrack(track: TrackBoxAdapter): void {
        const array = track.regions.collection.asArray()
        if (array.length === 0) {return}
        let prev = array[0]
        assert(prev.duration > 0, `duration(${prev.duration}) must be positive`)
        for (let i = 1; i < array.length; i++) {
            const next = array[i]
            assert(next.duration > 0, `duration(${next.duration}) must be positive`)
            assert(allowOverlap(prev) || prev.complete <= next.position,
                `regions overlap: prev.complete(${prev.complete}) > next.position(${next.position})`)
            prev = next
        }
    }

    static createTasksFromMasks(regionIterator: Iterable<AnyRegionBoxAdapter>,
                                maxComplete: ppqn,
                                masks: ReadonlyArray<Mask>,
                                showOrigin: boolean): ReadonlyArray<ClipTask> {
        const tasks: Array<ClipTask> = []
        for (const region of regionIterator) {
            if (region.position >= maxComplete) {break}
            if (region.isSelected && !showOrigin) {continue}
            if (region.duration <= 0) {return panic(`Invalid duration(${region.duration})`)}
            const overlapping = masks.filter(mask => region.position < mask.complete && region.complete > mask.position)
            if (overlapping.length === 0) {continue}
            for (let i = overlapping.length - 1; i >= 0; i--) {
                const {position, complete} = overlapping[i]
                const positionIn: boolean = region.position >= position - boundaryTolerance(position)
                const completeIn: boolean = region.complete <= complete + boundaryTolerance(complete)
                if (positionIn && completeIn) {
                    tasks.push({type: "delete", region})
                    break
                } else if (!positionIn && !completeIn) {
                    tasks.push({type: "separate", region, begin: position, end: complete})
                } else if (completeIn) {
                    tasks.push({type: "complete", region, position})
                } else {
                    tasks.push({type: "start", region, position: complete})
                }
            }
        }
        return tasks
    }

    static sortAndJoinMasks(masks: ReadonlyArray<Mask>): ReadonlyArray<Mask> {
        if (masks.length === 0) {return panic("No clip-masks to solve")}
        if (masks.length === 1) {return [masks[0]]}
        // Sort by position (start time) - create a copy to avoid mutating input
        const sorted = [...masks].sort(EventCollection.DefaultComparator)
        const merged: Array<Mask> = []
        let current: Mask = sorted[0]
        for (let i = 1; i < sorted.length; i++) {
            const next = sorted[i]
            // Check if the next mask overlaps or is adjacent to the current. Use the float32 boundary
            // tolerance (see #1003): seconds-based masks carry ppqn drift, so two masks that should abut
            // can sit a sub-ulp gap apart. Merging within tolerance prevents carving the ground region
            // into a zero-width sliver between them (#287).
            if (next.position <= current.complete + boundaryTolerance(current.complete)) {
                // Merge: extend current to cover both ranges
                current = {
                    type: "range",
                    position: current.position,
                    complete: Math.max(current.complete, next.complete)
                }
            } else {
                // No overlap or adjacency: save current and move to next
                merged.push(current)
                current = next
            }
        }
        merged.push(current)
        return merged
    }

    readonly #strategy: RegionModifyStrategies
    readonly #ground: TrackBoxAdapter
    readonly #masks: Array<Mask>

    constructor(strategy: RegionModifyStrategies, ground: TrackBoxAdapter) {
        this.#strategy = strategy
        this.#ground = ground
        this.#masks = []
    }

    addMask(region: AnyRegionBoxAdapter): void {
        const strategy = this.#strategy.selectedModifyStrategy()
        this.addMaskRange(strategy.readPosition(region), strategy.readComplete(region))
    }

    addMaskRange(position: ppqn, complete: ppqn): void {
        this.#masks.push({type: "range", position, complete})
    }

    #createSolver(): Exec {
        const masks = RegionClipResolver.sortAndJoinMasks(this.#masks)
        const maxComplete = masks.reduce((max, mask) => Math.max(max, mask.complete), 0)
        const tasks = RegionClipResolver.createTasksFromMasks(
            this.#ground.regions.collection.iterateRange(0, maxComplete),
            maxComplete, masks, this.#strategy.showOrigin())
        this.#masks.length = 0
        return () => this.#executeTasks(tasks)
    }

    #executeTasks(tasks: ReadonlyArray<ClipTask>): void {
        const sorted = tasks.toSorted(({type: a}, {type: b}) => {
            if (a === "delete" && b !== "delete") {return 1}
            if (b === "delete" && a !== "delete") {return -1}
            return 0
        })
        sorted.forEach(task => {
            const {type, region} = task
            switch (type) {
                case "delete":
                    region.box.delete()
                    break
                case "start":
                    // Round the new start UP to an integer. `position` is Int32, so a fractional mask
                    // boundary (seconds-based region) would truncate on store and desync from the Float32
                    // loop fields, leaving the region overlapping the clip by the dropped fraction (#287).
                    this.#trimStart(region, Math.ceil(task.position))
                    break
                case "complete":
                    // Round the new end DOWN to an integer, for the same reason.
                    this.#trimComplete(region, Math.floor(task.position))
                    break
                case "separate": {
                    const begin = Math.floor(task.begin)
                    const end = Math.ceil(task.end)
                    const leftEmpty = begin <= region.position
                    const rightEmpty = end >= region.complete
                    if (leftEmpty && rightEmpty) {region.box.delete()}
                    else if (leftEmpty) {this.#trimStart(region, end)}
                    else if (rightEmpty) {this.#trimComplete(region, begin)}
                    else {RegionEditing.clip(region, begin, end)}
                    break
                }
            }
        })
    }

    #trimStart(region: AnyRegionBoxAdapter, position: ppqn): void {
        if (!UnionAdapterTypes.isLoopableRegion(region)) {return panic("Not yet implemented")}
        if (position >= region.complete) {return region.box.delete()}
        const delta = position - region.position
        const oldDuration = region.duration
        const oldLoopOffset = region.loopOffset
        const oldLoopDuration = region.loopDuration
        region.position = position
        region.duration = oldDuration - delta
        region.loopOffset = mod(oldLoopOffset + delta, oldLoopDuration)
    }

    #trimComplete(region: AnyRegionBoxAdapter, complete: ppqn): void {
        if (!UnionAdapterTypes.isLoopableRegion(region)) {return panic("Not yet implemented")}
        if (complete <= region.position) {return region.box.delete()}
        region.duration = complete - region.position
    }
}
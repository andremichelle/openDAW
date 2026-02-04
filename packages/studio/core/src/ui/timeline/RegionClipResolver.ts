import {asDefined, assert, Exec, int, mod, panic} from "@opendaw/lib-std"
import {Event, EventCollection, ppqn, TimeBase} from "@opendaw/lib-dsp"
import {
    AnyRegionBoxAdapter,
    AudioRegionBoxAdapter,
    RegionEditing,
    TrackBoxAdapter,
    TrackType,
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

interface Mask extends Event {complete: ppqn}

// AudioRegions in absolute time-domain are allowed to overlap. Their duration changes when the tempo changes,
// but we do not truncate them to keep the original durations.
const allowOverlap = (region: AnyRegionBoxAdapter) =>
    region instanceof AudioRegionBoxAdapter && region.timeBase !== TimeBase.Musical

export class RegionClipResolver {
    static fromSelection(tracks: ReadonlyArray<TrackBoxAdapter>,
                         adapters: ReadonlyArray<AnyRegionBoxAdapter>,
                         strategy: RegionModifyStrategies,
                         deltaIndex: int = 0): { postProcess: Exec, trackResolver: TrackResolver } {
        const clipResolvers: Map<int, RegionClipResolver> =
            new Map(tracks.map(track => ([track.listIndex, new RegionClipResolver(strategy, track)])))
        adapters.forEach(adapter => {
            const index = adapter.trackBoxAdapter.unwrap().listIndex + deltaIndex
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
        try {
            let prev = array[0]
            assert(prev.duration > 0, `duration(${prev.duration}) must be positive`)
            for (let i = 1; i < array.length; i++) {
                const next = array[i]
                assert(next.duration > 0, `duration(${next.duration}) must be positive`)
                if (!allowOverlap(prev) && prev.complete > next.position) {
                    return panic("Overlapping detected after clipping")
                }
                prev = next
            }
        } catch (error: any) {
            console.error(JSON.stringify({
                track: TrackType[track.type],
                regions: array.map(x => ({p: x.position, d: x.duration}))
            }))
            throw error
        }
    }

    static sortAndJoinMasks(masks: ReadonlyArray<Mask>): ReadonlyArray<Mask> {
        if (masks.length === 0) {
            return panic("No clip-masks to solve")
        }

        if (masks.length === 1) {
            return [masks[0]]
        }

        // Sort by position (start time) - create a copy to avoid mutating input
        const sorted = [...masks].sort(EventCollection.DefaultComparator)

        const merged: Array<Mask> = []
        let current: Mask = sorted[0]

        for (let i = 1; i < sorted.length; i++) {
            const next = sorted[i]
            // Check if the next mask overlaps or is adjacent to the current
            if (next.position <= current.complete) {
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
        const tasks = this.#createTasksFromMasks(RegionClipResolver.sortAndJoinMasks(this.#masks))
        this.#masks.length = 0
        return () => this.#executeTasks(tasks)
    }

    #createTasksFromMasks(masks: ReadonlyArray<Mask>): ReadonlyArray<ClipTask> {
        const tasks: Array<ClipTask> = []
        masks.forEach(({position, complete}) => {
            // Iterate from 0 to find all regions that OVERLAP with [position, complete],
            // not just regions that START within that range
            for (const region of this.#ground.regions.collection.iterateRange(0, complete)) {
                if (region.position >= complete) {break} // past the mask, done
                if (region.complete <= position) {continue} // ends before mask, skip
                if (region.isSelected && !this.#strategy.showOrigin()) {
                    continue
                } else if (region.duration <= 0) {
                    return panic(`Invalid duration(${region.duration})`)
                }
                const positionIn: boolean = region.position >= position
                const completeIn: boolean = region.complete <= complete
                if (positionIn && completeIn) {
                    tasks.push({type: "delete", region})
                } else if (!positionIn && !completeIn) {
                    tasks.push({type: "separate", region, begin: position, end: complete})
                } else if (completeIn) {
                    tasks.push({type: "complete", region, position})
                } else {
                    tasks.push({type: "start", region, position: complete})
                }
            }
        })
        return tasks
    }

    #executeTasks(tasks: ReadonlyArray<ClipTask>): void {
        tasks
            .toSorted(({type: a}, {type: b}) => {
                if (a === "delete" && b !== "delete") {return 1}
                if (b === "delete" && a !== "delete") {return -1}
                return 0
            })
            .forEach(task => {
                const {type, region} = task
                switch (type) {
                    case "delete":
                        region.box.delete()
                        break
                    case "start":
                        if (UnionAdapterTypes.isLoopableRegion(region)) {
                            const delta = task.position - region.position
                            // Capture old values BEFORE changing position (they depend on position for TimeBase.Seconds)
                            const oldDuration = region.duration
                            const oldLoopOffset = region.loopOffset
                            const oldLoopDuration = region.loopDuration
                            region.position = region.position + delta
                            region.duration = oldDuration - delta
                            region.loopOffset = mod(oldLoopOffset + delta, oldLoopDuration)
                        } else {
                            return panic("Not yet implemented")
                        }
                        break
                    case "complete":
                        if (UnionAdapterTypes.isLoopableRegion(region)) {
                            region.duration = task.position - task.region.position
                        } else {
                            return panic("Not yet implemented")
                        }
                        break
                    case "separate":
                        RegionEditing.clip(region, task.begin, task.end)
                        break
                }
            })
    }
}
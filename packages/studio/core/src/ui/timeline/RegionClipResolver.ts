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

export interface Mask extends Event {complete: ppqn}

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
        console.debug("[ClipResolver.fromSelection]", {
            tracks: tracks.map(track => track.listIndex),
            adapters: adapters.map(adapter => ({p: adapter.position, d: adapter.duration, c: adapter.complete})),
            deltaIndex
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
            console.error("[validateTrack] OVERLAP", JSON.stringify({
                track: TrackType[track.type],
                regions: array.map(region => ({
                    p: region.position,
                    d: region.duration,
                    c: region.complete,
                    sel: region.isSelected,
                    type: region.constructor.name
                }))
            }))
            throw error
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
                const positionIn: boolean = region.position >= position
                const completeIn: boolean = region.complete <= complete
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
        const masks = RegionClipResolver.sortAndJoinMasks(this.#masks)
        const maxComplete = masks.reduce((max, mask) => Math.max(max, mask.complete), 0)
        const allRegions = this.#ground.regions.collection.asArray()
        const tasks = RegionClipResolver.createTasksFromMasks(
            this.#ground.regions.collection.iterateRange(0, maxComplete),
            maxComplete, masks, this.#strategy.showOrigin())
        console.debug("[ClipResolver.#createSolver]", {
            trackIndex: this.#ground.listIndex,
            masks: masks.map(mask => ({p: mask.position, c: mask.complete})),
            maxComplete,
            showOrigin: this.#strategy.showOrigin(),
            allRegions: allRegions.map(region => ({
                p: region.position, d: region.duration, c: region.complete, sel: region.isSelected
            })),
            tasks: tasks.map(task => {
                const base = {type: task.type, regionP: task.region.position, regionC: task.region.complete}
                if (task.type === "separate") {return {...base, begin: task.begin, end: task.end}}
                if (task.type === "start" || task.type === "complete") {return {...base, position: task.position}}
                return base
            })
        })
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
            const before = {p: region.position, d: region.duration, c: region.complete}
            switch (type) {
                case "delete":
                    region.box.delete()
                    console.debug("[ClipResolver.exec] delete", before)
                    break
                case "start":
                    if (UnionAdapterTypes.isLoopableRegion(region)) {
                        const delta = task.position - region.position
                        const oldDuration = region.duration
                        const oldLoopOffset = region.loopOffset
                        const oldLoopDuration = region.loopDuration
                        region.position = region.position + delta
                        region.duration = oldDuration - delta
                        region.loopOffset = mod(oldLoopOffset + delta, oldLoopDuration)
                        console.debug("[ClipResolver.exec] start", {before, after: {p: region.position, d: region.duration, c: region.complete}})
                    } else {
                        return panic("Not yet implemented")
                    }
                    break
                case "complete":
                    if (UnionAdapterTypes.isLoopableRegion(region)) {
                        region.duration = task.position - task.region.position
                        console.debug("[ClipResolver.exec] complete", {before, after: {p: region.position, d: region.duration, c: region.complete}})
                    } else {
                        return panic("Not yet implemented")
                    }
                    break
                case "separate":
                    console.debug("[ClipResolver.exec] separate", {before, begin: task.begin, end: task.end})
                    RegionEditing.clip(region, task.begin, task.end)
                    break
            }
        })
        console.debug("[ClipResolver.exec] done", {
            trackIndex: this.#ground.listIndex,
            result: this.#ground.regions.collection.asArray().map(region => ({
                p: region.position, d: region.duration, c: region.complete, sel: region.isSelected
            }))
        })
    }
}
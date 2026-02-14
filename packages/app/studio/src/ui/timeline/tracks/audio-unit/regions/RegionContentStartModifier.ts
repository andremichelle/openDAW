import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {Arrays, int, isNotNull, Option} from "@opendaw/lib-std"
import {ppqn, PPQN, RegionCollection} from "@opendaw/lib-dsp"
import {
    AnyLoopableRegionBoxAdapter,
    AnyRegionBoxAdapter,
    TrackBoxAdapter,
    UnionAdapterTypes
} from "@opendaw/studio-adapters"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {Project, RegionModifyStrategy} from "@opendaw/studio-core"
import {Dragging} from "@opendaw/lib-dom"

class SelectedModifyStrategy implements RegionModifyStrategy {
    readonly #tool: RegionContentStartModifier

    constructor(tool: RegionContentStartModifier) {this.#tool = tool}

    readPosition(region: AnyRegionBoxAdapter): ppqn {
        const position = region.position + this.#computeDelta(region)
        return region.trackBoxAdapter.map(trackAdapter => trackAdapter.regions.collection
            .lowerEqual(region.position, prev => prev !== region && prev.isSelected)).match({
            none: () => position,
            some: prev => position < prev.complete ? prev.complete : position
        })
    }
    readComplete(region: AnyRegionBoxAdapter): ppqn {return region.complete}
    readLoopOffset(region: AnyLoopableRegionBoxAdapter): ppqn {
        // just for the preview. it behaves like having an effect-offset
        return region.loopOffset + this.#computeDelta(region)
    }
    readLoopDuration(region: AnyLoopableRegionBoxAdapter): ppqn {
        return region.loopDuration - this.#computeDelta(region)
    }
    readMirror(region: AnyRegionBoxAdapter): boolean {return region.isMirrowed}
    translateTrackIndex(value: int): int {return value}
    iterateRange<R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(from, this.#tool.adapters.reduce((to, adapter) => Math.max(to, adapter.complete), to))
    }

    #computeDelta(region: AnyRegionBoxAdapter): ppqn {
        if (!UnionAdapterTypes.isLoopableRegion(region) || !region.canResize) {return 0}
        return this.#tool.delta
    }
}

type Construct = Readonly<{
    project: Project
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    reference: AnyRegionBoxAdapter
}>

export class RegionContentStartModifier implements RegionModifier {
    static create(selected: ReadonlyArray<AnyRegionBoxAdapter>, construct: Construct): Option<RegionContentStartModifier> {
        const adapters = selected.filter(region => UnionAdapterTypes.isLoopableRegion(region) && region.canResize)
        return adapters.length === 0 ? Option.None : Option.wrap(new RegionContentStartModifier(construct, adapters))
    }

    readonly #project: Project
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: AnyRegionBoxAdapter
    readonly #adapters: ReadonlyArray<AnyLoopableRegionBoxAdapter>
    readonly #selectedModifyStrategy: SelectedModifyStrategy

    #delta: ppqn

    private constructor({project, element, snapping, pointerPulse, reference}: Construct,
                        adapters: ReadonlyArray<AnyLoopableRegionBoxAdapter>) {
        this.#project = project
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference
        this.#adapters = adapters
        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)

        this.#delta = 0
    }

    get delta(): ppqn {return this.#delta}
    get snapping(): Snapping {return this.#snapping}
    get adapters(): ReadonlyArray<AnyLoopableRegionBoxAdapter> {return this.#adapters}
    get reference(): AnyRegionBoxAdapter {return this.#reference}

    showOrigin(): boolean {return false}
    selectedModifyStrategy(): RegionModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): RegionModifyStrategy {return RegionModifyStrategy.Identity}

    update({clientX}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const newDelta = this.#snapping.computeDelta(
            this.#pointerPulse, clientX - clientRect.left, this.#reference.position)
        const clampedDelta = Math.max(this.#computeMinDelta(), Math.min(newDelta, this.#computeMaxDelta()))
        if (this.#delta !== clampedDelta) {
            this.#delta = clampedDelta
            this.#dispatchChange()
        }
    }

    #computeMaxDelta(): ppqn {
        return this.#adapters.reduce((maxDelta, adapter) => {
            const maxByDuration = adapter.duration - PPQN.SemiQuaver
            const maxByLoopDuration = adapter.loopDuration - PPQN.SemiQuaver
            return Math.min(maxDelta, maxByDuration, maxByLoopDuration)
        }, Infinity)
    }

    #computeMinDelta(): ppqn {
        return this.#adapters.reduce((minDelta, adapter) => Math.max(minDelta, -adapter.position), -Infinity)
    }

    approve(): void {
        if (this.#delta === 0) {return}
        const adapters = this.#adapters.filter(({box}) => box.isAttached())
        if (adapters.length === 0) {return}
        const modifiedTracks: ReadonlyArray<TrackBoxAdapter> = Arrays.removeDuplicates(adapters
            .map(adapter => adapter.trackBoxAdapter.unwrapOrNull()).filter(isNotNull))
        const regionSnapshot = (region: AnyRegionBoxAdapter) =>
            ({p: region.position, d: region.duration, s: region.isSelected})
        const trackSnapshots = modifiedTracks.map(track => ({
            trackIndex: track.listIndex,
            before: track.regions.collection.asArray().map(regionSnapshot)
        }))
        const result = adapters.map(region => {
            const readPos = this.#selectedModifyStrategy.readPosition(region)
            return {region, delta: readPos - region.position, readPos, readComplete: region.complete}
        })
        console.debug("[ContentStartModifier.approve]", {
            toolDelta: this.#delta,
            masks: result.map(entry => ({readPos: entry.readPos, readComplete: entry.readComplete, delta: entry.delta})),
            trackSnapshots
        })
        this.#project.overlapResolver.apply(modifiedTracks, adapters, this, 0, () => {
            result.forEach(({region, delta}) => region.moveContentStart(delta))
        })
        console.debug("[ContentStartModifier.approve] after", {
            tracks: modifiedTracks.map(track => ({
                trackIndex: track.listIndex,
                regions: track.regions.collection.asArray().map(regionSnapshot)
            }))
        })
    }

    cancel(): void {
        this.#delta = 0
        this.#dispatchChange()
    }

    toString(): string {return `RegionContentStartModifier{delta: ${this.#delta}}`}

    #dispatchChange(): void {
        this.#adapters.forEach(adapter => adapter.trackBoxAdapter
            .ifSome(trackAdapter => trackAdapter.regions.dispatchChange()))
    }
}
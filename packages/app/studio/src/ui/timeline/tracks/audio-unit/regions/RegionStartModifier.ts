import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {Arrays, int, isNotNull, mod, Option} from "@opendaw/lib-std"
import {ppqn, RegionCollection} from "@opendaw/lib-dsp"
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
    readonly #tool: RegionStartModifier

    constructor(tool: RegionStartModifier) {this.#tool = tool}

    readPosition(region: AnyRegionBoxAdapter): ppqn {return region.position + this.computeClampedDelta(region)}
    readComplete(region: AnyRegionBoxAdapter): ppqn {return region.complete}
    readLoopOffset(region: AnyLoopableRegionBoxAdapter): ppqn {
        const newPosition = this.readPosition(region)
        return mod(region.loopOffset + this.computeClampedDelta(region), region.resolveLoopDuration(newPosition))
    }
    readLoopDuration(region: AnyLoopableRegionBoxAdapter): ppqn {return region.resolveLoopDuration(this.readPosition(region))}
    readMirror(region: AnyRegionBoxAdapter): boolean {return region.isMirrowed}
    translateTrackIndex(value: int): int {return value}
    iterateRange<R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(from, this.#tool.adapters.reduce((to, adapter) => Math.max(to, adapter.complete), to))
    }

    computeClampedDelta(region: AnyLoopableRegionBoxAdapter): int {
        if (!region.canResize) {return 0}
        let position = (this.#tool.aligned ? this.#tool.reference.position : region.position) + this.#tool.deltaStart
        region.trackBoxAdapter.map(trackAdapter => trackAdapter.regions.collection
            .lowerEqual(region.position - 1, region => region.isSelected))
            .ifSome(region => {
                if (position < region.complete) {
                    position = region.complete
                }
            })
        const min = Math.min(region.duration, this.#tool.snapping.value(region.position))
        return Math.max(region.duration - Math.max(min, region.complete - position), -region.position)
    }
}

type Construct = Readonly<{
    project: Project
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    reference: AnyRegionBoxAdapter
}>

export class RegionStartModifier implements RegionModifier {
    static create(selected: ReadonlyArray<AnyRegionBoxAdapter>, construct: Construct): Option<RegionStartModifier> {
        const adapters = selected.filter(region => UnionAdapterTypes.isLoopableRegion(region))
        return adapters.length === 0 ? Option.None : Option.wrap(new RegionStartModifier(construct, adapters))
    }

    readonly #project: Project
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: AnyRegionBoxAdapter
    readonly #adapters: ReadonlyArray<AnyLoopableRegionBoxAdapter>
    readonly #selectedModifyStrategy: SelectedModifyStrategy

    #aligned: boolean
    #deltaStart: int

    private constructor({project, element, snapping, pointerPulse, reference}: Construct,
                        adapter: ReadonlyArray<AnyLoopableRegionBoxAdapter>) {
        this.#project = project
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference
        this.#adapters = adapter
        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)

        this.#aligned = false
        this.#deltaStart = 0
    }

    get aligned(): boolean {return this.#aligned}
    get deltaStart(): int {return this.#deltaStart}
    get snapping(): Snapping {return this.#snapping}
    get adapters(): ReadonlyArray<AnyLoopableRegionBoxAdapter> {return this.#adapters}
    get reference(): AnyRegionBoxAdapter {return this.#reference}

    showOrigin(): boolean {return false}
    selectedModifyStrategy(): RegionModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): RegionModifyStrategy {return RegionModifyStrategy.Identity}

    update({clientX, ctrlKey}: Dragging.Event): void {
        const aligned = ctrlKey
        const deltaStart = this.#snapping.computeDelta(
            this.#pointerPulse, clientX - this.#element.getBoundingClientRect().left, this.#reference.position)
        let change = false
        if (this.#aligned !== aligned) {
            this.#aligned = aligned
            change = true
        }
        if (this.#deltaStart !== deltaStart) {
            this.#deltaStart = deltaStart
            change = true
        }
        if (change) {this.#dispatchChange()}
    }

    approve(): void {
        const modifiedTracks: ReadonlyArray<TrackBoxAdapter> = Arrays.removeDuplicates(this.#adapters
            .map(adapter => adapter.trackBoxAdapter.unwrapOrNull()).filter(isNotNull))
        const adapters = this.#adapters.filter(({box}) => box.isAttached())
        const result = this.#adapters.map<{ region: AnyLoopableRegionBoxAdapter, delta: ppqn }>(region =>
            ({region, delta: this.#selectedModifyStrategy.computeClampedDelta(region)}))
        this.#project.overlapResolver.apply(modifiedTracks, adapters, this, 0, (_trackResolver) => {
            result.forEach(({region, delta}) => {
                region.position += delta
                region.duration -= delta
                region.loopOffset = mod(region.loopOffset + delta, region.loopDuration)
            })
        })
    }

    cancel(): void {
        this.#aligned = false
        this.#deltaStart = 0
        this.#dispatchChange()
    }

    toString(): string {
        return `RegionStartModifier{aligned: ${this.#aligned}, deltaStart: ${this.#deltaStart}}`
    }

    #dispatchChange(): void {
        this.#adapters.forEach(adapter => adapter.trackBoxAdapter
            .ifSome(trackAdapter => trackAdapter.regions.dispatchChange()))
    }
}
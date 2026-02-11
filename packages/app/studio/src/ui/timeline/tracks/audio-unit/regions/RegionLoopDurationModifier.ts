import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {Arrays, int, Option} from "@opendaw/lib-std"
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
    readonly #tool: RegionLoopDurationModifier

    constructor(tool: RegionLoopDurationModifier) {this.#tool = tool}

    readPosition(region: AnyRegionBoxAdapter): ppqn {return region.position}
    readDuration(region: AnyLoopableRegionBoxAdapter): ppqn {
        return this.readComplete(region) - this.readPosition(region)
    }
    readComplete(region: AnyLoopableRegionBoxAdapter): ppqn {
        const newLoopDuration = this.readLoopDuration(region)
        const duration = newLoopDuration <= region.loopDuration
            ? region.duration
            : Math.max(region.duration, newLoopDuration - region.loopOffset)
        const complete = region.position + duration
        return region.trackBoxAdapter.map(trackAdapter => trackAdapter.regions.collection
            .greaterEqual(region.complete, region => region.isSelected)).match({
            none: () => complete,
            some: region => complete > region.position ? region.position : complete
        })
    }
    readLoopOffset(region: AnyLoopableRegionBoxAdapter): ppqn {return region.loopOffset}
    readLoopDuration(region: AnyLoopableRegionBoxAdapter): ppqn {
        if (!region.canResize) {return region.loopDuration}
        return Math.max(Math.min(PPQN.SemiQuaver, region.loopDuration),
            region.loopDuration + this.#tool.deltaLoopDuration)
    }
    readMirror(region: AnyRegionBoxAdapter): boolean {return region.isMirrowed}
    translateTrackIndex(value: int): int {return value}
    iterateRange<R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(
            this.#tool.adapters.reduce((from, adapter) => Math.min(from, adapter.position), from), to)
    }
}

type Construct = Readonly<{
    project: Project
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    reference: AnyRegionBoxAdapter
    resize: boolean
}>

type BeforeState = { region: AnyLoopableRegionBoxAdapter, duration: ppqn, loopDuration: ppqn }

export class RegionLoopDurationModifier implements RegionModifier {
    static create(selected: ReadonlyArray<AnyRegionBoxAdapter>, construct: Construct): Option<RegionLoopDurationModifier> {
        const adapters = selected.filter(region => UnionAdapterTypes.isLoopableRegion(region))
        return adapters.length === 0 ? Option.None : Option.wrap(new RegionLoopDurationModifier(construct, adapters))
    }

    readonly #project: Project
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: AnyRegionBoxAdapter
    readonly #resize: boolean
    readonly #adapters: ReadonlyArray<AnyLoopableRegionBoxAdapter>
    readonly #selectedModifyStrategy: SelectedModifyStrategy

    #deltaLoopDuration: int

    private constructor({project, element, snapping, pointerPulse, reference, resize}: Construct,
                        adapter: ReadonlyArray<AnyLoopableRegionBoxAdapter>) {
        this.#project = project
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference
        this.#resize = resize
        this.#adapters = adapter
        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)

        this.#deltaLoopDuration = 0
    }

    get snapping(): Snapping {return this.#snapping}
    get deltaLoopDuration(): int {return this.#deltaLoopDuration}
    get reference(): AnyRegionBoxAdapter {return this.#reference}
    get adapters(): ReadonlyArray<AnyLoopableRegionBoxAdapter> {return this.#adapters}

    showOrigin(): boolean {return false}
    selectedModifyStrategy(): RegionModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): RegionModifyStrategy {return RegionModifyStrategy.Identity}

    update({clientX}: Dragging.Event): void {
        const {position, complete, loopOffset, loopDuration} = this.#reference
        const delta = this.#resize ? complete - (position + loopDuration - loopOffset) : 0
        const clientRect = this.#element.getBoundingClientRect()
        const deltaDuration = this.#snapping.computeDelta(
            this.#pointerPulse - delta, clientX - clientRect.left, loopDuration)
        let change = false
        if (this.#deltaLoopDuration !== deltaDuration) {
            this.#deltaLoopDuration = deltaDuration
            change = true
        }
        if (change) {this.#dispatchChange()}
    }

    approve(): void {
        const modifiedTracks: ReadonlyArray<TrackBoxAdapter> =
            Arrays.removeDuplicates(this.#adapters.map(adapter => adapter.trackBoxAdapter.unwrap()))
        const result = this.#adapters.map<BeforeState>(region =>
            ({
                region,
                duration: this.#selectedModifyStrategy.readDuration(region),
                loopDuration: this.#selectedModifyStrategy.readLoopDuration(region)
            }))
        this.#project.overlapResolver.apply(modifiedTracks, this.#adapters, this, 0, (_trackResolver) => {
            result.forEach(({region, duration, loopDuration}) => {
                region.duration = duration
                region.loopDuration = loopDuration
            })
        })
    }

    cancel(): void {
        this.#deltaLoopDuration = 0
        this.#dispatchChange()
    }

    toString(): string {
        return `RegionLoopDurationModifier{deltaLoopDuration: ${this.#deltaLoopDuration}}`
    }

    #dispatchChange(): void {
        this.#adapters.forEach(adapter => adapter.trackBoxAdapter.unwrap().regions.dispatchChange())
    }
}
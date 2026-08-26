import {int, Option} from "@opendaw/lib-std"
import {ppqn, RegionCollection} from "@opendaw/lib-dsp"
import {AnyLoopableRegionBoxAdapter, AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {Project, RegionModifyStrategy} from "@opendaw/studio-core"
import {Dragging} from "@opendaw/lib-dom"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {RegionModifierSelection} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifierSelection.ts"

class SelectedModifyStrategy implements RegionModifyStrategy {
    readonly #tool: RegionMoveInTrackModifier

    constructor(tool: RegionMoveInTrackModifier) {this.#tool = tool}

    readPosition(region: AnyRegionBoxAdapter): ppqn {return region.position + this.#tool.deltaPosition}
    readComplete(region: AnyRegionBoxAdapter): ppqn {return region.resolveComplete(this.readPosition(region))}
    readLoopOffset(region: AnyLoopableRegionBoxAdapter): ppqn {return region.loopOffset}
    readLoopDuration(region: AnyLoopableRegionBoxAdapter): ppqn {
        return region.resolveLoopDuration(this.readPosition(region))
    }
    readMirror(region: AnyRegionBoxAdapter): boolean {return region.isMirrowed}
    translateTrackIndex(value: int): int {return value}
    iterateRange<R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        const deltaPosition = this.#tool.deltaPosition
        return regions.iterateRange(from - deltaPosition, to - deltaPosition)
    }
}

type Construct = Readonly<{
    project: Project
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    reference: AnyRegionBoxAdapter
}>

export class RegionMoveInTrackModifier implements RegionModifier {
    static create(selected: ReadonlyArray<AnyRegionBoxAdapter>,
                  construct: Construct): Option<RegionMoveInTrackModifier> {
        return selected.length === 0 ? Option.None : Option.wrap(new RegionMoveInTrackModifier(construct, selected))
    }

    readonly #project: Project
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #reference: AnyRegionBoxAdapter
    readonly #adapters: ReadonlyArray<AnyRegionBoxAdapter>
    readonly #selectedModifyStrategy: SelectedModifyStrategy

    #deltaPosition: ppqn

    private constructor({project, element, snapping, pointerPulse, reference}: Construct,
                        adapters: ReadonlyArray<AnyRegionBoxAdapter>) {
        this.#project = project
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#reference = reference
        this.#adapters = adapters
        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)

        this.#deltaPosition = 0
    }

    get deltaPosition(): ppqn {return this.#deltaPosition}
    get snapping(): Snapping {return this.#snapping}
    get adapters(): ReadonlyArray<AnyRegionBoxAdapter> {return this.#adapters}
    get reference(): AnyRegionBoxAdapter {return this.#reference}

    showOrigin(): boolean {return false}
    selectedModifyStrategy(): RegionModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): RegionModifyStrategy {return RegionModifyStrategy.Identity}

    update({clientX}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const deltaPosition = this.#adapters.reduce((delta, adapter) => Math.max(delta, -adapter.position),
            this.#snapping.computeDelta(this.#pointerPulse, clientX - clientRect.left, this.#reference.position))
        if (this.#deltaPosition !== deltaPosition) {
            this.#deltaPosition = deltaPosition
            this.#dispatchChange()
        }
    }

    approve(): void {
        if (this.#deltaPosition === 0) {return}
        // Delete or Undo mid-drag orphans what this drag captured. Applying to the survivors would commit
        // a partial edit nobody asked for, so the drag is abandoned instead.
        if (!RegionModifierSelection.isIntact(this.#adapters)) {return this.cancel()}
        const adapters = this.#adapters
        const deltaPosition = this.#deltaPosition
        const modifiedTracks: ReadonlyArray<TrackBoxAdapter> = RegionModifierSelection.tracksOf(adapters)
        this.#project.overlapResolver.apply(modifiedTracks, adapters, this, 0, () =>
            adapters.forEach(adapter => adapter.position += deltaPosition))
    }

    cancel(): void {
        this.#deltaPosition = 0
        this.#dispatchChange()
    }

    toString(): string {return `RegionMoveInTrackModifier{deltaPosition: ${this.#deltaPosition}}`}

    #dispatchChange(): void {
        this.#adapters.forEach(adapter => adapter.trackBoxAdapter
            .ifSome(trackAdapter => trackAdapter.regions.dispatchChange()))
    }
}

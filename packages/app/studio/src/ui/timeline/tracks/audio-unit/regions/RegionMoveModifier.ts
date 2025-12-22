import {Arrays, clamp, int, Option, Selection} from "@opendaw/lib-std"
import {AnyLoopableRegionBoxAdapter, AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {ppqn, RegionCollection} from "@opendaw/lib-dsp"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {BoxEditing} from "@opendaw/lib-box"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {RegionClipResolver, RegionModifyStrategy} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {Dragging} from "@opendaw/lib-dom"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier"

class SelectedModifyStrategy implements RegionModifyStrategy {
    readonly #tool: RegionMoveModifier

    constructor(tool: RegionMoveModifier) {this.#tool = tool}

    translateTrackIndex(index: int): int {return index - this.#tool.deltaIndex}
    readPosition(region: AnyRegionBoxAdapter): ppqn {return region.position + this.#tool.deltaPosition}
    readComplete(region: AnyRegionBoxAdapter): ppqn {return region.resolveComplete(this.readPosition(region))}
    readLoopDuration(region: AnyLoopableRegionBoxAdapter): ppqn {return region.resolveLoopDuration(this.readPosition(region))}
    readMirror(region: AnyRegionBoxAdapter): boolean {return region.canMirror && region.isMirrowed !== this.#tool.mirroredCopy}
    readLoopOffset(region: AnyLoopableRegionBoxAdapter): ppqn {return region.resolveLoopOffset(this.readPosition(region))}
    iterateRange<R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(from - this.#tool.deltaPosition, to - this.#tool.deltaPosition)
    }
}

class UnselectedStrategy implements RegionModifyStrategy {
    readonly #tool: RegionMoveModifier

    constructor(tool: RegionMoveModifier) {this.#tool = tool}

    translateTrackIndex(index: int): int {return index}
    readPosition(region: AnyRegionBoxAdapter): ppqn {return region.position}
    readComplete(region: AnyRegionBoxAdapter): ppqn {return region.resolveComplete(this.readPosition(region))}
    readLoopDuration(region: AnyLoopableRegionBoxAdapter): ppqn {return region.resolveLoopDuration(this.readPosition(region))}
    readMirror(region: AnyRegionBoxAdapter): boolean {return region.canMirror && (region.isMirrowed || (region.isSelected && this.#tool.mirroredCopy))}
    readLoopOffset(region: AnyLoopableRegionBoxAdapter): ppqn {return region.resolveLoopOffset(this.readPosition(region))}
    iterateRange<R extends AnyRegionBoxAdapter>(regions: RegionCollection<R>, from: ppqn, to: ppqn): Iterable<R> {
        return regions.iterateRange(from, to)
    }
}

type Construct = Readonly<{
    element: Element
    snapping: Snapping
    pointerPulse: ppqn
    pointerIndex: int
    reference: AnyRegionBoxAdapter
}>

export class RegionMoveModifier implements RegionModifier {
    static create(trackManager: TracksManager, selection: Selection<AnyRegionBoxAdapter>, construct: Construct): Option<RegionMoveModifier> {
        return selection.isEmpty()
            ? Option.None
            : Option.wrap(new RegionMoveModifier(trackManager, selection, construct))
    }

    readonly #manager: TracksManager
    readonly #selection: Selection<AnyRegionBoxAdapter>
    readonly #element: Element
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #pointerIndex: int
    readonly #reference: AnyRegionBoxAdapter

    readonly #selectedModifyStrategy: RegionModifyStrategy
    readonly #unselectedModifyStrategy: RegionModifyStrategy

    #copy: boolean
    #mirroredCopy: boolean
    #deltaIndex: int
    #deltaPosition: ppqn

    private constructor(trackManager: TracksManager,
                        selection: Selection<AnyRegionBoxAdapter>,
                        {element, snapping, pointerPulse, pointerIndex, reference}: Construct) {
        this.#manager = trackManager
        this.#selection = selection
        this.#element = element
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#pointerIndex = pointerIndex
        this.#reference = reference

        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)
        this.#unselectedModifyStrategy = new UnselectedStrategy(this)

        this.#copy = false
        this.#mirroredCopy = false
        this.#deltaIndex = 0
        this.#deltaPosition = 0
    }

    get copy(): boolean {return this.#copy}
    get mirroredCopy(): boolean {return this.#mirroredCopy && this.#copy}
    get deltaIndex(): int {return this.#deltaIndex}
    get deltaPosition(): ppqn {return this.#deltaPosition}

    showOrigin(): boolean {return this.#copy}
    selectedModifyStrategy(): RegionModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): RegionModifyStrategy {return this.#unselectedModifyStrategy}

    update({clientX, clientY, altKey, shiftKey}: Dragging.Event): void {
        const adapters = this.#selection.selected()
        const maxIndex = this.#manager.numTracks() - 1
        const clientRect = this.#element.getBoundingClientRect()
        const deltaIndex: int = adapters.reduce((delta, adapter) => {
            const listIndex = adapter.trackBoxAdapter.unwrap().listIndex
            return clamp(delta, -listIndex, maxIndex - listIndex)
        }, this.#manager.globalToIndex(clientY) - this.#pointerIndex)
        const deltaPosition: int = adapters.reduce((delta, adapter) =>
            Math.max(delta, -adapter.position), this.#snapping
            .computeDelta(this.#pointerPulse, clientX - clientRect.left, this.#reference.position))
        let change = false
        if (this.#deltaPosition !== deltaPosition) {
            this.#deltaPosition = deltaPosition
            change = true
        }
        if (this.#deltaIndex !== deltaIndex) {
            this.#dispatchShiftedTrackChange(this.#deltaIndex) // removes old preview
            this.#deltaIndex = deltaIndex
            change = true
        }
        if (this.#copy !== altKey) {
            this.#copy = altKey
            change = true
        }
        if (this.#mirroredCopy !== shiftKey) {
            this.#mirroredCopy = shiftKey
            change = true
        }
        if (change) {this.#dispatchChange()}
    }

    approve(editing: BoxEditing): void {
        if (this.#deltaIndex === 0 && this.#deltaPosition === 0) {
            if (this.#copy) {this.#dispatchChange()} // reset visuals
            return
        }
        const adapters = this.#selection.selected()
        if (!adapters.every(adapter => {
            const trackIndex = adapter.trackBoxAdapter.unwrap().listIndex + this.#deltaIndex
            const trackAdapter = this.#manager.getByIndex(trackIndex).unwrap().trackBoxAdapter
            return trackAdapter.accepts(adapter)
        })) {
            this.cancel()
            Dialogs.info({message: "Cannot move region to different track type."}).finally()
            return
        }
        const modifiedTracks: ReadonlyArray<TrackBoxAdapter> = Arrays.removeDuplicates(adapters
            .map(adapter => adapter.trackBoxAdapter.unwrap().listIndex + this.#deltaIndex))
            .map(index => this.#manager.getByIndex(index).unwrap().trackBoxAdapter)
        const solver = RegionClipResolver.fromSelection(modifiedTracks, adapters, this, this.#deltaIndex)
        editing.modify(() => {
            if (this.#copy) {
                const copies: ReadonlyArray<AnyRegionBoxAdapter> = adapters.map(original => {
                    return original.copyTo({
                        position: original.position + this.#deltaPosition,
                        track: this.#deltaIndex === 0 ? undefined : this.#manager
                            .getByIndex(original.trackBoxAdapter.unwrap().listIndex + this.#deltaIndex)
                            .unwrap().trackBoxAdapter.box.regions,
                        consolidate: original.isMirrowed === this.#mirroredCopy
                    })
                })
                this.#selection.deselectAll()
                this.#selection.select(...copies)
            } else {
                if (this.#deltaIndex !== 0) {
                    adapters
                        .forEach(adapter => adapter.box.regions
                            .refer(this.#manager.getByIndex(adapter.trackBoxAdapter.unwrap().listIndex + this.#deltaIndex)
                                .unwrap().trackBoxAdapter.box.regions))
                }
                adapters.forEach((adapter) => adapter.position += this.#deltaPosition)
            }
            solver()
        })
        RegionClipResolver.validateTracks(modifiedTracks)
    }

    cancel(): void {this.#dispatchChange()}

    toString(): string {
        return `RegionMoveModifier{deltaIndex: ${this.#deltaIndex}, deltaPosition: ${this.#deltaPosition}, copy: ${this.#copy}, mirroredCopy: ${this.#mirroredCopy}}`
    }

    #dispatchChange(): void {
        this.#dispatchSameTrackChange()
        if (this.#deltaIndex !== 0) {
            this.#dispatchShiftedTrackChange(this.#deltaIndex)
        }
    }

    #dispatchSameTrackChange(): void {
        this.#selection.selected().forEach(({trackBoxAdapter}) => trackBoxAdapter.unwrap().regions.dispatchChange())
    }
    #dispatchShiftedTrackChange(deltaIndex: int): void {
        this.#selection.selected().forEach(({trackBoxAdapter}) => this.#manager
            .getByIndex(trackBoxAdapter.unwrap().listIndex + deltaIndex).unwrapOrNull()?.trackBoxAdapter?.regions?.dispatchChange())
    }
}
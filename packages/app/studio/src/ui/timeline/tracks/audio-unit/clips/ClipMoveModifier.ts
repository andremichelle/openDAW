import {ClipModifier} from "@/ui/timeline/tracks/audio-unit/clips/ClipModifier.ts"
import {Arrays, asDefined, clamp, int, isDefined, Option, panic, Selection, ValueAxis} from "@opendaw/lib-std"
import {AnyClipBox, AnyClipBoxAdapter} from "@opendaw/studio-adapters"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {ClipModifyStrategy} from "@/ui/timeline/tracks/audio-unit/clips/ClipModifyStrategy.ts"
import {Dialogs} from "@/ui/components/dialogs"
import {Dragging} from "@opendaw/lib-dom"
import {Project} from "@opendaw/studio-core"

class UnselectedModifyStrategy implements ClipModifyStrategy {
    readonly #tool: ClipMoveModifier

    constructor(tool: ClipMoveModifier) {this.#tool = tool}

    readClipIndex(clip: AnyClipBoxAdapter): number {return clip.indexField.getValue()}
    readMirror(clip: AnyClipBoxAdapter): boolean {
        return clip.canMirror && (clip.isMirrowed || (clip.isSelected && this.#tool.mirroredCopy))
    }
    translateTrackIndex(index: number): number {return index}
}

class SelectedModifyStrategy implements ClipModifyStrategy {
    readonly #tool: ClipMoveModifier

    constructor(tool: ClipMoveModifier) {this.#tool = tool}

    readClipIndex(clip: AnyClipBoxAdapter): number {return clip.indexField.getValue() + this.#tool.clipDelta}
    readMirror(clip: AnyClipBoxAdapter): boolean {return clip.canMirror && clip.isMirrowed !== this.#tool.mirroredCopy}
    translateTrackIndex(index: number): number {return index - this.#tool.trackDelta}
}

export type Creation = {
    project: Project
    manager: TracksManager
    selection: Selection<AnyClipBoxAdapter>
    xAxis: ValueAxis
    yAxis: ValueAxis
    pointerClipIndex: int
    pointerTrackIndex: int
}

export class ClipMoveModifier implements ClipModifier {
    static start(creation: Creation): Option<ClipMoveModifier> {
        return Option.wrap(new ClipMoveModifier(creation))
    }

    readonly #project: Project
    readonly #manager: TracksManager
    readonly #selection: Selection<AnyClipBoxAdapter>
    readonly #xAxis: ValueAxis
    readonly #yAxis: ValueAxis
    readonly #pointerClipIndex: int
    readonly #pointerTrackIndex: int

    readonly #selectedModifyStrategy: ClipModifyStrategy
    readonly #unselectedModifyStrategy: ClipModifyStrategy

    #clipDelta: int = 0
    #trackDelta: int = 0
    #copy: boolean = false
    #mirroredCopy: boolean = false

    private constructor({project, manager, selection, xAxis, yAxis, pointerClipIndex, pointerTrackIndex}: Creation) {
        this.#project = project
        this.#manager = manager
        this.#selection = selection
        this.#xAxis = xAxis
        this.#yAxis = yAxis
        this.#pointerClipIndex = pointerClipIndex
        this.#pointerTrackIndex = pointerTrackIndex

        this.#selectedModifyStrategy = new SelectedModifyStrategy(this)
        this.#unselectedModifyStrategy = new UnselectedModifyStrategy(this)
    }

    get clipDelta(): number {return this.#clipDelta}
    get trackDelta(): number {return this.#trackDelta}
    get copy(): boolean {return this.#copy}
    get mirroredCopy(): boolean {return this.#mirroredCopy && this.#copy}

    showOrigin(): boolean {return this.#copy}
    selectedModifyStrategy(): ClipModifyStrategy {return this.#selectedModifyStrategy}
    unselectedModifyStrategy(): ClipModifyStrategy {return this.#unselectedModifyStrategy}

    update({clientX, clientY, ctrlKey, shiftKey}: Dragging.Event): void {
        const clipIndex: int = this.#xAxis.axisToValue(clientX)
        const trackIndex: int = this.#yAxis.axisToValue(clientY)
        const maxTrackIndex = this.#manager.numTracks() - 1
        const adapters = this.#selection.selected()
        const clipDelta = adapters.reduce((delta, adapter) => {
            const listIndex = adapter.indexField.getValue()
            return clamp(delta, -listIndex, this.#manager.maxClipsIndex.getValue() + 1)
        }, clipIndex - this.#pointerClipIndex)
        const trackDelta = adapters.reduce((delta, adapter) => {
            const listIndex = adapter.trackBoxAdapter.unwrap().listIndex
            return clamp(delta, -listIndex, maxTrackIndex - listIndex)
        }, trackIndex - this.#pointerTrackIndex)
        let change = false
        if (clipDelta !== this.#clipDelta) {
            this.#clipDelta = clipDelta
            change = true
        }
        if (trackDelta !== this.#trackDelta) {
            this.#dispatchShiftedTrackChange(this.#trackDelta) // removes old preview
            this.#trackDelta = trackDelta
            change = true
        }
        if (this.#copy !== ctrlKey) {
            this.#copy = ctrlKey
            change = true
        }
        if (this.#mirroredCopy !== shiftKey) {
            this.#mirroredCopy = shiftKey
            change = true
        }
        if (change) {this.#dispatchChange()}
    }

    approve(): void {
        if (this.#trackDelta === 0 && this.#clipDelta === 0) {return}
        const tracks = this.#manager.tracks()
        const maxTrackIndex = tracks.length - 1
        const adapters = this.#selection.selected()
        const trackDelta = adapters.reduce((delta, adapter) => {
            const listIndex = adapter.trackBoxAdapter.unwrap().listIndex
            return clamp(delta, -listIndex, maxTrackIndex - listIndex)
        }, this.#trackDelta)
        if (!adapters.every(adapter => {
            const trackIndex = adapter.trackBoxAdapter.unwrap().listIndex + trackDelta
            const trackAdapter = this.#manager.getByIndex(trackIndex).unwrap().trackBoxAdapter
            return trackAdapter.accepts(adapter)
        })) {
            this.cancel()
            Dialogs.info({message: "Cannot move clip to different track type."}).then()
            return
        }
        const occupied: ReadonlyArray<Array<true>> = Arrays.create(() => [], tracks.length)
        const moveTasks = adapters
            .map((adapter) => {
                const {indexField, trackBoxAdapter: optTrackBoxAdapter} = adapter
                const trackBoxAdapter = optTrackBoxAdapter.unwrap()
                const trackIndex = tracks.findIndex(({trackBoxAdapter: adapter}) => adapter === trackBoxAdapter)
                const newClipIndex = Math.max(0, indexField.getValue() + this.#clipDelta)
                const newTrackIndex = trackIndex + trackDelta
                const newTrack = asDefined(tracks[newTrackIndex], "moved outside valid area")
                occupied[newTrackIndex][newClipIndex] = true
                return {adapter, newClipIndex, newTrack, isMirrowed: adapter.isMirrowed}
            })
        const toDelete: Array<AnyClipBox> = []
        moveTasks.forEach(({adapter: {box}, newClipIndex, newTrack}) => {
            const option = newTrack.trackBoxAdapter.clips.collection.getAdapterByIndex(newClipIndex)
            if (option.nonEmpty()) {
                const adapter = option.unwrap()
                if (!adapter.isSelected && adapter.box !== box) {
                    toDelete.push(adapter.box)
                }
            }
        })
        console.debug("#copy", this.#copy, "#mirroredCopy", this.#mirroredCopy)
        const userEditingManager = this.#project.userEditingManager
        const editedAdapter = adapters.find(adapter => userEditingManager.timeline.isEditing(adapter.box))
        this.#project.editing.modify(() => {
            if (this.#copy) {
                adapters.forEach((adapter) => {
                    const track = adapter.trackBoxAdapter.unwrap()
                    const clipIndex = adapter.indexField.getValue()
                    const trackIndex = this.#manager.tracks().findIndex(({trackBoxAdapter}) => trackBoxAdapter === track)
                    if (trackIndex === -1) {return panic(`Could not find track for ${adapter}`)}
                    if (!occupied[trackIndex][clipIndex]) {
                        adapter.clone(false)
                    }
                })
            }
            toDelete.forEach(box => box.delete())
            moveTasks.forEach(({adapter, newClipIndex, newTrack, isMirrowed}) => {
                adapter.box.index.setValue(newClipIndex)
                adapter.box.clips.refer(newTrack.trackBoxAdapter.box.clips)
                if (this.#copy && (isMirrowed === this.#mirroredCopy)) {
                    adapter.consolidate()
                }
            })
            // After copy, force refresh of editing context to update the selection filter
            // TODO this is actually a hack. We can do better, but it's not clear how to do it.'
            if (this.#copy && isDefined(editedAdapter)) {
                userEditingManager.timeline.clear()
                userEditingManager.timeline.edit(editedAdapter.box)
            }
        })
    }

    cancel(): void {this.#dispatchChange()}

    #dispatchChange(): void {
        this.#dispatchSameTrackChange()
        if (this.#trackDelta !== 0) {
            this.#dispatchShiftedTrackChange(this.#trackDelta)
        }
    }

    #dispatchSameTrackChange(): void {
        this.#selection.selected().forEach(({trackBoxAdapter}) => trackBoxAdapter.unwrap().clips.dispatchChange())
    }

    #dispatchShiftedTrackChange(deltaIndex: int): void {
        this.#selection.selected().forEach(({trackBoxAdapter}) => this.#manager
            .getByIndex(trackBoxAdapter.unwrap().listIndex + deltaIndex)
            .unwrapOrNull()?.trackBoxAdapter?.clips?.dispatchChange())
    }
}
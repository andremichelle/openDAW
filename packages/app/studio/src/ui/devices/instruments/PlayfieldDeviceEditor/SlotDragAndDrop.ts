import {byte, int, isDefined, Option, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {AudioUnitsClipboard, Project} from "@opendaw/studio-core"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData, DragDevice} from "@/ui/AnyDragData"
import {
    AudioUnitBoxAdapter, InstrumentCompositeCellBoxAdapter, InstrumentFactories, PlayfieldDeviceBoxAdapter
} from "@opendaw/studio-adapters"

export namespace SlotDragAndDrop {
    const executeCopy = (project: Project, playfield: PlayfieldDeviceBoxAdapter, sourceIndex: int, targetIndex: int): void => {
        if (sourceIndex === targetIndex) {return}
        playfield.cells.getAdapterByIndex(sourceIndex).ifSome(source => project.editing.modify(() => {
            playfield.cells.getAdapterByIndex(targetIndex).ifSome(target => target.box.delete())
            project.api.copyPlayfieldPad(source.box, targetIndex)
        }))
    }

    const executeSwap = (project: Project, playfield: PlayfieldDeviceBoxAdapter, sourceIndex: int, targetIndex: int): void => {
        if (sourceIndex === targetIndex) {return}
        const source = playfield.cells.getAdapterByIndex(sourceIndex)
        const target = playfield.cells.getAdapterByIndex(targetIndex)
        project.editing.modify(() => {
            source.ifSome(({box}) => box.index.setValue(targetIndex))
            target.ifSome(({box}) => box.index.setValue(sourceIndex))
        })
    }

    type SourceConstruct = {
        element: HTMLElement
        pad: InstrumentCompositeCellBoxAdapter
        getSlotIndex: () => int
    }

    export const installSource = ({element, pad, getSlotIndex}: SourceConstruct): Terminable => {
        return DragAndDrop.installSource(element, () => ({
            type: "playfield-slot",
            index: getSlotIndex() as byte,
            uuid: UUID.toString(pad.box.composite.targetAddress.unwrap("composite").uuid)
        } satisfies DragDevice))
    }

    type TargetConstruct = {
        element: HTMLElement
        project: Project
        playfield: PlayfieldDeviceBoxAdapter
        getSlotIndex: () => int
    }

    type TrackDrag = Extract<DragDevice, { type: "instrument", device: null }>

    const claimed = new WeakSet<Event>()

    /** Whether a slot takes this drag, so the device panel around it leaves it alone. */
    export const claims = (event: Event): boolean => claimed.has(event)

    const isTrackDrag = (data: AnyDragData): data is TrackDrag => data.type === "instrument" && !isDefined(data.device)

    // the track whose instrument is dragged, any track that can go on a pad except the Playfield's own
    const sourceUnit = (project: Project, playfield: PlayfieldDeviceBoxAdapter, data: AnyDragData): Option<AudioUnitBox> => {
        if (!isTrackDrag(data)) {return Option.None}
        return project.boxGraph.findBox(UUID.parse(data.uuid)).flatMap(instrument => {
            const factory = InstrumentFactories.keyOfBox(instrument)
            if (!isDefined(factory) || !InstrumentFactories.isPadInstrument(InstrumentFactories.Named[factory])) {
                return Option.None
            }
            const unit = project.rootBoxAdapter.audioUnits.adapters().find(adapter =>
                adapter.inputField.pointerHub.incoming().some(pointer => pointer.box === instrument))
            return isDefined(unit) && unit !== playfield.audioUnitBoxAdapter() ? Option.wrap(unit.box) : Option.None
        })
    }

    // the track becomes the pad with its instrument, effects, mix and notes, a copy drop keeps the track
    const moveTrackOntoPad = (project: Project, playfield: PlayfieldDeviceBoxAdapter, unit: AudioUnitBox, key: int,
                              copy: boolean): void => {
        project.editing.modify(() => {
            AudioUnitsClipboard.copyEntry(project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter)).ifSome(entry =>
                project.api.pasteAudioUnitAsPad(playfield.box, key, entry.data).match({
                    ok: () => {if (!copy) {project.api.deleteAudioUnit(unit)}},
                    err: reason => RuntimeNotifier.notify({message: reason, icon: "Warning"})
                }))
        })
    }

    // pads move within their own Playfield only, a track dragged by its instrument becomes the pad
    export const installTarget = ({element, project, playfield, getSlotIndex}: TargetConstruct): Terminable => {
        const accepts = (data: AnyDragData): boolean => data.type === "playfield-slot"
            && data.uuid === UUID.toString(playfield.address.uuid) && data.index !== getSlotIndex()
        return DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                if (sourceUnit(project, playfield, data).isEmpty()) {return accepts(data)}
                claimed.add(event)
                return true
            },
            drop: (event: DragEvent, data: AnyDragData): void => {
                const unit = sourceUnit(project, playfield, data)
                if (unit.nonEmpty()) {
                    moveTrackOntoPad(project, playfield, unit.unwrap(), getSlotIndex(), DragAndDrop.isCopy(event, data))
                    return
                }
                if (data.type !== "playfield-slot" || !accepts(data)) {return}
                const targetIndex = getSlotIndex()
                if (event.altKey) {
                    executeCopy(project, playfield, data.index, targetIndex)
                } else {
                    executeSwap(project, playfield, data.index, targetIndex)
                }
            },
            enter: (allowDrop: boolean) => element.classList.toggle("drop-target", allowDrop),
            leave: () => element.classList.remove("drop-target")
        })
    }
}

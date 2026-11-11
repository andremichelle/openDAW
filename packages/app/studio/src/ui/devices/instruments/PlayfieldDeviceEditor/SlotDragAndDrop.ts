import {byte, int, Terminable, UUID} from "@opendaw/lib-std"
import {Project} from "@opendaw/studio-core"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData, DragDevice} from "@/ui/AnyDragData"
import {InstrumentCompositeCellBoxAdapter, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"

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

    // pads move within their own Playfield only
    export const installTarget = ({element, project, playfield, getSlotIndex}: TargetConstruct): Terminable => {
        const accepts = (data: AnyDragData): boolean => data.type === "playfield-slot"
            && data.uuid === UUID.toString(playfield.address.uuid) && data.index !== getSlotIndex()
        return DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => accepts(data),
            drop: (event: DragEvent, data: AnyDragData): void => {
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

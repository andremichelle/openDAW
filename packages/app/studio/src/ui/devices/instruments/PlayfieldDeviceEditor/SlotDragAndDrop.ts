import {byte, int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioFileBox, PlayfieldDeviceBox, PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {Project} from "@opendaw/studio-core"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData, DragDevice} from "@/ui/AnyDragData"
import {PlayfieldSampleBoxAdapter} from "@opendaw/studio-adapters"

export namespace SlotDragAndDrop {
    const findSampleByIndex = (project: Project, index: int): Option<PlayfieldSampleBox> => {
        for (const box of project.boxGraph.boxes()) {
            if (box instanceof PlayfieldSampleBox && box.index.getValue() === index) {
                return Option.wrap(box)
            }
        }
        return Option.None
    }

    const executeCopy = (project: Project, sourceIndex: int, targetIndex: int): void => {
        if (sourceIndex === targetIndex) {return}
        const {editing, boxGraph} = project
        const source = findSampleByIndex(project, sourceIndex)
        const target = findSampleByIndex(project, targetIndex)
        source.ifSome(sourceBox => {
            editing.modify(() => {
                // If target has a sample, delete it first
                target.ifSome(targetBox => targetBox.delete())
                // Get the source file (AudioFileBox)
                const sourceFile = sourceBox.file.targetVertex
                    .map(vertex => vertex.box instanceof AudioFileBox ? vertex.box : null)
                // Get the device box and its samples hub
                const deviceBox = sourceBox.device.targetVertex
                    .map(vertex => vertex.box instanceof PlayfieldDeviceBox ? vertex.box : null)
                if (sourceFile.nonEmpty() && deviceBox.nonEmpty()) {
                    PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
                        box.file.refer(sourceFile.unwrap())
                        box.device.refer(deviceBox.unwrap().samples)
                        box.index.setValue(targetIndex)
                    })
                }
            })
        })
    }

    const executeSwap = (project: Project, sourceIndex: int, targetIndex: int): void => {
        if (sourceIndex === targetIndex) {return}
        const {editing} = project
        const source = findSampleByIndex(project, sourceIndex)
        const target = findSampleByIndex(project, targetIndex)
        editing.modify(() => {
            if (source.nonEmpty() && target.isEmpty()) {
                source.unwrap().index.setValue(targetIndex)
            } else if (source.isEmpty() && target.nonEmpty()) {
                target.unwrap().index.setValue(sourceIndex)
            } else if (source.nonEmpty() && target.nonEmpty()) {
                source.unwrap().index.setValue(targetIndex)
                target.unwrap().index.setValue(sourceIndex)
            }
        })
    }

    type SourceConstruct = {
        element: HTMLElement
        sample: PlayfieldSampleBoxAdapter
        getSlotIndex: () => int
    }

    export const installSource = ({element, sample, getSlotIndex}: SourceConstruct): Terminable => {
        return DragAndDrop.installSource(element, () => ({
            type: "playfield-slot",
            index: getSlotIndex() as byte,
            uuid: sample.address.uuid.toString()
        } satisfies DragDevice))
    }

    type TargetConstruct = {
        element: HTMLElement
        project: Project
        getSlotIndex: () => int
    }

    export const installTarget = ({element, project, getSlotIndex}: TargetConstruct): Terminable => {
        return DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => {
                return data.type === "playfield-slot" && data.index !== getSlotIndex()
            },
            drop: (event: DragEvent, data: AnyDragData): void => {
                if (data.type !== "playfield-slot") {return}
                const targetIndex = getSlotIndex()
                if (event.altKey) {
                    executeCopy(project, data.index, targetIndex)
                } else {
                    executeSwap(project, data.index, targetIndex)
                }
            },
            enter: (allowDrop: boolean) => element.classList.toggle("drop-target", allowDrop),
            leave: () => element.classList.remove("drop-target")
        })
    }
}

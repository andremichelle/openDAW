import {asInstanceOf, int} from "@opendaw/lib-std"
import {Box, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "./TransferUtils"

export namespace TransferAudioUnits {
    export type TransferOptions = {
        insertIndex?: int,
        deleteSource?: boolean,
        includeAux?: boolean,
        includeBus?: boolean,
        excludeTimeline?: boolean,
    }
    /**
     * Copies audio units and their dependencies to a target project.
     * Preserved resources already present in the target graph are shared, not duplicated.
     * @returns the newly created audio unit boxes in the target graph
     */
    export const transfer = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                             {boxGraph: targetBoxGraph, mandatoryBoxes: {primaryAudioBusBox, rootBox}}: ProjectSkeleton,
                             options: TransferOptions = {}): ReadonlyArray<AudioUnitBox> => {
        const excludeBox = (box: Box): boolean =>
            TransferUtils.shouldExclude(box)
            || (options?.excludeTimeline === true && TransferUtils.excludeTimelinePredicate(box))
        const dependencies = Array.from(audioUnitBoxes[0].graph.dependenciesOf(audioUnitBoxes, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes)
        const uuidMap = TransferUtils.generateMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        TransferUtils.copyBoxes(uuidMap, targetBoxGraph, audioUnitBoxes, dependencies)
        TransferUtils.reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox, options.insertIndex)
        const result = audioUnitBoxes.map(source => asInstanceOf(rootBox.graph
            .findBox(uuidMap.get(source.address.uuid).target)
            .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
        if (options.deleteSource === true) {
            const sourceRootBox = asInstanceOf(
                audioUnitBoxes[0].collection.targetVertex.unwrap().box, RootBox)
            audioUnitBoxes.forEach(box => box.delete())
            IndexedBox.collectIndexedBoxes(sourceRootBox.audioUnits, AudioUnitBox)
                .forEach((box, index) => box.index.setValue(index))
        }
        return result
    }
}

import {asInstanceOf} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "./TransferUtils"

export namespace TransferAudioUnits {
    /**
     * Copies audio units and their dependencies to a target project.
     * Preserved resources already present in the target graph are shared, not duplicated.
     * @returns the newly created audio unit boxes in the target graph
     */
    export const transfer = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                             {boxGraph: targetBoxGraph, mandatoryBoxes: {primaryAudioBusBox, rootBox}}: ProjectSkeleton,
                             options: {
                                 includeAux?: boolean,
                                 includeBus?: boolean,
                                 excludeTimeline?: boolean,
                             } = {}): ReadonlyArray<AudioUnitBox> => {
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
        TransferUtils.reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        return audioUnitBoxes.map(source => asInstanceOf(rootBox.graph
            .findBox(uuidMap.get(source.address.uuid).target)
            .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
    }
}

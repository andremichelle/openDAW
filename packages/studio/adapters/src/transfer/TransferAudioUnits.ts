import {AudioUnitGroups} from "../audio-unit/AudioUnitGroups"
import {asInstanceOf, assert, int, isDefined, UUID} from "@opendaw/lib-std"
import {Box, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitBox, RootBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "./TransferUtils"

export namespace TransferAudioUnits {
    export type TransferOptions = {
        insertIndex?: int,
        /** Same-project duplication only: initialize external folder/output references to the originals. */
        preserveExternalConnections?: boolean,
        deleteSource?: boolean,
        includeAux?: boolean,
        includeBus?: boolean,
        excludeTimeline?: boolean,
    }
    /** Copy full group subtrees and dependencies, sharing resources already present in the target graph. */
    export const transfer = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                             {boxGraph: targetBoxGraph, mandatoryBoxes: {primaryAudioBusBox, rootBox}}: ProjectSkeleton,
                             options: TransferOptions = {}): ReadonlyArray<AudioUnitBox> => {
        // Output is a project singleton and must not be copied.
        const sourceRoot = audioUnitBoxes[0]?.collection.targetVertex.unwrapOrNull()?.box
        const sources = sourceRoot instanceof RootBox ? [...new Set(audioUnitBoxes
            .filter(box => box.type.getValue() !== AudioUnitType.Output)
            .flatMap(box => AudioUnitGroups.subtree(sourceRoot, box)))] : []
        if (sources.length === 0) {return []}
        const excludeBox = (box: Box): boolean =>
            TransferUtils.shouldExclude(box)
            || (options?.excludeTimeline === true && TransferUtils.excludeTimelinePredicate(box))
        const dependencies = TransferUtils.withModulators(Array.from(sources[0].graph.dependenciesOf(sources, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes))
        const uuidMap = TransferUtils.generateMap(
            sources, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        if (options.preserveExternalConnections) {
            assert(sources[0].graph === targetBoxGraph, "External connections require the same project")
            sources.forEach(source => {
                const parent = AudioUnitGroups.parent(source)
                if (isDefined(parent) && !sources.includes(parent)) {
                    uuidMap.add({source: parent.address.uuid, target: parent.address.uuid})
                }
                source.output.targetAddress.ifSome(address => {
                    if (dependencies.some(box => UUID.equals(box.address.uuid, address.uuid))) {return}
                    const mapping = uuidMap.opt(address.uuid).unwrapOrUndefined()
                    if (isDefined(mapping)) {mapping.target = address.uuid}
                })
            })
        }
        TransferUtils.copyBoxes(uuidMap, targetBoxGraph, sources, dependencies)
        TransferUtils.reorderAudioUnits(uuidMap, sources, rootBox, options.insertIndex)
        const result = sources.map(source => asInstanceOf(rootBox.graph
            .findBox(uuidMap.get(source.address.uuid, "uuid mapping").target)
            .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
        if (options.deleteSource === true) {
            const sourceRootBox = asInstanceOf(
                sources[0].collection.targetVertex.unwrap("collection.target").box, RootBox)
            sources.forEach(box => box.delete())
            IndexedBox.collectIndexedBoxes(sourceRootBox.audioUnits, AudioUnitBox)
                .forEach((box, index) => box.index.setValue(index))
        }
        return result
    }
}

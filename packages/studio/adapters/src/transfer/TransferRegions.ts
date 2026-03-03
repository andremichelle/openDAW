import {asDefined, ByteArrayInput, Nullable, Option, UUID} from "@opendaw/lib-std"
import {Box, PointerField} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {BoxIO, TrackBox} from "@opendaw/studio-boxes"
import {AnyRegionBox, UnionBoxTypes} from "../unions"

export namespace TransferRegions {
    /**
     * Copies a region and its dependencies to a target track, works across BoxGraphs.
     * Preserved resources already present in the target graph are shared, not duplicated.
     * @returns the newly created region box in the target graph
     */
    export const transfer = (region: AnyRegionBox,
                             targetTrack: TrackBox,
                             insertPosition: ppqn,
                             deleteSource: boolean = true): AnyRegionBox => {
        const targetGraph = targetTrack.graph
        const uniqueBoxes = UUID.newSet<Box>(box => box.address.uuid)
        uniqueBoxes.add(region)
        for (const dependency of region.graph.dependenciesOf(region, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox: (dep: Box) => dep.ephemeral
        }).boxes) {
            uniqueBoxes.add(dependency)
        }
        const skippedPreservedUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        uniqueBoxes.forEach(box => {
            if (box.resource === "preserved" && targetGraph.findBox(box.address.uuid).nonEmpty()) {
                skippedPreservedUuids.add(box.address.uuid)
            }
        })
        const shouldSkipBox = (box: Box): boolean => {
            if (box.resource === "preserved" && skippedPreservedUuids.hasKey(box.address.uuid)) {return true}
            for (const [, targetAddress] of box.outgoingEdges()) {
                if (skippedPreservedUuids.hasKey(targetAddress.uuid) && !targetAddress.isBox()) {return true}
            }
            return false
        }
        const sourceBoxes = uniqueBoxes.values().filter(box => !shouldSkipBox(box))
        const uuidMap = UUID.newSet<{ source: UUID.Bytes, target: UUID.Bytes }>(entry => entry.source)
        sourceBoxes.forEach(box => {
            uuidMap.add({
                source: box.address.uuid,
                target: box.resource === "preserved" ? box.address.uuid : UUID.generate()
            })
        })
        skippedPreservedUuids.forEach(uuid => uuidMap.add({source: uuid, target: uuid}))
        let result: Nullable<AnyRegionBox> = null
        PointerField.decodeWith({
            map: (pointer, address) => {
                const remapped = address.flatMap(addr =>
                    uuidMap.opt(addr.uuid).map(entry => addr.moveTo(entry.target)))
                if (remapped.nonEmpty()) {return remapped}
                if (pointer.pointerType === Pointers.RegionCollection) {
                    return Option.wrap(targetTrack.regions.address)
                }
                if (pointer.pointerType === Pointers.ClipCollection) {
                    return Option.wrap(targetTrack.clips.address)
                }
                return Option.None
            }
        }, () => sourceBoxes.forEach(sourceBox => {
            const input = new ByteArrayInput(sourceBox.toArrayBuffer())
            const targetUuid = uuidMap.get(sourceBox.address.uuid).target
            targetGraph.createBox(sourceBox.name as keyof BoxIO.TypeMap, targetUuid, box => {
                box.read(input)
                if (UnionBoxTypes.isRegionBox(box)) {
                    const regionBox = UnionBoxTypes.asRegionBox(box)
                    regionBox.position.setValue(insertPosition)
                    result = regionBox
                }
            })
        }))
        if (deleteSource) {region.delete()}
        return asDefined<AnyRegionBox>(result, "Failed to create region copy")
    }
}

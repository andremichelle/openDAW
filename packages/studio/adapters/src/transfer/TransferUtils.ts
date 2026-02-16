import {ppqn} from "@opendaw/lib-dsp"
import {
    Arrays,
    asInstanceOf,
    assert,
    ByteArrayInput,
    isInstanceOf,
    Option,
    Predicate,
    SetMultimap,
    SortedSet,
    UUID
} from "@opendaw/lib-std"
import {AudioUnitBox, AuxSendBox, BoxIO, BoxVisitor, RootBox, TrackBox} from "@opendaw/studio-boxes"
import {Address, Box, BoxGraph, IndexedBox, PointerField} from "@opendaw/lib-box"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AnyRegionBox, UnionBoxTypes} from "../unions"
import {AudioUnitOrdering} from "../factories/AudioUnitOrdering"

export namespace TransferUtils {
    export type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }

    const isSameGraph = ({graph: a}: Box, {graph: b}: Box): boolean => a === b
    const compareIndex = (a: IndexedBox, b: IndexedBox) => a.index.getValue() - b.index.getValue()
    export const excludeTimelinePredicate = (box: Box): boolean =>
        box.accept<BoxVisitor<boolean>>({visitTrackBox: () => true}) === true
    export const shouldExclude = (box: Box): boolean => box.ephemeral || box.name === AuxSendBox.ClassName

    export const generateMap = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                                dependencies: ReadonlyArray<Box>,
                                rootBoxUUID: UUID.Bytes,
                                masterBusBoxUUID: UUID.Bytes): SortedSet<UUID.Bytes, UUIDMapper> => {
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)
        uuidMap.addMany([
            ...audioUnitBoxes
                .filter(({output: {targetAddress}}) => targetAddress.nonEmpty())
                .map(box => ({
                    source: box.output.targetAddress.unwrap().uuid,
                    target: masterBusBoxUUID
                })),
            ...audioUnitBoxes
                .map(box => ({
                    source: box.collection.targetAddress.unwrap("AudioUnitBox was not connected to a RootBox").uuid,
                    target: rootBoxUUID
                })),
            ...audioUnitBoxes
                .map(box => ({
                    source: box.address.uuid,
                    target: UUID.generate()
                })),
            ...dependencies
                .map(box => ({
                    source: box.address.uuid,
                    target: box.resource === "preserved" ? box.address.uuid : UUID.generate()
                }))
        ])
        return uuidMap
    }

    export const copyBoxes = (uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                              targetBoxGraph: BoxGraph,
                              audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                              dependencies: ReadonlyArray<Box>): void => {
        const existingPreservedUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        dependencies.forEach((source: Box) => {
            if (source.resource === "preserved" && targetBoxGraph.findBox(source.address.uuid).nonEmpty()) {
                existingPreservedUuids.add(source.address.uuid)
            }
        })
        const isOwnedByExistingPreserved = (box: Box): boolean => {
            for (const [pointer, targetAddress] of box.outgoingEdges()) {
                if (pointer.mandatory && !targetAddress.isBox()) {
                    if (existingPreservedUuids.hasKey(targetAddress.uuid)) {return true}
                }
            }
            return false
        }
        PointerField.decodeWith({
            map: (_pointer: PointerField, address: Option<Address>): Option<Address> =>
                address.map(addr => uuidMap.opt(addr.uuid).match({
                    none: () => addr,
                    some: ({target}) => addr.moveTo(target)
                }))
        }, () => {
            audioUnitBoxes.forEach((source: AudioUnitBox) => {
                const input = new ByteArrayInput(source.toArrayBuffer())
                const uuid = uuidMap.get(source.address.uuid).target
                targetBoxGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
            })
            dependencies.forEach((source: Box) => {
                if (existingPreservedUuids.hasKey(source.address.uuid)) {return}
                if (isOwnedByExistingPreserved(source)) {return}
                const input = new ByteArrayInput(source.toArrayBuffer())
                const uuid = uuidMap.get(source.address.uuid).target
                targetBoxGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
            })
        })
    }

    export const reorderAudioUnits = (uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                                      audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                                      rootBox: RootBox): void => audioUnitBoxes
        .toSorted(compareIndex)
        .map(source => asInstanceOf(rootBox.graph
            .findBox(uuidMap.get(source.address.uuid).target)
            .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
        .forEach((target) =>
            IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox).toSorted((a, b) => {
                const orderA = AudioUnitOrdering[a.type.getValue()]
                const orderB = AudioUnitOrdering[b.type.getValue()]
                const orderDifference = orderA - orderB
                return orderDifference === 0 ? b === target ? -1 : 1 : orderDifference
            }).forEach((box, index) => box.index.setValue(index)))

    export const extractRegions = (regionBoxes: ReadonlyArray<AnyRegionBox>,
                                   {boxGraph, mandatoryBoxes: {primaryAudioBusBox, rootBox}}: ProjectSkeleton,
                                   insertPosition: ppqn = 0.0): void => {
        assert(Arrays.satisfy(regionBoxes, isSameGraph),
            "Region smust be from the same BoxGraph")
        const regionBoxSet = new Set<AnyRegionBox>(regionBoxes)
        const trackBoxSet = new Set<TrackBox>()
        const audioUnitBoxSet = new SetMultimap<AudioUnitBox, TrackBox>()
        regionBoxes.forEach(regionBox => {
            const trackBox = asInstanceOf(regionBox.regions.targetVertex.unwrap().box, TrackBox)
            trackBoxSet.add(trackBox)
            const audioUnitBox = asInstanceOf(trackBox.tracks.targetVertex.unwrap().box, AudioUnitBox)
            audioUnitBoxSet.add(audioUnitBox, trackBox)
        })
        console.debug(`Found ${audioUnitBoxSet.keyCount()} audioUnits`)
        console.debug(`Found ${trackBoxSet.size} tracks`)
        const audioUnitBoxes = [...audioUnitBoxSet.keys()]
        const excludeBox: Predicate<Box> = (box: Box): boolean =>
            shouldExclude(box)
            || (isInstanceOf(box, TrackBox) && !trackBoxSet.has(box))
            || (UnionBoxTypes.isRegionBox(box) && !regionBoxSet.has(box))
        const dependencies = Array.from(audioUnitBoxes[0].graph.dependenciesOf(audioUnitBoxes, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes)
        const uuidMap = generateMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        copyBoxes(uuidMap, boxGraph, audioUnitBoxes, dependencies)
        reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        audioUnitBoxSet.forEach((_, trackBoxes) => [...trackBoxes]
            .sort(compareIndex)
            .forEach((source: TrackBox, index) => {
                const box = boxGraph
                    .findBox(uuidMap.get(source.address.uuid).target)
                    .unwrap("Target Track has not been copied")
                asInstanceOf(box, TrackBox).index.setValue(index)
            }))
        const minPosition = regionBoxes.reduce((min, region) =>
            Math.min(min, region.position.getValue()), Number.MAX_VALUE)
        const delta = insertPosition - minPosition
        regionBoxes.forEach((source: AnyRegionBox) => {
            const box = boxGraph
                .findBox(uuidMap.get(source.address.uuid).target)
                .unwrap("Target Track has not been copied")
            const {position} = UnionBoxTypes.asRegionBox(box)
            position.setValue(position.getValue() + delta)
        })
    }
}

import {ppqn} from "@opendaw/lib-dsp"
import {
    Arrays,
    asInstanceOf,
    assert,
    ByteArrayInput,
    isInstanceOf,
    Option,
    Predicate,
    Predicates,
    SetMultimap,
    SortedSet,
    UUID
} from "@opendaw/lib-std"
import {
    AudioFileBox,
    AudioUnitBox,
    AuxSendBox,
    BoxIO,
    BoxVisitor,
    RootBox,
    SelectionBox,
    SoundfontFileBox,
    TrackBox,
    TransientMarkerBox
} from "@opendaw/studio-boxes"
import {Address, Box, BoxGraph, IndexedBox, PointerField} from "@opendaw/lib-box"
import {ProjectSkeleton} from "./ProjectSkeleton"
import {AnyRegionBox, UnionBoxTypes} from "../unions"
import {AudioUnitOrdering} from "../factories/AudioUnitOrdering"

export namespace ProjectUtils {
    type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }

    const isSameGraph: (a: Box, b: Box) => boolean = ({graph: a}, {graph: b}) => a === b
    const compareIndex = (a: IndexedBox, b: IndexedBox) => a.index.getValue() - b.index.getValue()
    const excludeTimelinePredicate = (box: Box) => box.accept<BoxVisitor<boolean>>({
        visitTrackBox: (_box: TrackBox): boolean => true
    }) === true

    export const extractAudioUnits = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                                      {boxGraph, mandatoryBoxes: {primaryAudioBus, rootBox}}: ProjectSkeleton,
                                      options: {
                                          includeAux?: boolean,
                                          includeBus?: boolean,
                                          excludeTimeline?: boolean,
                                      } = {})
        : ReadonlyArray<AudioUnitBox> => {
        assert(Arrays.satisfy(audioUnitBoxes, isSameGraph), "AudioUnits must share the same BoxGraph")
        // TODO Implement include options.
        assert(!options.includeAux && !options.includeBus, "Options are not yet implemented")
        const excludeBox = options?.excludeTimeline === true ? excludeTimelinePredicate : Predicates.alwaysFalse
        const dependencies = audioUnitBoxes
            .flatMap(box => Array.from(box.graph.dependenciesOf(box, {alwaysFollowMandatory: true, excludeBox}).boxes))
            .filter(box => box.name !== SelectionBox.ClassName && box.name !== AuxSendBox.ClassName)
        const uuidMap = generateTransferMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBus.address.uuid)
        copy(uuidMap, boxGraph, audioUnitBoxes, dependencies)
        reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        console.debug("inTransaction", boxGraph.inTransaction())
        return audioUnitBoxes.map(source => asInstanceOf(rootBox.graph
            .findBox(uuidMap.get(source.address.uuid).target)
            .unwrap("Target Track has not been copied"), AudioUnitBox))
    }

    export const extractRegions = (regionBoxes: ReadonlyArray<AnyRegionBox>,
                                   {boxGraph, mandatoryBoxes: {primaryAudioBus, rootBox}}: ProjectSkeleton,
                                   insertPosition: ppqn = 0.0): void => {
        assert(Arrays.satisfy(regionBoxes, isSameGraph),
            "Region smust be from the same BoxGraph")
        const regionBoxSet = new Set<AnyRegionBox>(regionBoxes)
        const trackBoxSet = new Set<TrackBox>()
        const audioUnitBoxSet = new SetMultimap<AudioUnitBox, TrackBox>()
        // Collect AudioUnits and Tracks
        regionBoxes.forEach(regionBox => {
            const trackBox = asInstanceOf(regionBox.regions.targetVertex.unwrap().box, TrackBox)
            trackBoxSet.add(trackBox)
            const audioUnitBox = asInstanceOf(trackBox.tracks.targetVertex.unwrap().box, AudioUnitBox)
            audioUnitBoxSet.add(audioUnitBox, trackBox)
        })
        console.debug(`Found ${audioUnitBoxSet.keyCount()} audioUnits`)
        console.debug(`Found ${trackBoxSet.size} tracks`)
        const audioUnitBoxes = [...audioUnitBoxSet.keys()]
        const excludeBox: Predicate<Box> =
            box => (isInstanceOf(box, TrackBox) && !trackBoxSet.has(box))
                || (UnionBoxTypes.isRegionBox(box) && !regionBoxSet.has(box))
        const dependencies = audioUnitBoxes
            .flatMap(box => Array.from(box.graph.dependenciesOf(box, {excludeBox, alwaysFollowMandatory: true}).boxes))
            .filter(box => box.name !== SelectionBox.ClassName && box.name !== AuxSendBox.ClassName)
        const uuidMap = generateTransferMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBus.address.uuid)
        copy(uuidMap, boxGraph, audioUnitBoxes, dependencies)
        reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        // reorder track indices
        audioUnitBoxSet.forEach((_, trackBoxes) => [...trackBoxes]
            .sort(compareIndex)
            .forEach((source: TrackBox, index) => {
                const box = boxGraph
                    .findBox(uuidMap.get(source.address.uuid).target)
                    .unwrap("Target Track has not been copied")
                asInstanceOf(box, TrackBox).index.setValue(index)
            }))
        // move new regions to the target position
        const minPosition = regionBoxes.reduce((min, region) =>
            Math.min(min, region.position.getValue()), Number.MAX_VALUE)
        const delta = insertPosition - minPosition
        regionBoxes.forEach((source: AnyRegionBox) => {
            const box = boxGraph
                .findBox(uuidMap.get(source.address.uuid).target)
                .unwrap("Target Track has not been copied")
            const position = UnionBoxTypes.asRegionBox(box).position
            position.setValue(position.getValue() + delta)
        })
    }

    const generateTransferMap = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
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
                .map(({address: {uuid}, name}) =>
                    ({
                        source: uuid,
                        target: name === AudioFileBox.ClassName || name === SoundfontFileBox.ClassName
                            ? uuid
                            : UUID.generate()
                    }))
        ])
        return uuidMap
    }

    const copy = (uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                  boxGraph: BoxGraph,
                  audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                  dependencies: ReadonlyArray<Box>) => {
        // First, identify which file boxes already exist and should be skipped
        const existingFileBoxUUIDs = UUID.newSet<UUID.Bytes>(uuid => uuid)
        dependencies.forEach((source: Box) => {
            if (source instanceof AudioFileBox || source instanceof SoundfontFileBox) {
                if (boxGraph.findBox(source.address.uuid).nonEmpty()) {
                    existingFileBoxUUIDs.add(source.address.uuid)
                }
            }
        })
        PointerField.decodeWith({
            map: (_pointer: PointerField, newAddress: Option<Address>): Option<Address> =>
                newAddress.map(address => uuidMap.opt(address.uuid).match({
                    none: () => address,
                    some: ({target}) => address.moveTo(target)
                }))
        }, () => {
            audioUnitBoxes
                .forEach((source: AudioUnitBox) => {
                    const input = new ByteArrayInput(source.toArrayBuffer())
                    const key = source.name as keyof BoxIO.TypeMap
                    const uuid = uuidMap.get(source.address.uuid).target
                    boxGraph.createBox(key, uuid, box => box.read(input))
                })
            dependencies
                .forEach((source: Box) => {
                    if (source instanceof AudioFileBox || source instanceof SoundfontFileBox) {
                        // Those boxes keep their UUID. So if they are already in the graph, skip them.
                        if (existingFileBoxUUIDs.opt(source.address.uuid).nonEmpty()) {
                            return
                        }
                    }
                    // Skip TransientMarkerBox if its owner AudioFileBox already exists
                    if (source instanceof TransientMarkerBox) {
                        const ownerUUID = source.owner.targetAddress.unwrap().uuid
                        if (existingFileBoxUUIDs.opt(ownerUUID).nonEmpty()) {
                            return
                        }
                    }
                    const input = new ByteArrayInput(source.toArrayBuffer())
                    const key = source.name as keyof BoxIO.TypeMap
                    const uuid = uuidMap.get(source.address.uuid).target
                    boxGraph.createBox(key, uuid, box => box.read(input))
                })
        })
    }

    const reorderAudioUnits = (uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                               audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                               rootBox: RootBox): void => audioUnitBoxes
        .toSorted(compareIndex)
        .map(source => (asInstanceOf(rootBox.graph
            .findBox(uuidMap.get(source.address.uuid).target)
            .unwrap("Target Track has not been copied"), AudioUnitBox)))
        .forEach((target) =>
            IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox).toSorted((a, b) => {
                const orderA = AudioUnitOrdering[a.type.getValue()]
                const orderB = AudioUnitOrdering[b.type.getValue()]
                const orderDifference = orderA - orderB
                return orderDifference === 0 ? b === target ? -1 : 1 : orderDifference
            }).forEach((box, index) => box.index.setValue(index)))
}
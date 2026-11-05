import {ppqn} from "@opendaw/lib-dsp"
import {
    Arrays,
    asInstanceOf,
    assert,
    ByteArrayInput,
    clamp,
    int,
    isDefined,
    isInstanceOf,
    Option,
    Predicate,
    SetMultimap,
    SortedSet,
    Strings,
    Optional,
    UUID
} from "@opendaw/lib-std"
import {
    AudioUnitBox,
    AuxSendBox,
    BoxIO,
    BoxVisitor,
    GrooveStackBox,
    GrooveStackEntryBox,
    ModulationBox,
    RootBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {Address, Box, BoxGraph, IndexedBox, PointerField} from "@opendaw/lib-box"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {AnyRegionBox, UnionBoxTypes} from "../unions"
import {AudioUnitOrdering} from "../factories/AudioUnitOrdering"
import {isModulatorBox} from "../modulation/ModulatorBoxAdapter"
import {GrooveBox, isGrooveBox} from "../grooves/GrooveBoxAdapter"

export namespace TransferUtils {
    export type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }

    const isSameGraph = ({graph: a}: Box, {graph: b}: Box): boolean => a === b
    const compareIndex = (a: IndexedBox, b: IndexedBox) => a.index.getValue() - b.index.getValue()
    export const excludeTimelinePredicate = (box: Box): boolean =>
        box.accept<BoxVisitor<boolean>>({visitTrackBox: () => true}) === true
    export const shouldExclude = (box: Box): boolean => box.ephemeral || box.name === AuxSendBox.ClassName
    export const keepsIdentity = (box: Box): boolean =>
        box.resource === "preserved" || isModulatorBox(box) || isGrooveBox(box)

    // modulators live in rootBox.modulators, outside every unit; carried alone, never walked (their other assignments)
    export const withModulators = (boxes: ReadonlyArray<Box>): ReadonlyArray<Box> => {
        const known = UUID.newSet<Box>(box => box.address.uuid)
        boxes.forEach(box => known.add(box))
        const modulators: Array<Box> = []
        boxes.forEach(box => {
            if (!isInstanceOf(box, ModulationBox)) {return}
            box.source.targetVertex.ifSome(({box: modulator}) => {
                if (known.hasKey(modulator.address.uuid)) {return}
                known.add(modulator)
                modulators.push(modulator)
            })
        })
        return withGrooves([...boxes, ...modulators])
    }

    // The project's global groove never travels, a paste maps it onto the target project's global groove
    export const isGlobalGroove = (box: Box): boolean =>
        isGrooveBox(box) && box.pointerHub.incoming().some(pointer => isInstanceOf(pointer.box, RootBox))

    // grooves live in rootBox.grooves like modulators: carried alone, a stack with its entries and members
    export const withGrooves = (boxes: ReadonlyArray<Box>): ReadonlyArray<Box> => {
        const known = UUID.newSet<Box>(box => box.address.uuid)
        boxes.forEach(box => known.add(box))
        const added: Array<Box> = []
        const carry = (groove: Box): void => {
            if (!isGrooveBox(groove) || isGlobalGroove(groove) || known.hasKey(groove.address.uuid)) {return}
            known.add(groove)
            added.push(groove)
            if (isInstanceOf(groove, GrooveStackBox)) {
                groove.entries.pointerHub.incoming().forEach(({box: entry}) => {
                    if (!known.hasKey(entry.address.uuid)) {
                        known.add(entry)
                        added.push(entry)
                    }
                    if (isInstanceOf(entry, GrooveStackEntryBox)) {
                        entry.groove.targetVertex.ifSome(({box}) => carry(box))
                    }
                })
            }
        }
        boxes.forEach(box => box.outgoingEdges().forEach(([pointer]) => {
            if (pointer.pointerType === Pointers.Groove) {pointer.targetVertex.ifSome(({box}) => carry(box))}
        }))
        return added.length === 0 ? boxes : [...boxes, ...added]
    }

    // An entry of a stack the target already holds is already there
    export const isEntryOfExistingStack = (box: Box, targetGraph: BoxGraph): boolean =>
        isInstanceOf(box, GrooveStackEntryBox)
        && box.stack.targetAddress.mapOr(address => targetGraph.findBox(address.uuid).nonEmpty(), false)

    // Pasted grooves land behind the existing ones with unique labels, the global groove stays first. A used
    // groove outside the list (from an old preset) joins it. Read from the graph, since grooves pasted in this
    // transaction are not in the collection yet.
    export const normalizeGrooves = (graph: BoxGraph): void => {
        const rootBox = graph.boxes().find(box => isInstanceOf(box, RootBox))
        if (!isDefined(rootBox) || !isInstanceOf(rootBox, RootBox)) {return}
        const collection = rootBox.grooves.address
        const members = graph.boxes()
            .filter((box): box is GrooveBox => isGrooveBox(box) && box.isAttached())
            .filter(box => box.collection.targetAddress.match({
                none: () => box.pointerHub.incoming().length > 0,
                some: address => address.equals(collection)
            }))
        members.forEach(box => {
            if (box.collection.targetAddress.isEmpty()) {box.collection.refer(rootBox.grooves)}
        })
        members
            .sort((a, b) => Number(isGlobalGroove(b)) - Number(isGlobalGroove(a))
                || a.index.getValue() - b.index.getValue()
                || UUID.Comparator(a.address.uuid, b.address.uuid))
        const taken: Array<string> = []
        members.forEach((groove, index) => {
            if (groove.index.getValue() !== index) {groove.index.setValue(index)}
            const label = groove.label.getValue()
            const unique = taken.includes(label) ? Strings.getUniqueName(taken, label) : label
            taken.push(unique)
            if (unique !== label) {groove.label.setValue(unique)}
        })
    }

    export const deviceDependencies = (root: Box, exclude: Predicate<Box> = () => false): ReadonlyArray<Box> =>
        withModulators([root, ...root.graph.dependenciesOf([root], {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox: box => exclude(box) || shouldExclude(box) || excludeTimelinePredicate(box) || box instanceof AudioUnitBox
        }).boxes]).filter(box => box !== root)

    export const mapUuids = (boxes: ReadonlyArray<Box>): SortedSet<UUID.Bytes, UUIDMapper> => {
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)
        uuidMap.addMany(boxes.map(box => ({
            source: box.address.uuid,
            target: keepsIdentity(box) ? box.address.uuid : UUID.generate()
        })))
        return uuidMap
    }

    export const cloneBoxes = (sources: ReadonlyArray<Box>,
                               uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                               targetGraph: BoxGraph): void =>
        sources.forEach(source => {
            const input = new ByteArrayInput(source.toArrayBuffer())
            const uuid = uuidMap.get(source.address.uuid, "uuid mapping").target
            targetGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
        })

    // Reached for a target the copy did not carry: modulators and grooves join the target root, a groove that
    // stayed behind (the global one) becomes the target's global groove
    export const mapModulatorCollection = (pointer: PointerField, targetGraph: BoxGraph): Option<Address> => {
        const rootBox = (): Option<RootBox> =>
            Option.wrap(targetGraph.boxes().find(box => isInstanceOf(box, RootBox)) as Optional<RootBox>)
        switch (pointer.pointerType) {
            case Pointers.ModulatorCollection:
                return rootBox().map(rootBox => rootBox.modulators.address)
            case Pointers.GrooveCollection:
                return rootBox().map(rootBox => rootBox.grooves.address)
            case Pointers.Groove:
                return rootBox().flatMap(rootBox => rootBox.groove.targetAddress)
            default:
                return Option.None
        }
    }

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
                    target: keepsIdentity(box) ? box.address.uuid : UUID.generate()
                }))
        ])
        return uuidMap
    }

    export const copyBoxes = (uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                              targetBoxGraph: BoxGraph,
                              audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                              dependencies: ReadonlyArray<Box>): void => {
        const existingPreservedUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        const existingModulatorUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        dependencies.forEach((source: Box) => {
            if (targetBoxGraph.findBox(source.address.uuid).isEmpty()) {return}
            if (source.resource === "preserved") {existingPreservedUuids.add(source.address.uuid)}
            if (isModulatorBox(source) || isGrooveBox(source)) {existingModulatorUuids.add(source.address.uuid)}
        })
        // decided before copying: a stack copied in this very pass would otherwise read as already there
        const existingStackEntries = new Set<Box>(
            dependencies.filter(source => isEntryOfExistingStack(source, targetBoxGraph)))
        const isOwnedByExistingPreserved = (box: Box): boolean => {
            for (const [pointer, targetAddress] of box.outgoingEdges()) {
                if (pointer.mandatory && !targetAddress.isBox()) {
                    if (existingPreservedUuids.hasKey(targetAddress.uuid)) {return true}
                }
            }
            return false
        }
        PointerField.decodeWith({
            map: (pointer: PointerField, address: Option<Address>): Option<Address> =>
                address.flatMap(addr => uuidMap.opt(addr.uuid).match({
                    some: ({target}) => Option.wrap(addr.moveTo(target)),
                    none: () => targetBoxGraph.findBox(addr.uuid).nonEmpty()
                        ? Option.wrap(addr) : mapModulatorCollection(pointer, targetBoxGraph)
                }))
        }, () => {
            audioUnitBoxes.forEach((source: AudioUnitBox) => {
                const input = new ByteArrayInput(source.toArrayBuffer())
                const uuid = uuidMap.get(source.address.uuid, "uuid mapping").target
                targetBoxGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
            })
            dependencies.forEach((source: Box) => {
                if (existingPreservedUuids.hasKey(source.address.uuid)) {return}
                if (existingModulatorUuids.hasKey(source.address.uuid)) {return}
                if (existingStackEntries.has(source)) {return}
                if (isOwnedByExistingPreserved(source)) {return}
                const input = new ByteArrayInput(source.toArrayBuffer())
                const uuid = uuidMap.get(source.address.uuid, "uuid mapping").target
                targetBoxGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
            })
        })
    }

    export const reorderAudioUnits = (uuidMap: SortedSet<UUID.Bytes, UUIDMapper>,
                                      audioUnitBoxes: ReadonlyArray<AudioUnitBox>,
                                      rootBox: RootBox,
                                      insertIndex?: int): void => {
        const targets = audioUnitBoxes
            .toSorted(compareIndex)
            .map(source => asInstanceOf(rootBox.graph
                .findBox(uuidMap.get(source.address.uuid, "uuid mapping").target)
                .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
        const targetSet = new Set<AudioUnitBox>(targets)
        const allAudioUnits = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        const existing = allAudioUnits.filter(box => !targetSet.has(box))
        let ordered: ReadonlyArray<AudioUnitBox>
        if (isDefined(insertIndex)) {
            const position = clamp(insertIndex, 0, existing.length)
            ordered = [...existing.slice(0, position), ...targets, ...existing.slice(position)]
        } else {
            // Place by AudioUnitOrdering, not by current index: the primary Output unit (highest order)
            // can sit at a low index, so findIndex over the index-sorted list would insert the copy
            // before it. Sort existing by order first so the copy lands among its own kind (e.g. an
            // instrument after the other instruments but before the Output unit).
            const byOrder = existing.toSorted((a, b) =>
                (AudioUnitOrdering[a.type.getValue()] ?? 0) - (AudioUnitOrdering[b.type.getValue()] ?? 0))
            const maxOrder = targets.reduce((max, box) =>
                Math.max(max, AudioUnitOrdering[box.type.getValue()] ?? 0), 0)
            let position = byOrder.findIndex(box => (AudioUnitOrdering[box.type.getValue()] ?? 0) > maxOrder)
            if (position === -1) {position = byOrder.length}
            ordered = [...byOrder.slice(0, position), ...targets, ...byOrder.slice(position)]
        }
        ordered.forEach((box, index) => box.index.setValue(index))
    }

    export const extractRegions = (regionBoxes: ReadonlyArray<AnyRegionBox>,
                                   {boxGraph, mandatoryBoxes: {primaryAudioBusBox, rootBox}}: ProjectSkeleton,
                                   insertPosition: ppqn = 0.0): void => {
        assert(Arrays.satisfy(regionBoxes, isSameGraph),
            "Region smust be from the same BoxGraph")
        const regionBoxSet = new Set<AnyRegionBox>(regionBoxes)
        const trackBoxSet = new Set<TrackBox>()
        const audioUnitBoxSet = new SetMultimap<AudioUnitBox, TrackBox>()
        regionBoxes.forEach(regionBox => {
            const trackBox = asInstanceOf(regionBox.regions.targetVertex.unwrap("regions.target").box, TrackBox)
            trackBoxSet.add(trackBox)
            const audioUnitBox = asInstanceOf(trackBox.tracks.targetVertex.unwrap("tracks.target").box, AudioUnitBox)
            audioUnitBoxSet.add(audioUnitBox, trackBox)
        })
        console.debug(`Found ${audioUnitBoxSet.keyCount()} audioUnits`)
        console.debug(`Found ${trackBoxSet.size} tracks`)
        const audioUnitBoxes = [...audioUnitBoxSet.keys()]
        const excludeBox: Predicate<Box> = (box: Box): boolean =>
            shouldExclude(box)
            || (isInstanceOf(box, TrackBox) && !trackBoxSet.has(box))
            || (UnionBoxTypes.isRegionBox(box) && !regionBoxSet.has(box))
        const dependencies = withModulators(Array.from(audioUnitBoxes[0].graph.dependenciesOf(audioUnitBoxes, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes))
        const uuidMap = generateMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        copyBoxes(uuidMap, boxGraph, audioUnitBoxes, dependencies)
        reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        audioUnitBoxSet.forEach((_, trackBoxes) => [...trackBoxes]
            .sort(compareIndex)
            .forEach((source: TrackBox, index) => {
                const box = boxGraph
                    .findBox(uuidMap.get(source.address.uuid, "uuid mapping").target)
                    .unwrap("Target Track has not been copied")
                asInstanceOf(box, TrackBox).index.setValue(index)
            }))
        const minPosition = regionBoxes.reduce((min, region) =>
            Math.min(min, region.position.getValue()), Number.MAX_VALUE)
        const delta = insertPosition - minPosition
        regionBoxes.forEach((source: AnyRegionBox) => {
            const box = boxGraph
                .findBox(uuidMap.get(source.address.uuid, "uuid mapping").target)
                .unwrap("Target Track has not been copied")
            const {position} = UnionBoxTypes.asRegionBox(box)
            position.setValue(position.getValue() + delta)
        })
    }
}

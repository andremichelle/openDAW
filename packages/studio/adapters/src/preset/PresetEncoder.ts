import {Arrays, ByteArrayInput, ByteArrayOutput, Option, UUID} from "@opendaw/lib-std"
import {Box, IndexedBox, PointerField} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, CaptureAudioBox, CaptureMidiBox, NoopInstrumentBox} from "@opendaw/studio-boxes"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "../transfer"
import {PresetHeader} from "./PresetHeader"

export namespace PresetEncoder {
    export const encode = (audioUnitBox: AudioUnitBox,
                           options: {
                               excludeEffect?: (box: Box) => boolean,
                               includeTimeline?: boolean
                           } = {}): ArrayBufferLike => {
        const header = ByteArrayOutput.create()
        header.writeInt(PresetHeader.MAGIC_HEADER_OPEN)
        header.writeInt(PresetHeader.FORMAT_VERSION)
        const preset = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = preset
        const audioUnitBoxes = [audioUnitBox]
        const excludeEffect = options.excludeEffect ?? (() => false)
        const includeTimeline = options.includeTimeline === true
        const excludeBox = (box: Box): boolean =>
            TransferUtils.shouldExclude(box)
            || (!includeTimeline && TransferUtils.excludeTimelinePredicate(box))
            || excludeEffect(box)
        boxGraph.beginTransaction()
        const dependencies = Array.from(audioUnitBox.graph.dependenciesOf(audioUnitBoxes, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes)
        const summary: Record<string, number> = {}
        for (const dep of dependencies) {
            summary[dep.name] = (summary[dep.name] ?? 0) + 1
        }
        console.info(`PresetEncoder.encode: includeTimeline=${includeTimeline}, deps=${dependencies.length}`,
            summary)
        const uuidMap = TransferUtils.generateMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        TransferUtils.copyBoxes(uuidMap, boxGraph, audioUnitBoxes, dependencies)
        TransferUtils.reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        boxGraph.endTransaction()
        return Arrays.concatArrayBuffers(header.toArrayBuffer(), boxGraph.toArrayBuffer())
    }

    export const encodeEffects = (
        effects: ReadonlyArray<Box>,
        kind: PresetHeader.ChainKind
    ): ArrayBufferLike => {
        const header = ByteArrayOutput.create()
        header.writeInt(PresetHeader.MAGIC_HEADER_OPEN)
        header.writeInt(PresetHeader.FORMAT_VERSION)
        const preset = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = preset
        boxGraph.beginTransaction()
        const captureBox = kind === PresetHeader.ChainKind.Audio
            ? CaptureAudioBox.create(boxGraph, UUID.generate())
            : CaptureMidiBox.create(boxGraph, UUID.generate())
        const wrapperAudioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(0)
            box.type.setValue(AudioUnitType.Instrument)
            box.capture.refer(captureBox)
        })
        NoopInstrumentBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(wrapperAudioUnit.input)
        })
        if (effects.length > 0) {
            const sourceGraph = effects[0].graph
            const excludeBox = (box: Box): boolean =>
                TransferUtils.shouldExclude(box)
                || TransferUtils.excludeTimelinePredicate(box)
                || box instanceof AudioUnitBox
            const effectSet = new Set<Box>(effects)
            const dependencies = Array.from(sourceGraph.dependenciesOf(effects, {
                alwaysFollowMandatory: true,
                stopAtResources: true,
                excludeBox
            }).boxes).filter(box => !effectSet.has(box))
            const uuidMap = UUID.newSet<TransferUtils.UUIDMapper>(({source}) => source)
            uuidMap.addMany([
                ...effects.map(box => ({source: box.address.uuid, target: UUID.generate()})),
                ...dependencies.map(box => ({
                    source: box.address.uuid,
                    target: box.resource === "preserved" ? box.address.uuid : UUID.generate()
                }))
            ])
            const targetField = kind === PresetHeader.ChainKind.Audio
                ? wrapperAudioUnit.audioEffects
                : wrapperAudioUnit.midiEffects
            const hostPointerType: Pointers = kind === PresetHeader.ChainKind.Audio
                ? Pointers.AudioEffectHost
                : Pointers.MIDIEffectHost
            PointerField.decodeWith({
                map: (pointer, address) => {
                    if (pointer.pointerType === hostPointerType) {
                        return Option.wrap(targetField.address)
                    }
                    return address.flatMap(addr => uuidMap.opt(addr.uuid).match({
                        some: ({target}) => Option.wrap(addr.moveTo(target)),
                        none: () => boxGraph.findBox(addr.uuid).nonEmpty() ? Option.wrap(addr) : Option.None
                    }))
                }
            }, () => {
                effects.forEach((source, i) => {
                    const input = new ByteArrayInput(source.toArrayBuffer())
                    const uuid = uuidMap.get(source.address.uuid).target
                    boxGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => {
                        box.read(input)
                        if (IndexedBox.isIndexedBox(box)) {box.index.setValue(i)}
                    })
                })
                dependencies.forEach(source => {
                    const input = new ByteArrayInput(source.toArrayBuffer())
                    const uuid = uuidMap.get(source.address.uuid).target
                    boxGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
                })
            })
        }
        boxGraph.endTransaction()
        return Arrays.concatArrayBuffers(header.toArrayBuffer(), boxGraph.toArrayBuffer())
    }
}

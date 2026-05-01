import {
    asDefined,
    asInstanceOf,
    Attempt,
    Attempts,
    ByteArrayInput,
    int,
    isAbsent,
    isDefined,
    isInstanceOf,
    Option,
    RuntimeNotifier,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, IndexedBox, PointerField} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {
    AudioFileBox,
    AudioUnitBox,
    BoxIO,
    BoxVisitor,
    CaptureAudioBox,
    CaptureMidiBox,
    SoundfontFileBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "../transfer"
import {PresetHeader} from "./PresetHeader"
import {TrackType} from "../timeline/TrackType"

export namespace PresetDecoder {
    export const decode = (bytes: ArrayBufferLike, target: ProjectSkeleton): ReadonlyArray<AudioUnitBox> => {
        const header = new ByteArrayInput(bytes.slice(0, 8))
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {
            RuntimeNotifier.info({
                headline: "Could Not Import Preset",
                message: "Invalid preset file"
            }).then()
            return []
        }
        const version = header.readInt()
        if (version !== PresetHeader.FORMAT_VERSION) {
            RuntimeNotifier.info({
                headline: "Could Not Import Preset",
                message: `Unsupported preset version ${version} (this build supports ${PresetHeader.FORMAT_VERSION}).`
            }).then()
            return []
        }
        const sourceBoxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        try {
            sourceBoxGraph.fromArrayBuffer(bytes.slice(8), false)
        } catch (reason) {
            RuntimeNotifier.info({
                headline: "Could Not Import Preset",
                message: String(reason)
            }).then()
            return []
        }
        const summary: Record<string, number> = {}
        for (const box of sourceBoxGraph.boxes()) {
            summary[box.name] = (summary[box.name] ?? 0) + 1
        }
        console.info(`PresetDecoder.decode: source graph boxes`, summary)
        const sourceAudioUnitBoxes = sourceBoxGraph.boxes()
            .filter(box => isInstanceOf(box, AudioUnitBox))
            .filter(box => box.type.getValue() !== AudioUnitType.Output)
        const excludeBox = (box: Box): boolean => TransferUtils.shouldExclude(box)
        const dependencies = Array.from(sourceBoxGraph.dependenciesOf(sourceAudioUnitBoxes, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes)
        const {mandatoryBoxes: {rootBox, primaryAudioBusBox}} = target
        const uuidMap = TransferUtils.generateMap(
            sourceAudioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        TransferUtils.copyBoxes(uuidMap, target.boxGraph, sourceAudioUnitBoxes, dependencies)
        TransferUtils.reorderAudioUnits(uuidMap, sourceAudioUnitBoxes, rootBox)
        const importedAudioUnits = sourceAudioUnitBoxes
            .map(source => asInstanceOf(rootBox.graph
                .findBox(uuidMap.get(source.address.uuid).target)
                .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
            .filter(box => box.type.getValue() !== AudioUnitType.Output)
        importedAudioUnits.forEach((audioUnitBox) => {
            const inputBox = audioUnitBox.input.pointerHub.incoming().at(0)?.box
            if (!isDefined(inputBox)) {return}
            const existingTrackCount = audioUnitBox.tracks.pointerHub.incoming().length
            console.info(`PresetDecoder.decode: AudioUnit ${UUID.toString(audioUnitBox.address.uuid)} has ${existingTrackCount} pre-copied track(s)`)
            if (existingTrackCount > 0) {return}
            audioUnitBox.capture.targetVertex.ifSome(({box: captureBox}) => {
                if (captureBox instanceof CaptureMidiBox) {
                    TrackBox.create(target.boxGraph, UUID.generate(), box => {
                        box.index.setValue(0)
                        box.type.setValue(TrackType.Notes)
                        box.target.refer(audioUnitBox)
                        box.tracks.refer(audioUnitBox.tracks)
                    })
                } else if (captureBox instanceof CaptureAudioBox) {
                    TrackBox.create(target.boxGraph, UUID.generate(), box => {
                        box.index.setValue(0)
                        box.type.setValue(TrackType.Audio)
                        box.target.refer(audioUnitBox)
                        box.tracks.refer(audioUnitBox.tracks)
                    })
                }
            })
        })
        return importedAudioUnits
    }

    export const peekHasTimeline = (arrayBuffer: ArrayBuffer): boolean => {
        if (arrayBuffer.byteLength < 8) {return false}
        const header = new ByteArrayInput(arrayBuffer.slice(0, 8))
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {return false}
        if (header.readInt() !== PresetHeader.FORMAT_VERSION) {return false}
        const sourceBoxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const decoded = tryCatch(() => sourceBoxGraph.fromArrayBuffer(arrayBuffer.slice(8), false))
        if (decoded.status === "failure") {return false}
        for (const box of sourceBoxGraph.boxes()) {
            if (isInstanceOf(box, TrackBox)) {return true}
        }
        return false
    }

    export const replaceAudioUnit = (arrayBuffer: ArrayBuffer, targetAudioUnitBox: AudioUnitBox, options?: {
        keepMIDIEffects?: boolean
        keepAudioEffects?: boolean
        keepTimeline?: boolean
    }): Attempt<void, string> => {
        console.debug("ReplaceAudioUnit with preset...")
        const skeleton = ProjectSkeleton.empty({
            createDefaultUser: false,
            createOutputMaximizer: false
        })
        const sourceBoxGraph = skeleton.boxGraph
        const targetBoxGraph = targetAudioUnitBox.graph
        sourceBoxGraph.beginTransaction()
        decode(arrayBuffer, skeleton)
        sourceBoxGraph.endTransaction()

        const sourceAudioUnitBox = skeleton.mandatoryBoxes.rootBox.audioUnits.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, AudioUnitBox))
            .find((box) => box.type.getValue() !== AudioUnitType.Output)
        if (isAbsent(sourceAudioUnitBox)) {
            return Attempts.err("Preset contains no valid audio unit. Please send the file to the developers.")
        }
        const sourceCaptureBox = sourceAudioUnitBox.capture.targetVertex.mapOr(({box}) => box.name, "")
        const targetCaptureBox = targetAudioUnitBox.capture.targetVertex.mapOr(({box}) => box.name, "")
        if (sourceCaptureBox !== targetCaptureBox) {
            return Attempts.err("Cannot replace incompatible instruments")
        }
        const replaceMIDIEffects = options?.keepMIDIEffects !== true
        const replaceAudioEffects = options?.keepAudioEffects !== true
        const replaceTimeline = options?.keepTimeline !== true

        console.debug("replaceMIDIEffects", replaceMIDIEffects)
        console.debug("replaceAudioEffects", replaceAudioEffects)
        console.debug("replaceTimeline", replaceTimeline)

        asDefined(targetAudioUnitBox.input.pointerHub.incoming().at(0)?.box, "Target has no input").delete()

        if (replaceMIDIEffects) {
            targetAudioUnitBox.midiEffects.pointerHub.incoming().forEach(({box}) => box.delete())
        } else {
            sourceBoxGraph.beginTransaction()
            sourceAudioUnitBox.midiEffects.pointerHub.incoming().forEach(({box}) => box.delete())
            sourceBoxGraph.endTransaction()
        }
        if (replaceAudioEffects) {
            targetAudioUnitBox.audioEffects.pointerHub.incoming().forEach(({box}) => box.delete())
        } else {
            sourceBoxGraph.beginTransaction()
            sourceAudioUnitBox.audioEffects.pointerHub.incoming().forEach(({box}) => box.delete())
            sourceBoxGraph.endTransaction()
        }

        const sourceHasTracks = sourceAudioUnitBox.tracks.pointerHub.incoming().length > 0
        if (sourceHasTracks && replaceTimeline) {
            targetAudioUnitBox.tracks.pointerHub.incoming().forEach(({box}) => box.delete())
        }

        // Capture boxes live on the target's AudioUnit already and must not be duplicated.
        // When the caller wants to keep the target's existing timeline, also exclude TrackBox
        // (and everything reached through it) so source tracks aren't copied in.
        const excludeBox = (box: Box) => {
            if (box.accept<BoxVisitor<boolean>>({
                visitCaptureMidiBox: (_box: CaptureMidiBox): boolean => true,
                visitCaptureAudioBox: (_box: CaptureAudioBox): boolean => true
            }) === true) {return true}
            if (!replaceTimeline && TransferUtils.excludeTimelinePredicate(box)) {return true}
            return false
        }

        type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)

        const dependencies = Array.from(sourceBoxGraph.dependenciesOf(sourceAudioUnitBox, {
            excludeBox,
            alwaysFollowMandatory: true,
            stopAtResources: true
        }).boxes)
        uuidMap.addMany([
            {
                source: sourceAudioUnitBox.address.uuid,
                target: targetAudioUnitBox.address.uuid
            },
            ...dependencies
                .map(({address: {uuid}, name}) =>
                    ({
                        source: uuid,
                        target: name === AudioFileBox.ClassName || name === SoundfontFileBox.ClassName
                            ? uuid
                            : UUID.generate()
                    }))
        ])
        // First, identify which file boxes already exist and should be skipped
        const existingFileBoxUUIDs = UUID.newSet<UUID.Bytes>(uuid => uuid)
        dependencies.forEach((source: Box) => {
            if (source instanceof AudioFileBox || source instanceof SoundfontFileBox) {
                if (targetBoxGraph.findBox(source.address.uuid).nonEmpty()) {
                    existingFileBoxUUIDs.add(source.address.uuid)
                }
            }
        })
        PointerField.decodeWith({
            map: (_pointer: PointerField, newAddress: Option<Address>): Option<Address> =>
                newAddress.flatMap(address => uuidMap.opt(address.uuid).match({
                    some: ({target}) => Option.wrap(address.moveTo(target)),
                    none: () => targetBoxGraph.findBox(address.uuid).nonEmpty() ? Option.wrap(address) : Option.None
                }))
        }, () => {
            dependencies
                .forEach((source: Box) => {
                    if (source instanceof AudioFileBox || source instanceof SoundfontFileBox) {
                        // Those boxes keep their UUID. So if they are already in the graph, skip them.
                        if (existingFileBoxUUIDs.opt(source.address.uuid).nonEmpty()) {
                            return
                        }
                    }
                    const input = new ByteArrayInput(source.toArrayBuffer())
                    const key = source.name as keyof BoxIO.TypeMap
                    const uuid = uuidMap.get(source.address.uuid).target
                    targetBoxGraph.createBox(key, uuid, box => box.read(input))
                })
        })
        return Attempts.Ok
    }

    export const insertEffectChain = (
        bytes: ArrayBufferLike,
        targetAudioUnit: AudioUnitBox,
        insertIndex: int,
        kind: PresetHeader.ChainKind
    ): Attempt<void, string> => {
        const headerInput = new ByteArrayInput(bytes.slice(0, 8))
        if (headerInput.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {
            return Attempts.err("Invalid preset header")
        }
        const version = headerInput.readInt()
        if (version !== PresetHeader.FORMAT_VERSION) {
            return Attempts.err(
                `Unsupported preset version ${version} (this build supports ${PresetHeader.FORMAT_VERSION}).`)
        }
        const sourceGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const loaded = tryCatch(() => sourceGraph.fromArrayBuffer(bytes.slice(8), false))
        if (loaded.status === "failure") {
            return Attempts.err(`Failed to decode preset: ${String(loaded.error)}`)
        }
        const sourceAudioUnit = sourceGraph.boxes()
            .filter(box => isInstanceOf(box, AudioUnitBox))
            .map(box => asInstanceOf(box, AudioUnitBox))
            .find(box => box.type.getValue() !== AudioUnitType.Output)
        if (isAbsent(sourceAudioUnit)) {
            return Attempts.err("Preset contains no audio unit")
        }
        const sourceField = kind === PresetHeader.ChainKind.Audio
            ? sourceAudioUnit.audioEffects
            : sourceAudioUnit.midiEffects
        const effects = IndexedBox.collectIndexedBoxes(sourceField)
        if (effects.length === 0) {return Attempts.err("Preset contains no effects of the requested kind")}
        const targetField = kind === PresetHeader.ChainKind.Audio
            ? targetAudioUnit.audioEffects
            : targetAudioUnit.midiEffects
        const targetFieldAddress = targetField.address
        const hostPointerType: Pointers = kind === PresetHeader.ChainKind.Audio
            ? Pointers.AudioEffectHost
            : Pointers.MIDIEffectHost
        const targetGraph = targetAudioUnit.graph
        const count = effects.length
        const existing = IndexedBox.collectIndexedBoxes(targetField)
        for (let i = existing.length - 1; i >= 0; i--) {
            const box = existing[i]
            const current = box.index.getValue()
            if (current >= insertIndex) {
                box.index.setValue(current + count)
            }
        }
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
        const existingPreservedUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
        dependencies.forEach(source => {
            if (source.resource === "preserved" && targetGraph.findBox(source.address.uuid).nonEmpty()) {
                existingPreservedUuids.add(source.address.uuid)
            }
        })
        const uuidMap = UUID.newSet<TransferUtils.UUIDMapper>(({source}) => source)
        uuidMap.addMany([
            ...effects.map(box => ({source: box.address.uuid, target: UUID.generate()})),
            ...dependencies.map(box => ({
                source: box.address.uuid,
                target: box.resource === "preserved" ? box.address.uuid : UUID.generate()
            }))
        ])
        PointerField.decodeWith({
            map: (pointer: PointerField, address: Option<Address>): Option<Address> => {
                if (pointer.pointerType === hostPointerType) {
                    return Option.wrap(targetFieldAddress)
                }
                return address.flatMap(addr => uuidMap.opt(addr.uuid).match({
                    some: ({target}) => Option.wrap(addr.moveTo(target)),
                    none: () => targetGraph.findBox(addr.uuid).nonEmpty() ? Option.wrap(addr) : Option.None
                }))
            }
        }, () => {
            effects.forEach((source, i) => {
                const input = new ByteArrayInput(source.toArrayBuffer())
                const uuid = uuidMap.get(source.address.uuid).target
                targetGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => {
                    box.read(input)
                    if (IndexedBox.isIndexedBox(box)) {box.index.setValue(insertIndex + i)}
                })
            })
            dependencies.forEach(source => {
                if (existingPreservedUuids.hasKey(source.address.uuid)) {return}
                const input = new ByteArrayInput(source.toArrayBuffer())
                const uuid = uuidMap.get(source.address.uuid).target
                targetGraph.createBox(source.name as keyof BoxIO.TypeMap, uuid, box => box.read(input))
            })
        })
        return Attempts.Ok
    }
}
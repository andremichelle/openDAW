import {
    asDefined,
    asInstanceOf,
    Attempt,
    Attempts,
    ByteArrayInput,
    isAbsent,
    isDefined,
    isInstanceOf,
    Option,
    RuntimeNotifier,
    UUID
} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, PointerField} from "@opendaw/lib-box"
import {AudioUnitType} from "@opendaw/studio-enums"
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
    export const decode = (bytes: ArrayBufferLike, target: ProjectSkeleton) => {
        const header = new ByteArrayInput(bytes.slice(0, 8))
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {
            RuntimeNotifier.info({
                headline: "Could Not Import Preset",
                message: "Invalid preset file"
            }).then()
            return
        }
        if (header.readInt() !== PresetHeader.FORMAT_VERSION) {
            RuntimeNotifier.info({
                headline: "Could Not Import Preset",
                message: "Invalid preset version"
            }).then()
            return
        }
        const sourceBoxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        try {
            sourceBoxGraph.fromArrayBuffer(bytes.slice(8))
        } catch (reason) {
            RuntimeNotifier.info({
                headline: "Could Not Import Preset",
                message: String(reason)
            }).then()
            return
        }
        const sourceAudioUnitBoxes = sourceBoxGraph.boxes()
            .filter(box => isInstanceOf(box, AudioUnitBox))
            .filter(box => box.type.getValue() !== AudioUnitType.Output)
        const excludeBox = (box: Box): boolean =>
            TransferUtils.shouldExclude(box) || TransferUtils.excludeTimelinePredicate(box)
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
        sourceAudioUnitBoxes
            .map(source => asInstanceOf(rootBox.graph
                .findBox(uuidMap.get(source.address.uuid).target)
                .unwrap("Target AudioUnit has not been copied"), AudioUnitBox))
            .filter(box => box.type.getValue() !== AudioUnitType.Output)
            .forEach((audioUnitBox) => {
                const inputBox = audioUnitBox.input.pointerHub.incoming().at(0)?.box
                if (isDefined(inputBox)) {
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
                }
            })
    }

    export const replaceAudioUnit = (arrayBuffer: ArrayBuffer, targetAudioUnitBox: AudioUnitBox, options?: {
        keepMIDIEffects?: boolean
        keepAudioEffects?: boolean
    }): Attempt<void, string> => {
        console.debug("ReplaceAudioUnit with preset...")
        const skeleton = ProjectSkeleton.empty({
            createDefaultUser: false,
            createOutputCompressor: false
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

        console.debug("replaceMIDIEffects", replaceMIDIEffects)
        console.debug("replaceAudioEffects", replaceAudioEffects)

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

        // We do not take track or capture boxes into account
        const excludeBox = (box: Box) => box.accept<BoxVisitor<boolean>>({
            visitTrackBox: (_box: TrackBox): boolean => true,
            visitCaptureMidiBox: (_box: CaptureMidiBox): boolean => true,
            visitCaptureAudioBox: (_box: CaptureAudioBox): boolean => true
        }) === true

        type UUIDMapper = { source: UUID.Bytes, target: UUID.Bytes }
        const uuidMap = UUID.newSet<UUIDMapper>(({source}) => source)

        const dependencies = Array.from(sourceBoxGraph.dependenciesOf(sourceAudioUnitBox, {
            excludeBox,
            alwaysFollowMandatory: false
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
                newAddress.map(address => uuidMap.opt(address.uuid).match({
                    none: () => address,
                    some: ({target}) => address.moveTo(target)
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
}
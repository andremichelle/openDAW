import {BoxGraph} from "@opendaw/lib-box"
import {
    AudioBusBox,
    AudioUnitBox,
    BoxIO,
    BoxVisitor,
    CompressorDeviceBox,
    GrooveShuffleBox,
    RootBox,
    TimelineBox,
    UserInterfaceBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {
    asInstanceOf,
    assert,
    ByteArrayInput,
    ByteArrayOutput,
    isDefined,
    Maybe,
    Option,
    panic,
    UUID
} from "@opendaw/lib-std"
import {AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import {ProjectMandatoryBoxes} from "./ProjectMandatoryBoxes"

export type ProjectSkeleton = {
    boxGraph: BoxGraph<BoxIO.TypeMap>,
    mandatoryBoxes: ProjectMandatoryBoxes
}

export namespace ProjectSkeleton {
    const MAGIC_HEADER_OPEN = 0x4F50454E
    const FORMAT_VERSION = 2

    export const empty = (options: {
        createOutputCompressor: boolean,
        createDefaultUser: boolean
    }): ProjectSkeleton => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const isoString = new Date().toISOString()
        console.debug(`New Project created on ${isoString}`)
        boxGraph.beginTransaction()
        const grooveShuffleBox = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Groove Shuffle")
        })
        const rootBox = RootBox.create(boxGraph, UUID.generate(), box => {
            box.groove.refer(grooveShuffleBox)
            box.created.setValue(isoString)
        })
        const primaryAudioBus = AudioBusBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioBusses)
            box.label.setValue("Output")
            box.icon.setValue(IconSymbol.toName(IconSymbol.SpeakerHeadphone))
            box.color.setValue(Colors.blue.toString())
        })
        const primaryAudioOutputUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Output)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(rootBox.outputDevice)
            box.index.setValue(0)
        })
        if (options.createOutputCompressor) {
            CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Master Compressor")
                box.index.setValue(0)
                box.host.refer(primaryAudioOutputUnit.audioEffects)
                box.threshold.setValue(0)
                box.ratio.setValue(24)
            })
        }
        const timelineBox = TimelineBox.create(boxGraph, UUID.generate())
        ValueEventCollectionBox.create(boxGraph, UUID.generate(),
            box => timelineBox.tempoTrack.events.refer(box.owners))
        rootBox.timeline.refer(timelineBox.root)
        primaryAudioBus.output.refer(primaryAudioOutputUnit.input)
        const userInterfaceBoxes: Array<UserInterfaceBox> = []
        if (options.createDefaultUser) {
            const userInterfaceBox = UserInterfaceBox.create(boxGraph, UUID.generate())
            userInterfaceBox.root.refer(rootBox.users)
            userInterfaceBoxes.push(userInterfaceBox)
        }
        boxGraph.endTransaction()
        return {
            boxGraph,
            mandatoryBoxes: {
                rootBox,
                primaryAudioBusBox: primaryAudioBus,
                primaryAudioUnitBox: primaryAudioOutputUnit,
                timelineBox,
                userInterfaceBoxes
            }
        }
    }

    export const encode = (boxGraph: BoxGraph) => {
        const output = ByteArrayOutput.create()
        output.writeInt(MAGIC_HEADER_OPEN)
        output.writeInt(FORMAT_VERSION)
        const boxGraphChunk = boxGraph.toArrayBuffer()
        output.writeInt(boxGraphChunk.byteLength)
        output.writeBytes(new Int8Array(boxGraphChunk))
        return output.toArrayBuffer()
    }

    export const decode = (arrayBuffer: ArrayBufferLike): ProjectSkeleton => {
        const input = new ByteArrayInput(arrayBuffer)
        assert(input.readInt() === MAGIC_HEADER_OPEN,
            "Corrupt header. Probably not an openDAW project file.")
        assert(input.readInt() === FORMAT_VERSION,
            "Deprecated Format")
        const boxGraphChunkLength = input.readInt()
        const boxGraphChunk = new Int8Array(boxGraphChunkLength)
        input.readBytes(boxGraphChunk)
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        boxGraph.fromArrayBuffer(boxGraphChunk.buffer)
        return {boxGraph, mandatoryBoxes: findMandatoryBoxes(boxGraph)}
    }

    export const findMandatoryBoxes = (boxGraph: BoxGraph): ProjectMandatoryBoxes => {
        const rootBox: Maybe<RootBox> = boxGraph.boxes().find(box =>
            box.accept<BoxVisitor<boolean>>({visitRootBox: () => true})) as Maybe<RootBox>
        if (isDefined(rootBox)) {
            const primaryAudioOutputUnit = asInstanceOf(rootBox.outputDevice.pointerHub.incoming().at(0)?.box, AudioUnitBox)
            const primaryAudioBus = asInstanceOf(primaryAudioOutputUnit.input.pointerHub.incoming().at(0)?.box, AudioBusBox)
            const timelineBox = asInstanceOf(rootBox.timeline.targetVertex.unwrap("TimelineBox not found").box, TimelineBox)
            const userInterfaceBoxes = rootBox.users.pointerHub.incoming().map(({box}) => asInstanceOf(box, UserInterfaceBox))
            return {
                rootBox,
                primaryAudioBusBox: primaryAudioBus,
                primaryAudioUnitBox: primaryAudioOutputUnit,
                timelineBox,
                userInterfaceBoxes
            }
        }
        return panic("Could not find mandatory boxes")
    }
}

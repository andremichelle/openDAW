import {
    AudioClipBox,
    AudioFileBox,
    AudioRegionBox,
    AudioUnitBox,
    BoxVisitor,
    DelayDeviceBox,
    GrooveShuffleBox,
    MIDIOutputDeviceBox,
    NeuralAmpDeviceBox,
    RevampDeviceBox,
    TimelineBox,
    ValueEventBox,
    ValueEventCollectionBox,
    VaporisateurDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {asInstanceOf, Subscription, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioData} from "@opendaw/lib-dsp"
import {ProjectEnv} from "./ProjectEnv"
import {
    migrateAudioClipBox,
    migrateAudioFileBox,
    migrateAudioRegionBox,
    migrateAudioUnitBox,
    migrateDelayDeviceBox,
    migrateMIDIOutputDeviceBox,
    migrateNeuralAmpDeviceBox,
    migrateRevampDeviceBox,
    migrateTimelineBox,
    migrateValueEventBox,
    migrateValueEventCollection,
    migrateVaporisateurDeviceBox,
    migrateZeitgeistDeviceBox
} from "./migration"

export class ProjectMigration {
    static async migrate(env: ProjectEnv, {boxGraph, mandatoryBoxes}: ProjectSkeleton) {
        const {rootBox, timelineBox: {bpm}} = mandatoryBoxes
        console.debug("migrate project from", rootBox.created.getValue())
        if (rootBox.groove.targetAddress.isEmpty()) {
            console.debug("Migrate to global GrooveShuffleBox")
            boxGraph.beginTransaction()
            rootBox.groove.refer(GrooveShuffleBox.create(boxGraph, UUID.generate()))
            boxGraph.endTransaction()
        }
        const globalShuffle = asInstanceOf(rootBox.groove.targetVertex.unwrap(), GrooveShuffleBox).label
        if (globalShuffle.getValue() !== "Groove Shuffle") {
            boxGraph.beginTransaction()
            globalShuffle.setValue("Groove Shuffle")
            boxGraph.endTransaction()
        }
        const loadAudioData = (uuid: Uint8Array): Promise<AudioData> => {
            const {promise, resolve, reject} = Promise.withResolvers<AudioData>()
            const loader = env.sampleManager.getOrCreate(uuid)
            let subscription: Subscription
            subscription = loader.subscribe(state => {
                if (state.type === "loaded") {
                    queueMicrotask(() => subscription.terminate())
                    resolve(loader.data.unwrap("State mismatch"))
                } else if (state.type === "error") {
                    queueMicrotask(() => subscription.terminate())
                    reject(new Error(state.reason))
                }
            })
            return promise
        }
        const orphans = boxGraph.findOrphans(rootBox)
        if (orphans.length > 0) {
            console.debug("Migrate remove orphaned boxes: ", orphans.length)
            boxGraph.beginTransaction()
            orphans.forEach(orphan => orphan.delete())
            boxGraph.endTransaction()
        }
        const grooveTarget = rootBox.groove.targetVertex.unwrap()
        const outputMidiDevices = rootBox.outputMidiDevices
        const bpmValue = bpm.getValue()
        // 1st pass (2nd pass might rely on those changes)
        for (const box of boxGraph.boxes()) {
            await box.accept<BoxVisitor<Promise<unknown>>>({
                visitAudioFileBox: (box: AudioFileBox) => migrateAudioFileBox(boxGraph, box, loadAudioData),
                visitNeuralAmpDeviceBox: (box: NeuralAmpDeviceBox) => migrateNeuralAmpDeviceBox(boxGraph, box)
            })
        }
        // 2nd pass. We need to run on a copy, because we might add more boxes during the migration
        boxGraph.boxes().slice().forEach(box => box.accept<BoxVisitor>({
            visitAudioRegionBox: (box: AudioRegionBox) => migrateAudioRegionBox(boxGraph, box, bpmValue),
            visitAudioClipBox: (box: AudioClipBox) => migrateAudioClipBox(boxGraph, box),
            visitTimelineBox: (box: TimelineBox) => migrateTimelineBox(boxGraph, box),
            visitMIDIOutputDeviceBox: (box: MIDIOutputDeviceBox) => migrateMIDIOutputDeviceBox(boxGraph, box, outputMidiDevices),
            visitZeitgeistDeviceBox: (box: ZeitgeistDeviceBox) => migrateZeitgeistDeviceBox(boxGraph, box, grooveTarget),
            visitValueEventBox: (box: ValueEventBox) => migrateValueEventBox(boxGraph, box),
            visitAudioUnitBox: (box: AudioUnitBox) => migrateAudioUnitBox(boxGraph, box),
            visitRevampDeviceBox: (box: RevampDeviceBox) => migrateRevampDeviceBox(boxGraph, box),
            visitVaporisateurDeviceBox: (box: VaporisateurDeviceBox) => migrateVaporisateurDeviceBox(boxGraph, box),
            visitValueEventCollectionBox: (box: ValueEventCollectionBox) => migrateValueEventCollection(boxGraph, box),
            visitDelayDeviceBox: (box: DelayDeviceBox) => migrateDelayDeviceBox(boxGraph, box)
        }))
    }
}
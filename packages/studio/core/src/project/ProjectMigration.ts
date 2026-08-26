import {
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioTimeStretchBox,
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
import {asInstanceOf, Subscription, tryCatch, UUID} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioData} from "@opendaw/lib-dsp"
import {ProjectEnv} from "./ProjectEnv"
import {
    migrateAudioClipBox,
    migrateAudioFileBox,
    migrateAudioRegionBox,
    migrateAudioRegionOverlaps,
    migrateAudioUnitBox,
    migrateCaptureTrackMismatch,
    migrateDefaultLabels,
    migrateDelayDeviceBox,
    migrateMIDIOutputDeviceBox,
    migrateNeuralAmpDeviceBox,
    migrateRevampDeviceBox,
    migrateTimelineBox,
    migrateValueEventBox,
    migrateValueEventCollection,
    migrateUndefinedTracks,
    migrateUnsatisfiedMandatory,
    migrateVaporisateurDeviceBox,
    migrateWarpMarkers,
    migrateZeitgeistDeviceBox,
    migrateZeroDurationRegions
} from "./migration"

export class ProjectMigration {
    static async migrate(env: ProjectEnv, {boxGraph, mandatoryBoxes}: ProjectSkeleton) {
        const {rootBox, timelineBox: {bpm}} = mandatoryBoxes
        console.debug("migrate project from", rootBox.created.getValue())
        // A pointer whose target is gone becomes a pointer that was never set, so every "not set" branch
        // below repairs it without knowing anything about dangling. Whatever is still unsatisfied once they
        // have all run is removed by migrateUnsatisfiedMandatory at the end.
        boxGraph.clearUnresolvablePointers()
        if (rootBox.groove.targetAddress.isEmpty()) {
            console.debug("Migrate to global GrooveShuffleBox")
            boxGraph.beginTransaction()
            rootBox.groove.refer(GrooveShuffleBox.create(boxGraph, UUID.generate()))
            boxGraph.endTransaction()
        }
        const globalShuffle = asInstanceOf(rootBox.groove.targetVertex.unwrap("groove.target"), GrooveShuffleBox).label
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
        const grooveTarget = rootBox.groove.targetVertex.unwrap("groove.target")
        const outputMidiDevices = rootBox.outputMidiDevices
        const bpmValue = bpm.getValue()
        // A pass may dereference a pointer that clearUnresolvablePointers left unset, and that box is on its
        // way out anyway (migrateUnsatisfiedMandatory below), so one doomed box must not abort the whole
        // migration. ONLY a doomed box is tolerated: anything else rethrows, so a genuine bug in a pass still
        // fails loudly instead of loading a half-migrated project.
        const doomed = (box: Box): boolean =>
            boxGraph.edges().unsatisfiedMandatoryPointers().some(pointer => pointer.box === box)
        const perBox = (box: Box, visitor: BoxVisitor): void => {
            const result = tryCatch(() => box.accept<BoxVisitor>(visitor))
            if (result.status === "failure") {
                // Passes open their own transaction and throw inside it, so roll that back or every later
                // pass runs unvalidated inside a transaction nobody closes.
                if (boxGraph.inTransaction()) {boxGraph.abortTransaction()}
                if (!doomed(box)) {throw result.error}
                console.warn(`[Migration] skipped doomed ${box.name} ${box.address.toString()}:`, result.error)
            }
        }
        // 1st pass (2nd pass might rely on those changes)
        for (const box of boxGraph.boxes()) {
            await box.accept<BoxVisitor<Promise<unknown>>>({
                visitAudioFileBox: (box: AudioFileBox) => migrateAudioFileBox(boxGraph, box, loadAudioData),
                visitNeuralAmpDeviceBox: (box: NeuralAmpDeviceBox) => migrateNeuralAmpDeviceBox(boxGraph, box)
            })
        }
        // 2nd pass. We need to run on a copy, because we might add more boxes during the migration
        boxGraph.boxes().slice().forEach(box => perBox(box, {
            visitAudioRegionBox: (box: AudioRegionBox) => migrateAudioRegionBox(boxGraph, box, bpmValue),
            visitAudioClipBox: (box: AudioClipBox) => migrateAudioClipBox(boxGraph, box),
            visitAudioPitchStretchBox: (box: AudioPitchStretchBox) => migrateWarpMarkers(boxGraph, box),
            visitAudioTimeStretchBox: (box: AudioTimeStretchBox) => migrateWarpMarkers(boxGraph, box),
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
        // 3rd pass. Drop content tracks whose type no longer matches their unit's capture device (a MIDI
        // instrument swapped for a Tape leaves note tracks on an audio-capture unit, and vice versa) — they
        // are unusable and crash editors. Runs after per-unit migration, which ensures each unit has a
        // capture box, so the comparison reflects the current instrument.
        migrateCaptureTrackMismatch(boxGraph)
        // Placeholder Undefined tracks (the old timeline face of track-less units) are gone; the timeline
        // renders a synthetic unit lane instead.
        migrateUndefinedTracks(boxGraph)
        // Hard-coded "Notes" / "Automation" labels are no longer written at creation.
        migrateDefaultLabels(boxGraph)
        // 4th pass. Drop regions with a non-positive (derived) duration — legacy of the zero-length-sample
        // bug — so they can never trip validateTrack on a later edit. Runs after per-region migration (which
        // can rewrite audio durations) and before the overlap heal (which then sees only valid spans).
        migrateZeroDurationRegions(boxGraph, bpmValue)
        // 5th pass. Heal sub-ppqn overlaps that the Int32 position truncation (or the AudioFit->Seconds
        // pass above) left between seconds-based audio regions. Runs after per-region migration.
        migrateAudioRegionOverlaps(boxGraph, bpmValue)
        // Last. Deserialization cleared every pointer whose target was missing, and every pass above had its
        // chance to rebuild what it knows how to rebuild. Whatever still holds an unsatisfied mandatory
        // pointer cannot exist, so it goes. This is the only place the repair deletes, and it knows nothing
        // about any particular box.
        migrateUnsatisfiedMandatory(boxGraph)
    }
}
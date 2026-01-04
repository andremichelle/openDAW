import {
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioUnitBox,
    BoxVisitor,
    CaptureAudioBox,
    CaptureMidiBox,
    DelayDeviceBox,
    GrooveShuffleBox,
    MIDIOutputBox,
    MIDIOutputDeviceBox,
    RevampDeviceBox,
    TimelineBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueEventCurveBox,
    VaporisateurDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {asDefined, asInstanceOf, clamp, Float, isDefined, Subscription, UUID, ValueOwner} from "@opendaw/lib-std"
import {AudioPlayback, AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Field} from "@opendaw/lib-box"
import {AudioData, PPQN, ppqn, seconds, TimeBase} from "@opendaw/lib-dsp"
import {AudioContentHelpers} from "./audio/AudioContentHelpers"
import {ProjectEnv} from "./ProjectEnv"

const isIntEncodedAsFloat = (v: number) =>
    v > 0 && v < 1e-6 && Number.isFinite(v) && (v / 1.401298464324817e-45) % 1 === 0

const toSeconds = (property: ValueOwner<ppqn>, bpm: number): seconds => {
    return PPQN.pulsesToSeconds(property.getValue(), bpm)
}

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
        const loadAudioData = (uuid: UUID.Bytes): Promise<AudioData> => {
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
        if(orphans.length > 0) {
            console.debug("Migrate remove orphaned boxes: ", orphans.length)
            boxGraph.beginTransaction()
            orphans.forEach(orphan => orphan.delete())
            boxGraph.endTransaction()
        }
        // 1st pass (2nd pass might rely on those changes)
        for (const box of boxGraph.boxes()) {
            await box.accept<BoxVisitor<Promise<unknown>>>({
                visitAudioFileBox: async (box: AudioFileBox) => {
                    const {startInSeconds, endInSeconds, fileName} = box
                    if (isIntEncodedAsFloat(startInSeconds.getValue()) || isIntEncodedAsFloat(endInSeconds.getValue()) || endInSeconds.getValue() === 0) {
                        const audioData = await loadAudioData(box.address.uuid)
                        const seconds = audioData.numberOfFrames / audioData.sampleRate
                        console.debug(`Migrate 'AudioFileBox' to float sec (${fileName.getValue()})`, seconds.toFixed(3))
                        boxGraph.beginTransaction()
                        startInSeconds.setValue(0)
                        endInSeconds.setValue(seconds)
                        boxGraph.endTransaction()
                    }
                }
            })
        }
        // 2nd pass. We need to run on a copy, because we might add more boxes during the migration
        boxGraph.boxes().slice().forEach(box => box.accept<BoxVisitor>({
            visitAudioRegionBox: (box: AudioRegionBox): void => {
                const {duration, loopOffset, loopDuration, playback} = box
                if (isIntEncodedAsFloat(duration.getValue())
                    || isIntEncodedAsFloat(loopOffset.getValue())
                    || isIntEncodedAsFloat(loopDuration.getValue())) {
                    console.debug("Migrate 'AudioRegionBox' to float")
                    boxGraph.beginTransaction()
                    duration.setValue(Float.floatToIntBits(duration.getValue()))
                    loopOffset.setValue(Float.floatToIntBits(loopOffset.getValue()))
                    loopDuration.setValue(Float.floatToIntBits(loopDuration.getValue()))
                    boxGraph.endTransaction()
                }
                if (playback.getValue() === AudioPlayback.AudioFit) {
                    console.debug("Migrate 'AudioRegionBox' to AudioPlayback.NoSync")
                    boxGraph.beginTransaction()
                    const file = asInstanceOf(box.file.targetVertex.unwrap(), AudioFileBox)
                    const fileDuration = file.endInSeconds.getValue() - file.startInSeconds.getValue()
                    const currentLoopDurationSeconds = toSeconds(box.loopDuration, bpm.getValue())
                    const scale = fileDuration / currentLoopDurationSeconds
                    const currentDurationSeconds = toSeconds(box.duration, bpm.getValue())
                    const currentLoopOffsetSeconds = toSeconds(box.loopOffset, bpm.getValue())
                    box.timeBase.setValue(TimeBase.Seconds)
                    box.duration.setValue(currentDurationSeconds * scale)
                    box.loopDuration.setValue(fileDuration)
                    box.loopOffset.setValue(currentLoopOffsetSeconds * scale)
                    box.playback.setValue("")
                    boxGraph.endTransaction()
                } else if (playback.getValue() === AudioPlayback.Pitch) {
                    console.debug("Migrate 'AudioRegionBox' to new PitchStretchBox")
                    boxGraph.beginTransaction()
                    const file = asInstanceOf(box.file.targetVertex.unwrap(), AudioFileBox)
                    const fileDuration = file.endInSeconds.getValue() - file.startInSeconds.getValue()
                    const pitchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
                    AudioContentHelpers.addDefaultWarpMarkers(boxGraph,
                        pitchBox, box.loopDuration.getValue(), fileDuration)
                    box.timeBase.setValue(TimeBase.Musical)
                    box.playMode.refer(pitchBox)
                    box.playback.setValue("")
                    boxGraph.endTransaction()
                }
                if (box.events.isEmpty()) {
                    console.debug("Migrate 'AudioRegionBox' to have a ValueEventCollectionBox")
                    boxGraph.beginTransaction()
                    box.events.refer(ValueEventCollectionBox.create(boxGraph, UUID.generate()).owners)
                    boxGraph.endTransaction()
                }
            },
            visitAudioClipBox: (box: AudioClipBox): void => {
                if (box.events.isEmpty()) {
                    console.debug("Migrate 'AudioClipBox' to have a ValueEventCollectionBox")
                    boxGraph.beginTransaction()
                    box.events.refer(ValueEventCollectionBox.create(boxGraph, UUID.generate()).owners)
                    boxGraph.endTransaction()
                }
                if (isIntEncodedAsFloat(box.duration.getValue())) {
                    console.debug("Migrate 'AudioClipBox' to float")
                    boxGraph.beginTransaction()
                    box.duration.setValue(Float.floatToIntBits(box.duration.getValue()))
                    boxGraph.endTransaction()
                }
                if (box.playback.getValue() === AudioPlayback.Pitch) {
                    console.debug("Migrate 'AudioClipBox' to new PitchStretchBox")
                    boxGraph.beginTransaction()
                    const file = asInstanceOf(box.file.targetVertex.unwrap(), AudioFileBox)
                    const fileDuration = file.endInSeconds.getValue() - file.startInSeconds.getValue()
                    const pitchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
                    AudioContentHelpers.addDefaultWarpMarkers(boxGraph, pitchBox, box.duration.getValue(), fileDuration)
                    box.timeBase.setValue(TimeBase.Musical)
                    box.playMode.refer(pitchBox)
                    box.playback.setValue("")
                    boxGraph.endTransaction()
                }
            },
            visitTimelineBox: (timelineBox: TimelineBox): void => {
                if (timelineBox.tempoTrack.events.isEmpty()) {
                    console.debug("Migrate 'TimelineBox' to have a ValueEventCollectionBox for tempo events")
                    boxGraph.beginTransaction()
                    ValueEventCollectionBox.create(boxGraph, UUID.generate(),
                        box => timelineBox.tempoTrack.events.refer(box.owners))
                    boxGraph.endTransaction()
                }
            },
            visitMIDIOutputDeviceBox: (deviceBox: MIDIOutputDeviceBox): void => {
                const id = deviceBox.deprecatedDevice.id.getValue()
                const label = deviceBox.deprecatedDevice.label.getValue()
                const delay = deviceBox.deprecatedDelay.getValue()
                if (id !== "") {
                    console.debug("Migrate 'MIDIOutputDeviceBox' to MIDIOutputBox")
                    boxGraph.beginTransaction()
                    deviceBox.device.refer(
                        MIDIOutputBox.create(boxGraph, UUID.generate(), box => {
                            box.id.setValue(id)
                            box.label.setValue(label)
                            box.delayInMs.setValue(delay)
                            box.root.refer(rootBox.outputMidiDevices)
                        }).device
                    )
                    // clear all data
                    deviceBox.deprecatedDevice.id.setValue("")
                    deviceBox.deprecatedDevice.label.setValue("")
                    boxGraph.endTransaction()
                }
            },
            visitZeitgeistDeviceBox: (box: ZeitgeistDeviceBox) => {
                if (box.groove.targetAddress.isEmpty()) {
                    console.debug("Migrate 'ZeitgeistDeviceBox' to GrooveShuffleBox")
                    boxGraph.beginTransaction()
                    box.groove.refer(rootBox.groove.targetVertex.unwrap())
                    boxGraph.endTransaction()
                }
            },
            visitValueEventBox: (eventBox: ValueEventBox) => {
                const slope = eventBox.slope.getValue()
                if (isNaN(slope)) {return} // already migrated, nothing to do
                if (slope === 0.0) { // never set
                    console.debug("Migrate 'ValueEventBox'")
                    boxGraph.beginTransaction()
                    eventBox.slope.setValue(NaN)
                    boxGraph.endTransaction()
                } else if (eventBox.interpolation.getValue() === 1) { // linear
                    if (slope === 0.5) {
                        console.debug("Migrate 'ValueEventBox' to linear")
                        boxGraph.beginTransaction()
                        eventBox.slope.setValue(NaN)
                        boxGraph.endTransaction()
                    } else {
                        console.debug("Migrate 'ValueEventBox' to new ValueEventCurveBox")
                        boxGraph.beginTransaction()
                        ValueEventCurveBox.create(boxGraph, UUID.generate(), box => {
                            box.event.refer(eventBox.interpolation)
                            box.slope.setValue(slope)
                        })
                        eventBox.slope.setValue(NaN)
                        boxGraph.endTransaction()
                    }
                }
            },
            visitAudioUnitBox: (box: AudioUnitBox): void => {
                if (box.type.getValue() !== AudioUnitType.Instrument || box.capture.nonEmpty()) {
                    return
                }
                boxGraph.beginTransaction()
                const captureBox = asDefined(box.input.pointerHub.incoming().at(0)?.box
                    .accept<BoxVisitor<CaptureAudioBox | CaptureMidiBox>>({
                        visitVaporisateurDeviceBox: () => CaptureMidiBox.create(boxGraph, UUID.generate()),
                        visitNanoDeviceBox: () => CaptureMidiBox.create(boxGraph, UUID.generate()),
                        visitPlayfieldDeviceBox: () => CaptureMidiBox.create(boxGraph, UUID.generate()),
                        visitTapeDeviceBox: () => CaptureAudioBox.create(boxGraph, UUID.generate())
                    }))
                box.capture.refer(captureBox)
                boxGraph.endTransaction()
            },
            visitRevampDeviceBox: (box: RevampDeviceBox): void => {
                // Clamp order in RevampDeviceBox to 0-3
                // The older version stored the actual order,
                // but the new version only stores indices, so 4 is not valid anymore
                boxGraph.beginTransaction()
                box.lowPass.order.setValue(clamp(box.lowPass.order.getValue(), 0, 3))
                box.highPass.order.setValue(clamp(box.highPass.order.getValue(), 0, 3))
                boxGraph.endTransaction()
            },
            visitVaporisateurDeviceBox: (box: VaporisateurDeviceBox): void => {
                if (box.version.getValue() === 0) {
                    console.debug("Migrate 'VaporisateurDeviceBox to zero db")
                    boxGraph.beginTransaction()
                    box.volume.setValue(box.volume.getValue() - 15.0)
                    box.version.setValue(1)
                    boxGraph.endTransaction()
                }
                if (box.version.getValue() === 1) {
                    console.debug("Migrate 'VaporisateurDeviceBox to extended osc")
                    boxGraph.beginTransaction()
                    const [oscA, oscB] = box.oscillators.fields()
                    const movePointers = (oldTarget: Field, newTarget: Field) => {
                        oldTarget.pointerHub.incoming().forEach((pointer) => pointer.refer(newTarget))
                    }
                    movePointers(box.waveform, oscA.waveform)
                    movePointers(box.octave, oscA.octave)
                    movePointers(box.tune, oscA.tune)
                    movePointers(box.volume, oscA.volume)
                    oscA.waveform.setValue(box.waveform.getValue())
                    oscA.octave.setValue(box.octave.getValue())
                    oscA.tune.setValue(box.tune.getValue())
                    oscA.volume.setValue(box.volume.getValue())
                    oscB.volume.setValue(Number.NEGATIVE_INFINITY)
                    box.version.setValue(2)
                    boxGraph.endTransaction()
                }
            },
            visitDelayDeviceBox: (box: DelayDeviceBox): void => {
                // Version 0: old descending array (17 values)
                // Version 1: new ascending array with off (21 values)
                if (box.version.getValue() !== 0) {return}
                // Old descending: 1/1, 1/2, 1/3, 1/4, 3/16, 1/6, 1/8, 3/32, 1/12, 1/16, 3/64, 1/24, 1/32, 1/48, 1/64, 1/96, 1/128
                // New ascending: off, 1/128, 1/96, 1/64, 1/48, 1/32, 1/24, 3/64, 1/16, 1/12, 3/32, 1/8, 1/6, 3/16, 1/4, 5/16, 1/3, 3/8, 7/16, 1/2, 1/1
                // Mapping: old[i] fraction -> find the same fraction in the new array
                const oldToNewIndex = [20, 19, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
                const oldMaxIndex = 16
                const newMaxIndex = 20
                const oldIndex = box.delay.getValue()
                const newIndex = oldToNewIndex[Math.round(clamp(oldIndex, 0, oldMaxIndex))]
                console.debug(`Migrate 'DelayDeviceBox' delay index from ${oldIndex} to ${newIndex}`)
                boxGraph.beginTransaction()
                box.delay.setValue(newIndex)
                box.version.setValue(1)
                // Migrate automation events targeting the delay field
                // Automation stores normalized values in [0, 1] range
                box.delay.pointerHub.incoming().forEach(pointer => {
                    const eventBox = pointer.box.accept<BoxVisitor<ValueEventBox>>({
                        visitValueEventBox: (event) => event
                    })
                    if (isDefined(eventBox)) {
                        const oldNormalized = eventBox.value.getValue()
                        const oldEventIndex = Math.round(oldNormalized * oldMaxIndex)
                        const newEventIndex = oldToNewIndex[clamp(oldEventIndex, 0, oldMaxIndex)]
                        const newNormalized = newEventIndex / newMaxIndex
                        console.debug(`  Migrate automation: ${oldNormalized.toFixed(4)} (idx ${oldEventIndex}) -> ${newNormalized.toFixed(4)} (idx ${newEventIndex})`)
                        eventBox.value.setValue(newNormalized)
                    }
                })
                boxGraph.endTransaction()
            }
        }))
    }
}
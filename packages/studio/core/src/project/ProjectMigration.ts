import {
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioUnitBox,
    BoxVisitor,
    CaptureAudioBox,
    CaptureMidiBox,
    GrooveShuffleBox,
    MIDIOutputBox,
    MIDIOutputDeviceBox,
    RevampDeviceBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueEventCurveBox,
    VaporisateurDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {asDefined, asInstanceOf, clamp, Float, UUID, ValueOwner} from "@opendaw/lib-std"
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
            const subscription = loader.subscribe(state => {
                if (state.type === "loaded") {
                    subscription.terminate()
                    resolve(loader.data.unwrap("State mismatch"))
                } else if (state.type === "error") {
                    subscription.terminate()
                    reject(state.reason)
                }
            })
            return promise
        }

        // 1st pass (2nd pass might rely on those changes)
        for (const box of boxGraph.boxes()) {
            await box.accept<BoxVisitor<Promise<unknown>>>({
                visitAudioFileBox: async (box: AudioFileBox) => {
                    const {startInSeconds, endInSeconds} = box
                    if (isIntEncodedAsFloat(startInSeconds.getValue()) || isIntEncodedAsFloat(endInSeconds.getValue())) {
                        const audioData = await loadAudioData(box.address.uuid)
                        const seconds = audioData.numberOfFrames / audioData.sampleRate
                        console.debug("Migrate 'AudioFileBox' to float sec", seconds.toFixed(3))
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
            }
        }))
    }
}
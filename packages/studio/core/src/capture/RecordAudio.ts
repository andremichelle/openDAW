import {int, Option, quantizeFloor, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {dbToGain, ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    TrackBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ColorCodes, SampleLoaderManager, TrackType} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RecordingWorklet} from "../RecordingWorklet"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"

export namespace RecordAudio {
    type RecordAudioContext = {
        recordingWorklet: RecordingWorklet
        mediaStream: MediaStream
        sampleManager: SampleLoaderManager
        audioContext: AudioContext
        project: Project
        capture: Capture
        gainDb: number
    }

    export const start = (
        {recordingWorklet, mediaStream, sampleManager, audioContext, project, capture, gainDb}: RecordAudioContext)
        : Terminable => {
        const terminator = new Terminator()
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, engine, boxGraph} = project
        const trackBox: TrackBox = RecordTrack.findOrCreate(editing, capture.audioUnitBox, TrackType.Audio)
        const uuid = recordingWorklet.uuid
        sampleManager.record(recordingWorklet)
        const streamSource = audioContext.createMediaStreamSource(mediaStream)
        const streamGain = audioContext.createGain()
        streamGain.gain.value = dbToGain(gainDb)
        streamSource.connect(streamGain)
        recordingWorklet.own(Terminable.create(() => {
            streamGain.disconnect()
            streamSource.disconnect()
        }))
        let recordingData: Option<{
            fileBox: AudioFileBox,
            regionBox: AudioRegionBox,
            warpMarkerBox: WarpMarkerBox
        }> = Option.None
        const createRecordingData = (position: ppqn) => editing.modify(() => {
            const fileDateString = new Date()
                .toISOString()
                .replaceAll("T", "-")
                .replaceAll(".", "-")
                .replaceAll(":", "-")
                .replaceAll("Z", "")
            const fileName = `Recording-${fileDateString}`
            const fileBox = AudioFileBox.create(boxGraph, uuid, box => box.fileName.setValue(fileName))
            const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            const stretchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
            WarpMarkerBox.create(boxGraph, UUID.generate(),
                box => box.owner.refer(stretchBox.warpMarkers))
            const warpMarkerBox = WarpMarkerBox.create(boxGraph, UUID.generate(),
                box => box.owner.refer(stretchBox.warpMarkers))
            const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.file.refer(fileBox)
                box.events.refer(collectionBox.owners)
                box.regions.refer(trackBox.regions)
                box.position.setValue(position)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Audio))
                box.timeBase.setValue(TimeBase.Musical)
                box.label.setValue("Recording")
                box.playMode.refer(stretchBox)
            })
            project.selection.select(regionBox)
            return {fileBox, regionBox, warpMarkerBox}
        })
        const {tempoMap, env: {audioContext: {sampleRate}}} = project
        terminator.ownAll(
            Terminable.create(() => {
                if (recordingWorklet.numberOfFrames === 0 || recordingData.isEmpty()) {
                    console.debug("Abort recording audio.")
                    sampleManager.remove(uuid)
                    recordingWorklet.terminate()
                } else {
                    const {regionBox: {duration}, fileBox} = recordingData.unwrap("No recording data available")
                    recordingWorklet.limit(Math.ceil(tempoMap.intervalToSeconds(0, duration.getValue()) * sampleRate))
                    fileBox.endInSeconds.setValue(recordingWorklet.numberOfFrames / sampleRate)
                }
            }),
            engine.position.catchupAndSubscribe(owner => {
                if (!engine.isRecording.getValue()) {return}
                if (recordingData.isEmpty()) {
                    streamGain.connect(recordingWorklet)
                    recordingData = createRecordingData(quantizeFloor(owner.getValue(), beats))
                }
                const {regionBox, warpMarkerBox} = recordingData.unwrap()
                editing.modify(() => {
                    if (regionBox.isAttached()) {
                        const {duration, loopDuration} = regionBox
                        const distanceInPPQN = Math.floor(engine.position.getValue() - regionBox.position.getValue())
                        duration.setValue(distanceInPPQN)
                        loopDuration.setValue(distanceInPPQN)
                        warpMarkerBox.position.setValue(distanceInPPQN)
                        const seconds = tempoMap.intervalToSeconds(0, distanceInPPQN)
                        const totalSamples: int = Math.ceil(seconds * sampleRate)
                        recordingWorklet.setFillLength(totalSamples)
                        warpMarkerBox.seconds.setValue(seconds)
                    } else {
                        terminator.terminate()
                        recordingData = Option.None
                    }
                }, false)
            })
        )
        return terminator
    }
}
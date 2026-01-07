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
        outputLatency: number
    }

    type TakeData = {
        trackBox: TrackBox
        regionBox: AudioRegionBox
        warpMarkerBox: WarpMarkerBox
    }

    export const start = (
        {
            recordingWorklet,
            mediaStream,
            sampleManager,
            audioContext,
            project,
            capture,
            gainDb,
            outputLatency
        }: RecordAudioContext)
        : Terminable => {
        const terminator = new Terminator()
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, engine, boxGraph, timelineBox} = project
        const originalUuid = recordingWorklet.uuid
        sampleManager.record(recordingWorklet)
        const streamSource = audioContext.createMediaStreamSource(mediaStream)
        const streamGain = audioContext.createGain()
        streamGain.gain.value = dbToGain(gainDb)
        streamSource.connect(streamGain)
        recordingWorklet.own(Terminable.create(() => {
            streamGain.disconnect()
            streamSource.disconnect()
        }))

        let fileBox: Option<AudioFileBox> = Option.None
        let currentTake: Option<TakeData> = Option.None
        let lastPosition: ppqn = 0
        let currentWaveformOffset: number = outputLatency
        let takeNumber: int = 0

        const {tempoMap, env: {audioContext: {sampleRate}}} = project
        const {loopArea} = timelineBox

        const createFileBox = () => {
            const fileDateString = new Date()
                .toISOString()
                .replaceAll("T", "-")
                .replaceAll(".", "-")
                .replaceAll(":", "-")
                .replaceAll("Z", "")
            const fileName = `Recording-${fileDateString}`
            return AudioFileBox.create(boxGraph, originalUuid, box => box.fileName.setValue(fileName))
        }

        const createTakeRegion = (position: ppqn, waveformOffset: number, forceNewTrack: boolean): TakeData => {
            takeNumber++
            const trackBox = RecordTrack.findOrCreate(editing, capture.audioUnitBox, TrackType.Audio, forceNewTrack)
            const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            const stretchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
            WarpMarkerBox.create(boxGraph, UUID.generate(),
                box => box.owner.refer(stretchBox.warpMarkers))
            const warpMarkerBox = WarpMarkerBox.create(boxGraph, UUID.generate(),
                box => box.owner.refer(stretchBox.warpMarkers))
            const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.file.refer(fileBox.unwrap())
                box.events.refer(collectionBox.owners)
                box.regions.refer(trackBox.regions)
                box.position.setValue(position)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Audio))
                box.timeBase.setValue(TimeBase.Musical)
                box.label.setValue(`Take ${takeNumber}`)
                box.playMode.refer(stretchBox)
                box.waveformOffset.setValue(waveformOffset)
            })
            capture.addRecordedRegion(regionBox)
            project.selection.select(regionBox)
            return {trackBox, regionBox, warpMarkerBox}
        }

        const finalizeTake = (take: TakeData, loopDurationPPQN: ppqn) => {
            const {trackBox, regionBox, warpMarkerBox} = take
            if (regionBox.isAttached()) {
                regionBox.duration.setValue(loopDurationPPQN)
                regionBox.loopDuration.setValue(loopDurationPPQN)
                const seconds = tempoMap.intervalToSeconds(0, loopDurationPPQN)
                warpMarkerBox.position.setValue(loopDurationPPQN)
                warpMarkerBox.seconds.setValue(seconds)
            }
            if (trackBox.isAttached()) {
                trackBox.enabled.setValue(false)
            }
        }

        const startNewTake = (position: ppqn) => {
            currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, true))
        }

        terminator.ownAll(
            Terminable.create(() => {
                if (recordingWorklet.numberOfFrames === 0 || fileBox.isEmpty()) {
                    console.debug("Abort recording audio.")
                    sampleManager.remove(originalUuid)
                    recordingWorklet.terminate()
                } else {
                    currentTake.ifSome(({regionBox: {duration}}) => {
                        recordingWorklet.limit(Math.ceil(
                            (currentWaveformOffset + tempoMap.intervalToSeconds(0, duration.getValue())) * sampleRate))
                    })
                    fileBox.ifSome(fb => fb.endInSeconds.setValue(recordingWorklet.numberOfFrames / sampleRate))
                }
            }),
            engine.position.catchupAndSubscribe(owner => {
                if (!engine.isRecording.getValue()) {return}
                const currentPosition = owner.getValue()
                const loopEnabled = loopArea.enabled.getValue()
                const loopFrom = loopArea.from.getValue()
                const loopTo = loopArea.to.getValue()
                const loopDurationPPQN = loopTo - loopFrom
                const loopDurationSeconds = tempoMap.intervalToSeconds(loopFrom, loopTo)
                if (loopEnabled && currentTake.nonEmpty() && currentPosition < lastPosition) {
                    editing.modify(() => {
                        currentTake.ifSome(take => finalizeTake(take, loopDurationPPQN))
                        currentWaveformOffset += loopDurationSeconds
                        startNewTake(loopFrom)
                    }, false)
                }
                lastPosition = currentPosition
                if (fileBox.isEmpty()) {
                    streamGain.connect(recordingWorklet)
                    editing.modify(() => {
                        fileBox = Option.wrap(createFileBox())
                        const position = quantizeFloor(currentPosition, beats)
                        currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, false))
                    }, false)
                }
                currentTake.ifSome(({regionBox, warpMarkerBox}) => {
                    editing.modify(() => {
                        if (regionBox.isAttached()) {
                            const {duration, loopDuration} = regionBox
                            const maxDuration = loopEnabled ? loopTo - regionBox.position.getValue() : Infinity
                            const distanceInPPQN = Math.min(maxDuration, Math.floor(currentPosition - regionBox.position.getValue()))
                            duration.setValue(distanceInPPQN)
                            loopDuration.setValue(distanceInPPQN)
                            warpMarkerBox.position.setValue(distanceInPPQN)
                            const seconds = tempoMap.intervalToSeconds(0, distanceInPPQN)
                            const totalSamples: int = Math.ceil((currentWaveformOffset + seconds) * sampleRate)
                            recordingWorklet.setFillLength(totalSamples)
                            fileBox.ifSome(fb => fb.endInSeconds.setValue(totalSamples / sampleRate))
                            warpMarkerBox.seconds.setValue(seconds)
                        } else {
                            terminator.terminate()
                            currentTake = Option.None
                        }
                    }, false)
                })
            })
        )
        return terminator
    }
}
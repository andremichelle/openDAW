import {int, Option, Progress, quantizeFloor, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {AudioData, BPMTools, dbToGain, ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {SamplePeaks} from "@opendaw/lib-fusion"
import {
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    TrackBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ColorCodes, SampleLoaderManager, SampleMetaData, TrackType} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RecordingWorklet} from "../RecordingWorklet"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"
import {SampleStorage} from "../samples"
import {Workers} from "../Workers"

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
        waveformOffsetAtCreation: number
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
        const allTakes: Array<TakeData> = []
        let lastPosition: ppqn = 0
        let currentWaveformOffset: number = outputLatency

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
                box.label.setValue("Recording")
                box.playMode.refer(stretchBox)
                box.waveformOffset.setValue(waveformOffset)
            })
            capture.addRecordedRegion(regionBox)
            project.selection.select(regionBox)
            const take: TakeData = {trackBox, regionBox, warpMarkerBox, waveformOffsetAtCreation: waveformOffset}
            allTakes.push(take)
            return take
        }

        const finalizeTake = (take: TakeData, loopDurationPPQN: ppqn) => {
            const {regionBox, warpMarkerBox} = take
            if (regionBox.isAttached()) {
                regionBox.duration.setValue(loopDurationPPQN)
                regionBox.loopDuration.setValue(loopDurationPPQN)
                regionBox.mute.setValue(true)
                const seconds = tempoMap.intervalToSeconds(0, loopDurationPPQN)
                warpMarkerBox.position.setValue(loopDurationPPQN)
                warpMarkerBox.seconds.setValue(seconds)
            }
        }

        const startNewTake = (position: ppqn) => {
            currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, true))
        }

        const splitTakes = async (fullAudio: AudioData) => {
            const {sampleRate: sr, numberOfChannels} = fullAudio
            const takeData: Array<{
                take: TakeData,
                takeUuid: UUID.Bytes,
                segmentLength: number,
                durationSeconds: number
            }> = []
            for (let i = 0; i < allTakes.length; i++) {
                const take = allTakes[i]
                const {regionBox, waveformOffsetAtCreation} = take
                if (!regionBox.isAttached()) {continue}
                const duration = regionBox.duration.getValue()
                const durationSeconds = tempoMap.intervalToSeconds(0, duration)
                const segmentStartSamples = Math.floor(waveformOffsetAtCreation * sr)
                const segmentEndSamples = Math.floor((waveformOffsetAtCreation + durationSeconds) * sr)
                const segmentLength = segmentEndSamples - segmentStartSamples
                if (segmentLength <= 0) {continue}
                const segmentAudio = AudioData.create(sr, segmentLength, numberOfChannels)
                for (let ch = 0; ch < numberOfChannels; ch++) {
                    const sourceFrame = fullAudio.frames[ch]
                    const targetFrame = segmentAudio.frames[ch]
                    for (let s = 0; s < segmentLength; s++) {
                        targetFrame[s] = sourceFrame[segmentStartSamples + s] ?? 0
                    }
                }
                const shifts = SamplePeaks.findBestFit(segmentLength)
                const peaks = await Workers.Peak.generateAsync(
                    Progress.Empty, shifts, segmentAudio.frames, segmentLength, numberOfChannels)
                const takeUuid = UUID.generate()
                const bpm = BPMTools.detect(segmentAudio.frames[0], sr)
                const meta: SampleMetaData = {
                    name: `Recording Take ${i + 1}`,
                    bpm,
                    sample_rate: sr,
                    duration: segmentLength / sr,
                    origin: "recording"
                }
                await SampleStorage.get().save({uuid: takeUuid, audio: segmentAudio, peaks: peaks as ArrayBuffer, meta})
                takeData.push({take, takeUuid, segmentLength, durationSeconds})
            }
            editing.modify(() => {
                for (let i = 0; i < takeData.length; i++) {
                    const {take, takeUuid, segmentLength, durationSeconds} = takeData[i]
                    const {regionBox, warpMarkerBox} = take
                    const newFileBox = AudioFileBox.create(boxGraph, takeUuid, box => {
                        box.fileName.setValue(`Recording-Take-${i + 1}`)
                        box.endInSeconds.setValue(segmentLength / sr)
                    })
                    regionBox.file.refer(newFileBox)
                    regionBox.waveformOffset.setValue(outputLatency)
                    warpMarkerBox.seconds.setValue(durationSeconds)
                }
                fileBox.ifSome(fb => fb.delete())
            }, false)
            sampleManager.remove(originalUuid)
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
                    if (allTakes.length > 1) {
                        recordingWorklet.subscribe(state => {
                            if (state.type === "loaded") {
                                recordingWorklet.data.ifSome(fullAudio => {
                                    splitTakes(fullAudio).catch(err => console.warn("Failed to split takes:", err))
                                })
                            }
                        })
                    }
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
                            const distanceInPPQN = Math.floor(currentPosition - regionBox.position.getValue())
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
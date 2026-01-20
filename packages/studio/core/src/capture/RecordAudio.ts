import {asInstanceOf, int, Option, quantizeFloor, Terminable, Terminator, tryCatch, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ColorCodes, SampleLoaderManager, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RecordingWorklet} from "../RecordingWorklet"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"

export namespace RecordAudio {
    type RecordAudioContext = {
        recordingWorklet: RecordingWorklet
        sourceNode: AudioNode
        sampleManager: SampleLoaderManager
        project: Project
        capture: Capture
        outputLatency: number
    }

    type TakeData = {
        trackBox: TrackBox
        regionBox: AudioRegionBox
    }

    export const start = (
        {recordingWorklet, sourceNode, sampleManager, project, capture, outputLatency}: RecordAudioContext)
        : Terminable => {
        const terminator = new Terminator()
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, engine, boxGraph, timelineBox} = project
        const originalUuid = recordingWorklet.uuid
        sampleManager.record(recordingWorklet)
        let fileBox: Option<AudioFileBox> = Option.None
        let currentTake: Option<TakeData> = Option.None
        let lastPosition: ppqn = 0
        let currentWaveformOffset: number = outputLatency
        let takeNumber: int = 0

        const {env: {audioContext: {sampleRate}}, engine: {preferences: {settings: {recording}}}} = project
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
            const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.file.refer(fileBox.unwrap())
                box.events.refer(collectionBox.owners)
                box.regions.refer(trackBox.regions)
                box.position.setValue(position)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Audio))
                box.timeBase.setValue(TimeBase.Seconds)
                box.label.setValue(`Take ${takeNumber}`)
                box.waveformOffset.setValue(waveformOffset)
            })
            capture.addRecordedRegion(regionBox)
            project.selection.select(regionBox)
            return {trackBox, regionBox}
        }

        const finalizeTake = (take: TakeData, durationInSeconds: number) => {
            const {trackBox, regionBox} = take
            if (regionBox.isAttached()) {
                regionBox.duration.setValue(durationInSeconds)
                regionBox.loopDuration.setValue(durationInSeconds)
            }
            const {olderTakeAction, olderTakeScope} = recording
            if (olderTakeScope === "all") {
                for (const track of capture.audioUnitBox.tracks.pointerHub.incoming()
                    .map(({box}) => asInstanceOf(box, TrackBox))) {
                    const trackType = track.type.getValue()
                    if (trackType === TrackType.Value || trackType === TrackType.Undefined) {continue}
                    if (track === trackBox) {continue}
                    if (olderTakeAction === "disable-track") {
                        if (track.isAttached()) {
                            track.enabled.setValue(false)
                        }
                    } else {
                        for (const region of track.regions.pointerHub.incoming()
                            .map(({box}) => UnionBoxTypes.asRegionBox(box))) {
                            if (region.isAttached()) {
                                region.mute.setValue(true)
                            }
                        }
                    }
                }
            } else {
                if (olderTakeAction === "disable-track") {
                    if (trackBox.isAttached()) {
                        trackBox.enabled.setValue(false)
                    }
                } else {
                    if (regionBox.isAttached()) {
                        regionBox.mute.setValue(true)
                    }
                }
            }
        }

        const startNewTake = (position: ppqn) => {
            currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, true))
        }

        terminator.ownAll(
            Terminable.create(() => {
                tryCatch(() => sourceNode.disconnect(recordingWorklet))
                if (recordingWorklet.numberOfFrames === 0 || fileBox.isEmpty()) {
                    console.debug("Abort recording audio.")
                    sampleManager.remove(originalUuid)
                    recordingWorklet.terminate()
                } else {
                    currentTake.ifSome(({regionBox: {duration}}) => {
                        recordingWorklet.limit(Math.ceil((currentWaveformOffset + duration.getValue()) * sampleRate))
                    })
                    fileBox.ifSome(fb => fb.endInSeconds.setValue(recordingWorklet.numberOfFrames / sampleRate))
                }
            }),
            engine.position.catchupAndSubscribe(owner => {
                if (!engine.isRecording.getValue()) {return}
                const currentPosition = owner.getValue()
                const loopEnabled = loopArea.enabled.getValue()
                const loopFrom = loopArea.from.getValue()
                const allowTakes = project.engine.preferences.settings.recording.allowTakes
                if (loopEnabled && allowTakes && currentTake.nonEmpty() && currentPosition < lastPosition) {
                    editing.modify(() => {
                        currentTake.ifSome(take => {
                            const actualDurationInSeconds = take.regionBox.duration.getValue()
                            finalizeTake(take, actualDurationInSeconds)
                            currentWaveformOffset += actualDurationInSeconds
                        })
                        startNewTake(loopFrom)
                    }, false)
                }
                lastPosition = currentPosition
                if (fileBox.isEmpty()) {
                    sourceNode.connect(recordingWorklet)
                    editing.modify(() => {
                        fileBox = Option.wrap(createFileBox())
                        const position = quantizeFloor(currentPosition, beats)
                        currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, false))
                    }, false)
                }
                currentTake.ifSome(({regionBox}) => {
                    editing.modify(() => {
                        if (regionBox.isAttached()) {
                            const {duration, loopDuration} = regionBox
                            const totalSeconds = recordingWorklet.numberOfFrames / sampleRate
                            const takeSeconds = totalSeconds - currentWaveformOffset
                            duration.setValue(takeSeconds)
                            loopDuration.setValue(takeSeconds)
                            recordingWorklet.setFillLength(recordingWorklet.numberOfFrames)
                            fileBox.ifSome(fb => fb.endInSeconds.setValue(totalSeconds))
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
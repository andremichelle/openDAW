import {
    asInstanceOf,
    int,
    Nullable,
    Option,
    quantizeFloor,
    Terminable,
    Terminator,
    tryCatch,
    UUID
} from "@moises-ai/lib-std"
import {ppqn, PPQN, TimeBase} from "@moises-ai/lib-dsp"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@moises-ai/studio-boxes"
import {ColorCodes, SampleLoaderManager, TrackType, UnionBoxTypes} from "@moises-ai/studio-adapters"
import {Project} from "../project"
import {RecordingWorklet} from "../RecordingWorklet"
import {Capture} from "./Capture"
import {Recording} from "./Recording"
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
        console.debug("[RecordAudio] start", {outputLatency})
        const terminator = new Terminator()
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, engine, boxGraph, timelineBox} = project
        const originalUuid = recordingWorklet.uuid
        // Note: sampleManager.record() and sourceNode.connect() are called in prepareRecording
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

        const createTakeRegion = (position: ppqn, waveformOffset: number, excludeTrack: Nullable<TrackBox>): TakeData => {
            takeNumber++
            console.debug("[RecordAudio] createTakeRegion", {takeNumber, position, waveformOffset})
            const trackBox = RecordTrack.findOrCreate(editing, capture.audioUnitBox, TrackType.Audio, excludeTrack)
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
            console.debug("[RecordAudio] finalizeTake", {durationInSeconds})
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
            const previousTrack = currentTake.mapOr(take => take.trackBox, null)
            currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, previousTrack))
        }

        recordingWorklet.onSaved = uuid => {
            project.trackUserCreatedSample(uuid)
            fileBox.ifSome(oldFileBox => {
                if (!oldFileBox.isAttached() || oldFileBox.pointerHub.isEmpty()) {return}
                editing.modify(() => {
                    const incomingPointers = [...oldFileBox.pointerHub.incoming()]
                    const incomingTransientPointers = [...oldFileBox.transientMarkers.pointerHub.incoming()]
                    if (incomingPointers.length === 0) {
                        oldFileBox.delete()
                        return
                    }
                    const newFileBox = AudioFileBox.create(boxGraph, uuid, box => {
                        box.fileName.setValue(oldFileBox.fileName.getValue())
                        box.startInSeconds.setValue(oldFileBox.startInSeconds.getValue())
                        box.endInSeconds.setValue(oldFileBox.endInSeconds.getValue())
                    })
                    for (const pointer of incomingPointers) {
                        pointer.refer(newFileBox)
                    }
                    for (const pointer of incomingTransientPointers) {
                        pointer.refer(newFileBox.transientMarkers)
                    }
                    oldFileBox.delete()
                })
            })
        }
        terminator.ownAll(
            Terminable.create(() => {
                tryCatch(() => sourceNode.disconnect(recordingWorklet))
                if (recordingWorklet.numberOfFrames === 0 || fileBox.isEmpty()) {
                    console.debug("[RecordAudio] abort", {
                        numberOfFrames: recordingWorklet.numberOfFrames,
                        hasFile: fileBox.nonEmpty()
                    })
                    sampleManager.remove(originalUuid)
                    recordingWorklet.terminate()
                } else {
                    // fixes #840: short recordings (e.g. count-in) can leave zero-duration regions
                    currentTake.ifSome(({regionBox}) => {
                        const duration = regionBox.duration.getValue()
                        if (duration <= 0) {
                            console.debug("[RecordAudio] stop: deleting zero-duration region", {takeNumber})
                            editing.modify(() => regionBox.delete(), false)
                        } else {
                            console.debug("[RecordAudio] stop", {
                                takeNumber,
                                duration,
                                numberOfFrames: recordingWorklet.numberOfFrames
                            })
                            recordingWorklet.limit(Math.ceil((currentWaveformOffset + duration) * sampleRate))
                        }
                    })
                    fileBox.ifSome(box => {
                        if (box.isAttached()) {
                            box.endInSeconds.setValue(recordingWorklet.numberOfFrames / sampleRate)
                        }
                    })
                }
            }),
            engine.position.catchupAndSubscribe(owner => {
                const isCountingIn = engine.isCountingIn.getValue()
                const isRecording = engine.isRecording.getValue()
                if (!isCountingIn && !isRecording) {return}
                const currentPosition = owner.getValue()
                if (isCountingIn) {return}
                // From here on, isRecording is true
                const loopEnabled = loopArea.enabled.getValue()
                const loopFrom = loopArea.from.getValue()
                const allowTakes = project.engine.preferences.settings.recording.allowTakes
                if (loopEnabled && allowTakes && currentTake.nonEmpty() && currentPosition < lastPosition) {
                    editing.modify(() => {
                        currentTake.ifSome(take => {
                            const actualDurationInSeconds = take.regionBox.duration.getValue()
                            if (actualDurationInSeconds <= 0) {
                                take.regionBox.delete()
                                currentTake = Option.None
                                return
                            }
                            finalizeTake(take, actualDurationInSeconds)
                            currentWaveformOffset += actualDurationInSeconds
                        })
                        if (currentTake.nonEmpty()) {
                            startNewTake(loopFrom)
                        }
                    }, false)
                }
                lastPosition = currentPosition
                // Create fileBox and region together when recording starts
                if (fileBox.isEmpty()) {
                    // Capture all frames recorded before actual recording (including count-in)
                    const preRecordingFrames = recordingWorklet.numberOfFrames
                    const preRecordingSeconds = preRecordingFrames / sampleRate
                    // If there was count-in, use pre-recording frames as offset; otherwise use outputLatency
                    const countedIn = Recording.wasCountingIn()
                    const waveformOffset = countedIn ? preRecordingSeconds : outputLatency
                    editing.modify(() => {
                        fileBox = Option.wrap(createFileBox())
                        const position = countedIn ? quantizeFloor(currentPosition, beats) : currentPosition
                        currentTake = Option.wrap(createTakeRegion(position, waveformOffset, null))
                    }, false)
                    currentWaveformOffset = waveformOffset
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
                            fileBox.ifSome(box => box.endInSeconds.setValue(totalSeconds))
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
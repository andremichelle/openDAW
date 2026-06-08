import {
    asInstanceOf,
    int,
    Nullable,
    Option,
    Terminable,
    Terminator,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ColorCodes, SampleLoaderManager, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"
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
        inputLatency: number
    }

    type TakeData = {
        trackBox: TrackBox
        regionBox: AudioRegionBox
    }

    export const start = (
        {recordingWorklet, sourceNode, sampleManager, project, capture, outputLatency, inputLatency}: RecordAudioContext)
        : Terminable => {
        console.debug("[RecordAudio] start", {outputLatency, inputLatency})
        const terminator = new Terminator()
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, engine, boxGraph, timelineBox, tempoMap} = project
        const originalUuid = recordingWorklet.uuid
        // Note: sampleManager.record() and sourceNode.connect() are called in prepareRecording
        let fileBox: Option<AudioFileBox> = Option.None
        let currentTake: Option<TakeData> = Option.None
        let lastPosition: ppqn = 0
        let currentWaveformOffset: number = outputLatency + inputLatency
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
                box.file.refer(fileBox.unwrap("fileBox"))
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
                // The finalized length is recomputed (loop boundary), so unlike the live update it can be
                // non-positive for a take that started at/after loopTo. Never persist a zero/negative
                // duration region (it later trips validateTrack "duration must be positive") — drop it.
                if (durationInSeconds <= 0) {
                    console.debug("[RecordAudio] finalizeTake: dropping non-positive take", {durationInSeconds})
                    regionBox.delete()
                    return
                }
                regionBox.duration.setValue(durationInSeconds)
                regionBox.loopDuration.setValue(durationInSeconds)
            }
            const {olderTakeAction, olderTakeScope} = recording
            if (olderTakeScope === "none") {return}
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
                    // endInSeconds must reflect the *imported sample's* actual
                    // frame count, not the live `numberOfFrames` snapshot kept
                    // on `oldFileBox`. The worklet's ring buffer can overshoot
                    // the recording `limit` by up to one quantum before
                    // `#finalize` truncates it, so oldFileBox.endInSeconds is
                    // inflated. Copying it would stretch the rendered waveform
                    // by that overshoot, causing a linear visual drift along
                    // the file (audio playback is unaffected).
                    const audioData = recordingWorklet.data.unwrap("Recorded audio data missing")
                    const newFileBox = AudioFileBox.create(boxGraph, uuid, box => {
                        box.fileName.setValue(oldFileBox.fileName.getValue())
                        box.startInSeconds.setValue(0)
                        box.endInSeconds.setValue(audioData.numberOfFrames / audioData.sampleRate)
                    })
                    for (const pointer of incomingPointers) {
                        pointer.refer(newFileBox)
                    }
                    for (const pointer of incomingTransientPointers) {
                        pointer.refer(newFileBox.transientMarkers)
                    }
                    oldFileBox.delete()
                }, false)
            })
            editing.mark()
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
                    // Compute the take's length from its own start position to
                    // loopTo, not from loopFrom. When recording begins mid-loop,
                    // the first take only spans [takePosition, loopTo]; using
                    // the full loop length would overshoot by (takePosition - loopFrom).
                    // Stays deterministic (avoids the latency-lagged live
                    // regionBox.duration that previously caused peak drift):
                    // subsequent takes start at loopFrom, so this evaluates to
                    // the full loop length exactly as before.
                    const loopTo = loopArea.to.getValue()
                    editing.modify(() => {
                        currentTake.ifSome(take => {
                            if (take.regionBox.duration.getValue() <= 0) {
                                take.regionBox.delete()
                                currentTake = Option.None
                                return
                            }
                            const takeDurationSeconds = tempoMap.intervalToSeconds(
                                take.regionBox.position.getValue(), loopTo)
                            finalizeTake(take, takeDurationSeconds)
                            currentWaveformOffset += takeDurationSeconds
                        })
                        if (currentTake.nonEmpty()) {
                            startNewTake(loopFrom)
                        }
                    }, false)
                }
                lastPosition = currentPosition
                // Create fileBox and region together when recording starts.
                if (fileBox.isEmpty()) {
                    // Three terms make up the file_time of audio captured at engine timeline
                    // = currentPosition (mic case):
                    //   L                  — worklet head-start: wall-clock between the worklet
                    //                        being connected (in prepareRecording) and the engine
                    //                        actually beginning count-in. Cannot be derived from
                    //                        BPM/signature alone.
                    //   countInSeconds     — deterministic from bars × signature × bpm.
                    //   outputLatency      — engine→speaker compensation.
                    //   inputLatency       — manual mic→engine compensation (engine preferences,
                    //                        optionally overridden per track in the CaptureAudioBox).
                    // L is recovered once, here, by reading numberOfFrames at the moment we first
                    // see isRecording=true and subtracting the BPM-derived countInSeconds. Earlier
                    // attempts that omitted L put a systematic ~30 ms (one render dispatch) bias
                    // on every take; earlier attempts that used numberOfFrames as the whole offset
                    // were noisy by the same ~few ms but never wildly wrong.
                    const countedIn = Recording.wasCountingIn()
                    const barPPQN = PPQN.fromSignature(
                        timelineBox.signature.nominator.getValue(),
                        timelineBox.signature.denominator.getValue())
                    const countInSeconds = countedIn
                        ? PPQN.pulsesToSeconds(recording.countInBars * barPPQN, timelineBox.bpm.getValue())
                        : 0
                    const wallclockSinceWorklet = recordingWorklet.numberOfFrames / sampleRate
                    const headStartSeconds = countedIn
                        ? Math.max(0, wallclockSinceWorklet - countInSeconds)
                        : wallclockSinceWorklet
                    const waveformOffset = headStartSeconds + countInSeconds + outputLatency + inputLatency
                    editing.modify(() => {
                        fileBox = Option.wrap(createFileBox())
                        currentTake = Option.wrap(createTakeRegion(currentPosition, waveformOffset, null))
                    }, false)
                    currentWaveformOffset = waveformOffset
                }
                currentTake.ifSome(({regionBox}) => editing.modify(() => {
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
                }, false))
            })
        )
        return terminator
    }
}
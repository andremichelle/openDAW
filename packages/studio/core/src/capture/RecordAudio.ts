import {
    int,
    isDefined,
    Nullable,
    Option,
    Provider,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {ppqn, RenderQuantum, TimeBase} from "@opendaw/lib-dsp"
import {Runtime} from "@opendaw/lib-runtime"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ColorCodes, SampleLoaderManager, TrackType, TransportAnchor} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RecordingLatency, RecordingSink} from "../io"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"
import {TakePolicy} from "./TakePolicy"

export namespace RecordAudio {
    export type Latency = RecordingLatency

    type RecordAudioContext = {
        sink: RecordingSink
        sampleManager: SampleLoaderManager
        project: Project
        capture: Capture
        readLatency: Provider<Latency>
    }

    type TakeData = {
        trackBox: TrackBox
        regionBox: AudioRegionBox
    }

    const TAIL_WAIT_SECONDS = 1.0

    export const start = (
        {sink, sampleManager, project, capture, readLatency}: RecordAudioContext)
        : Terminable => {
        const terminator = new Terminator()
        const {editing, engine, boxGraph, timelineBox, tempoMap} = project
        const fileUuid = sink.uuid
        let fileBox: Option<AudioFileBox> = Option.None
        let currentTake: Option<TakeData> = Option.None
        let currentWaveformOffset: number = 0
        let takeNumber: int = RecordTrack.lastTakeNumber(capture.audioUnitBox)
        // added to a context time it gives the time inside the recorded file that was captured for it
        let ringOffset: number = 0
        let isSaved: boolean = false
        const pendingJumps: Array<TransportAnchor> = []

        const {env: {audioContext}, engine: {preferences: {settings: {recording}}}} = project
        const {sampleRate} = audioContext
        const {loopArea} = timelineBox
        const minTakeSeconds = RenderQuantum / sampleRate

        const createFileBox = () => {
            const fileDateString = new Date()
                .toISOString()
                .replaceAll("T", "-")
                .replaceAll(".", "-")
                .replaceAll(":", "-")
                .replaceAll("Z", "")
            const fileName = `Recording-${fileDateString}`
            return AudioFileBox.create(boxGraph, fileUuid, box => box.fileName.setValue(fileName))
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
                box.duration.setValue(minTakeSeconds)
                box.loopDuration.setValue(minTakeSeconds)
            })
            capture.addRecordedRegion(regionBox)
            project.selection.select(regionBox)
            return {trackBox, regionBox}
        }

        const finalizeTake = (take: TakeData, durationInSeconds: number) => {
            console.debug("[RecordAudio] finalizeTake", {durationInSeconds})
            const {regionBox} = take
            if (regionBox.isAttached()) {
                // a take that ends before its audio begins would trip validateTrack later: drop it
                if (durationInSeconds <= 0) {
                    console.debug("[RecordAudio] finalizeTake: dropping non-positive take", {durationInSeconds})
                    regionBox.delete()
                    return
                }
                regionBox.duration.setValue(durationInSeconds)
                regionBox.loopDuration.setValue(durationInSeconds)
            }
            TakePolicy.applyOlderTakeAction(recording, capture.audioUnitBox, take)
        }

        const startNewTake = (position: ppqn) => {
            const previousTrack = currentTake.mapOr(take => take.trackBox, null)
            currentTake = Option.wrap(createTakeRegion(position, currentWaveformOffset, previousTrack))
        }

        const placeFirstTake = (): void => {
            if (fileBox.nonEmpty()) {return}
            const recordingStart = engine.recordingStart
            const firstQuantumTime = sink.firstQuantumTime
            if (recordingStart.isEmpty() || firstQuantumTime.isEmpty()) {return}
            const {contextTime, position} = recordingStart.unwrap()
            const {outputLatency, inputLatency} = readLatency()
            console.debug(`[RecordAudio] outputLatency=${outputLatency} inputLatency=${inputLatency}`)
            ringOffset = outputLatency + inputLatency + engine.compensationLatency.getValue() - firstQuantumTime.unwrap()
            const startOffset = contextTime + ringOffset
            // region position is an integer field: the fraction moves into the offset
            let takePosition = Math.floor(position)
            let waveformOffset = startOffset - tempoMap.intervalToSeconds(takePosition, position)
            // the first captured frame postdates the start: begin at the first position the audio covers
            if (waveformOffset < 0) {
                const startSeconds = tempoMap.ppqnToSeconds(takePosition)
                const coveredFrom = takePosition
                    + tempoMap.intervalToPPQN(startSeconds, startSeconds - waveformOffset)
                takePosition = Math.ceil(coveredFrom)
                waveformOffset = tempoMap.intervalToSeconds(coveredFrom, takePosition)
            }
            console.debug(`[RecordAudio] anchored: contextTime=${contextTime} position=${position} `
                + `firstQuantumTime=${firstQuantumTime.unwrap()} takePosition=${takePosition} `
                + `waveformOffset=${waveformOffset}`)
            editing.modify(() => {
                fileBox = Option.wrap(createFileBox())
                currentTake = Option.wrap(createTakeRegion(takePosition, waveformOffset, null))
            }, false)
            currentWaveformOffset = waveformOffset
        }

        // a take ends where the engine wrapped, so its length is what the engine rendered
        const splitTakes = (): void => {
            while (currentTake.nonEmpty()) {
                const jump = pendingJumps.shift()
                if (!isDefined(jump)) {return}
                if (!loopArea.enabled.getValue() || !recording.allowTakes) {continue}
                // a seek flags the first block of the quantum the recording starts in
                if (engine.recordingStart.mapOr(({contextTime}) => jump.contextTime <= contextTime, true)) {continue}
                editing.modify(() => {
                    currentTake.ifSome(take => {
                        const takeDurationSeconds = jump.contextTime + ringOffset - currentWaveformOffset
                        if (takeDurationSeconds <= 0) {
                            take.regionBox.delete()
                            currentTake = Option.None
                            return
                        }
                        finalizeTake(take, takeDurationSeconds)
                        currentWaveformOffset += takeDurationSeconds
                    })
                    if (currentTake.nonEmpty()) {
                        startNewTake(jump.position)
                    }
                }, false)
            }
        }

        const pump = (): void => {
            placeFirstTake()
            splitTakes()
        }

        const resizeTake = (totalSeconds: number) => currentTake.ifSome(({regionBox}) => {
            if (!regionBox.isAttached()) {return}
            const takeSeconds = totalSeconds - currentWaveformOffset
            if (takeSeconds <= 0) {
                console.debug("[RecordAudio] stop: deleting zero-duration region", {takeNumber})
                editing.modify(() => regionBox.delete(), false)
                currentTake = Option.None
            } else {
                editing.modify(() => {
                    regionBox.duration.setValue(takeSeconds)
                    regionBox.loopDuration.setValue(takeSeconds)
                }, false)
            }
        })
        // a stop before this recording's start is an earlier recording's: the engine still records
        const stopFrames = (deliveredFrames: int): int => {
            const stopped = engine.recordingStop.flatMap(stop => engine.recordingStart
                .flatMap(({contextTime}) => stop.contextTime >= contextTime ? Option.wrap(stop) : Option.None))
            return stopped.mapOr(({contextTime}) =>
                Math.max(0, Math.round((contextTime + ringOffset) * sampleRate)), deliveredFrames)
        }
        sink.onSaved = () => {
            isSaved = true
            sink.disconnect()
            project.trackUserCreatedSample(fileUuid)
            editing.mark()
        }
        terminator.ownAll(
            Terminable.create(() => {
                const deliveredFrames = sink.numberOfFrames
                const numberOfFrames = stopFrames(deliveredFrames)
                const totalSeconds = numberOfFrames / sampleRate
                // fixes #840: short recordings (e.g. count-in) can leave zero-duration regions
                resizeTake(totalSeconds)
                const hasTakes = fileBox.mapOr(box => box.isAttached() && !box.pointerHub.isEmpty(), false)
                if (numberOfFrames === 0 || !hasTakes) {
                    console.debug("[RecordAudio] abort", {numberOfFrames, hasTakes})
                    sink.disconnect()
                    sampleManager.remove(fileUuid)
                    sink.terminate()
                    fileBox.ifSome(box => {
                        if (box.isAttached()) {editing.modify(() => box.delete(), false)}
                    })
                } else {
                    console.debug("[RecordAudio] stop", {takeNumber, totalSeconds, numberOfFrames, deliveredFrames})
                    const setEnd = (seconds: number) => fileBox.ifSome(box => {
                        if (box.isAttached()) {editing.modify(() => box.endInSeconds.setValue(seconds), false)}
                    })
                    // the source stays connected until the input still in flight at the stop has arrived
                    sink.limit(numberOfFrames)
                    setEnd(totalSeconds)
                    if (deliveredFrames < numberOfFrames) {
                        const waitMillis = ((numberOfFrames - deliveredFrames) / sampleRate + TAIL_WAIT_SECONDS) * 1000
                        Runtime.scheduleTimeout(() => {
                            if (isSaved) {return}
                            const arrivedFrames = sink.numberOfFrames
                            if (arrivedFrames >= numberOfFrames) {return}
                            console.warn("[RecordAudio] input tail never arrived", {numberOfFrames, arrivedFrames})
                            resizeTake(arrivedFrames / sampleRate)
                            setEnd(arrivedFrames / sampleRate)
                            sink.limit(arrivedFrames)
                        }, waitMillis)
                    }
                }
            }),
            engine.subscribeTransportAnchors(anchors => {
                for (const anchor of anchors) {
                    if (anchor.kind === "jump" && anchor.recording) {pendingJumps.push(anchor)}
                }
                pump()
            }),
            engine.recordingStart.subscribe(() => pump()),
            engine.position.catchupAndSubscribe(() => {
                if (!engine.isRecording.getValue()) {return}
                pump()
                currentTake.ifSome(({regionBox}) => editing.modify(() => {
                    if (regionBox.isAttached()) {
                        const {duration, loopDuration} = regionBox
                        const totalSeconds = sink.numberOfFrames / sampleRate
                        const takeSeconds = Math.max(minTakeSeconds, totalSeconds - currentWaveformOffset)
                        duration.setValue(takeSeconds)
                        loopDuration.setValue(takeSeconds)
                        sink.setFillLength(sink.numberOfFrames)
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
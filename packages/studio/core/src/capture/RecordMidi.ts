import {
    asInstanceOf,
    byte,
    int,
    isDefined,
    Notifier,
    Nullable,
    Option,
    quantizeCeil,
    quantizeFloor,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ColorCodes, NoteSignal, TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"

export namespace RecordMidi {
    type RecordMidiContext = {
        notifier: Notifier<NoteSignal>,
        project: Project,
        capture: Capture
    }

    type TakeData = {
        trackBox: TrackBox
        regionBox: NoteRegionBox
        collection: NoteEventCollectionBox
    }

    type ActiveNote = {
        event: NoteEventBox
        take: TakeData
        creationOffset: ppqn
    }

    const MIN_NOTE_DURATION = PPQN.fromSignature(1, 128)

    export const start = ({notifier, project, capture}: RecordMidiContext): Terminable => {
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, boxGraph, engine, env: {audioContext}, timelineBox} = project
        const {position, isRecording, preferences: {settings: {recording}}} = engine
        const {loopArea} = timelineBox
        const terminator = new Terminator()
        const activeNotes = new Map<byte, ActiveNote>()
        const pendingNotes = new Map<byte, byte>()
        const latency = PPQN.secondsToPulses((audioContext.outputLatency ?? 0.01) + engine.compensationLatency.getValue(),
            timelineBox.bpm.getValue()) // 10ms fallback (seconds)
        let currentTake: Option<TakeData> = Option.None
        let lastPosition: ppqn = 0
        let lastPositionTime: number = performance.now()
        let positionOffset: ppqn = 0
        let takeCount: int = RecordTrack.lastTakeNumber(capture.audioUnitBox)

        // engine.position moves only on animation frames: extrapolate it, but not across a loop end the engine wraps at
        const writePositionAt = (timeStamp: number): ppqn => {
            const elapsedSeconds = Math.max(0.0, Math.min(timeStamp, performance.now()) - lastPositionTime) / 1000.0
            const elapsed = PPQN.secondsToPulses(elapsedSeconds, engine.bpm.getValue())
            const loopTo = loopArea.to.getValue()
            const crossesLoopEnd = loopArea.enabled.getValue() && engine.preferences.settings.recording.allowTakes
                && lastPosition < loopTo && lastPosition + elapsed >= loopTo
            return (crossesLoopEnd ? lastPosition : lastPosition + elapsed) + latency
        }

        const writeDuration = ({event, take, creationOffset}: ActiveNote, writePosition: ppqn): void => {
            const elapsed = (positionOffset + writePosition)
                - (creationOffset + take.regionBox.position.getValue() + event.position.getValue())
            event.duration.setValue(Math.max(MIN_NOTE_DURATION, elapsed))
        }

        const takeDuration = (regionPosition: ppqn, writePosition: ppqn): ppqn => {
            const loopTo = loopArea.to.getValue()
            const capped = loopArea.enabled.getValue()
                && engine.preferences.settings.recording.allowTakes && regionPosition < loopTo
            const cap = capped ? loopTo - regionPosition : Infinity
            return Math.min(cap, Math.max(beats, quantizeCeil(writePosition, beats) - regionPosition))
        }

        const growTake = ({position: regionPosition, duration, loopDuration}: NoteRegionBox, writePosition: ppqn) => {
            const newDuration = Math.max(duration.getValue(), takeDuration(regionPosition.getValue(), writePosition))
            duration.setValue(newDuration)
            loopDuration.setValue(newDuration)
        }

        const createTakeRegion = (position: ppqn, writePosition: ppqn, excludeTrack: Nullable<TrackBox>): TakeData => {
            takeCount++
            const trackBox = RecordTrack.findOrCreate(editing, capture.audioUnitBox, TrackType.Notes, excludeTrack)
            const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
            const duration = takeDuration(position, writePosition)
            const regionBox = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                box.regions.refer(trackBox.regions)
                box.events.refer(collection.owners)
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopDuration.setValue(duration)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Notes))
                box.label.setValue(`Take ${takeCount}`)
            })
            capture.addRecordedRegion(regionBox)
            project.selection.select(regionBox)
            engine.ignoreNoteRegion(regionBox.address.uuid)
            return {trackBox, regionBox, collection}
        }

        const finalizeTake = (take: TakeData, loopDurationPPQN: ppqn) => {
            const {trackBox, regionBox} = take
            if (regionBox.isAttached()) {
                regionBox.duration.setValue(loopDurationPPQN)
                regionBox.loopDuration.setValue(loopDurationPPQN)
            }
            const {olderTakeAction, olderTakeScope} = recording
            if (olderTakeScope === "none") {return}
            if (olderTakeScope === "all") {
                for (const track of capture.audioUnitBox.tracks.pointerHub.incoming()
                    .map(({box}) => asInstanceOf(box, TrackBox))) {
                    const trackType = track.type.getValue()
                    if (trackType === TrackType.Value) {continue}
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

        const flushPendingNotes = (take: TakeData) => {
            for (const [pitch, velocity] of pendingNotes) {
                const event = NoteEventBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(0)
                    box.duration.setValue(MIN_NOTE_DURATION)
                    box.pitch.setValue(pitch)
                    box.velocity.setValue(velocity)
                    box.events.refer(take.collection.events)
                })
                activeNotes.set(pitch, {event, take, creationOffset: positionOffset})
            }
            pendingNotes.clear()
        }

        const startNewTake = (position: ppqn, writePosition: ppqn) => {
            const previousTrack = currentTake.mapOr(take => take.trackBox, null)
            currentTake = Option.wrap(createTakeRegion(position, writePosition, previousTrack))
        }

        terminator.own(position.catchupAndSubscribe(owner => {
            if (!isRecording.getValue()) {return}
            const currentPosition = owner.getValue()
            const writePosition = currentPosition + latency
            const loopEnabled = loopArea.enabled.getValue()
            const loopFrom = loopArea.from.getValue()
            const allowTakes = project.engine.preferences.settings.recording.allowTakes
            if (loopEnabled && allowTakes && currentTake.nonEmpty() && currentPosition < lastPosition) {
                editing.modify(() => {
                    currentTake.ifSome(take => {
                        const actualDurationPPQN = take.regionBox.duration.getValue()
                        finalizeTake(take, actualDurationPPQN)
                        positionOffset += actualDurationPPQN
                    })
                    startNewTake(loopFrom, writePosition)
                }, false)
            }
            lastPosition = currentPosition
            lastPositionTime = performance.now()
            if (currentTake.isEmpty()) {
                editing.modify(() => {
                    const pos = quantizeFloor(currentPosition, beats)
                    const take = createTakeRegion(pos, writePosition, null)
                    currentTake = Option.wrap(take)
                    flushPendingNotes(take)
                }, false)
            }
            currentTake.ifSome(({regionBox, collection}) => {
                editing.modify(() => {
                    if (regionBox.isAttached() && collection.isAttached()) {
                        growTake(regionBox, writePosition)
                        for (const note of activeNotes.values()) {
                            if (note.event.isAttached()) {
                                writeDuration(note, writePosition)
                            } else {
                                activeNotes.delete(note.event.pitch.getValue())
                            }
                        }
                    } else {
                        terminator.terminate()
                        currentTake = Option.None
                    }
                }, false)
            })
        }))

        terminator.ownAll(notifier.subscribe((signal: NoteSignal) => {
            const writePosition = writePositionAt((NoteSignal.isAudition(signal) ? undefined : signal.timeStamp) ?? performance.now())
            if (NoteSignal.isOn(signal)) {
                const {pitch, velocity} = signal
                if (currentTake.isEmpty()) {
                    pendingNotes.set(pitch, velocity)
                    return
                }
                const take = currentTake.unwrap()
                const {regionBox, collection} = take
                editing.modify(() => {
                    const notePosition = writePosition - regionBox.position.getValue()
                    if (notePosition < -PPQN.SemiQuaver) {return}
                    growTake(regionBox, writePosition)
                    const event = NoteEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(Math.max(0, notePosition))
                        box.duration.setValue(MIN_NOTE_DURATION)
                        box.pitch.setValue(pitch)
                        box.velocity.setValue(velocity)
                        box.events.refer(collection.events)
                    })
                    activeNotes.set(pitch, {event, take, creationOffset: positionOffset})
                }, false)
            } else if (NoteSignal.isOff(signal)) {
                if (pendingNotes.has(signal.pitch)) {
                    pendingNotes.delete(signal.pitch)
                } else {
                    const note = activeNotes.get(signal.pitch)
                    activeNotes.delete(signal.pitch)
                    if (isDefined(note) && note.event.isAttached()) {
                        editing.modify(() => {
                            writeDuration(note, writePosition)
                            currentTake.ifSome(({regionBox}) => growTake(regionBox, writePosition))
                        }, false)
                    }
                }
            }
        }))
        return terminator
    }
}
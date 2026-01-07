import {byte, Notifier, Option, quantizeCeil, quantizeFloor, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ColorCodes, NoteSignal, TrackType} from "@opendaw/studio-adapters"
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
        const {position, isRecording} = engine
        const {loopArea} = timelineBox
        const terminator = new Terminator()
        const activeNotes = new Map<byte, ActiveNote>()
        const latency = PPQN.secondsToPulses(audioContext.outputLatency ?? 10.0, timelineBox.bpm.getValue())
        let currentTake: Option<TakeData> = Option.None
        let lastPosition: ppqn = 0
        let positionOffset: ppqn = 0

        const createTakeRegion = (position: ppqn, forceNewTrack: boolean): TakeData => {
            const trackBox = RecordTrack.findOrCreate(editing, capture.audioUnitBox, TrackType.Notes, forceNewTrack)
            const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
            const regionBox = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                box.regions.refer(trackBox.regions)
                box.events.refer(collection.owners)
                box.position.setValue(position)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Notes))
            })
            capture.addRecordedRegion(regionBox)
            project.selection.select(regionBox)
            engine.ignoreNoteRegion(regionBox.address.uuid)
            return {trackBox, regionBox, collection}
        }

        const finalizeTake = (take: TakeData, loopDurationPPQN: ppqn) => {
            const {regionBox} = take
            if (regionBox.isAttached()) {
                regionBox.duration.setValue(loopDurationPPQN)
                regionBox.loopDuration.setValue(loopDurationPPQN)
                regionBox.mute.setValue(true)
            }
        }

        const startNewTake = (position: ppqn) => {
            currentTake = Option.wrap(createTakeRegion(position, true))
        }

        terminator.own(position.catchupAndSubscribe(owner => {
            if (!isRecording.getValue()) {return}
            const currentPosition = owner.getValue()
            const writePosition = currentPosition + latency
            const loopEnabled = loopArea.enabled.getValue()
            const loopFrom = loopArea.from.getValue()
            const loopTo = loopArea.to.getValue()
            const loopDurationPPQN = loopTo - loopFrom
            if (loopEnabled && currentTake.nonEmpty() && currentPosition < lastPosition) {
                positionOffset += loopDurationPPQN
                editing.modify(() => {
                    currentTake.ifSome(take => finalizeTake(take, loopDurationPPQN))
                    startNewTake(loopFrom)
                }, false)
            }
            lastPosition = currentPosition
            if (currentTake.isEmpty()) {
                editing.modify(() => {
                    const pos = quantizeFloor(currentPosition, beats)
                    currentTake = Option.wrap(createTakeRegion(pos, false))
                }, false)
            }
            currentTake.ifSome(({regionBox, collection}) => {
                editing.modify(() => {
                    if (regionBox.isAttached() && collection.isAttached()) {
                        const {position: regionPosition, duration, loopDuration} = regionBox
                        const newDuration = quantizeCeil(writePosition, beats) - regionPosition.getValue()
                        duration.setValue(newDuration)
                        loopDuration.setValue(newDuration)
                        for (const {event, take, creationOffset} of activeNotes.values()) {
                            if (event.isAttached()) {
                                const elapsed = (positionOffset + writePosition) - (creationOffset + take.regionBox.position.getValue() + event.position.getValue())
                                event.duration.setValue(Math.max(MIN_NOTE_DURATION, elapsed))
                            } else {
                                activeNotes.delete(event.pitch.getValue())
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
            const writePosition = position.getValue() + latency
            if (NoteSignal.isOn(signal)) {
                const {pitch, velocity} = signal
                if (currentTake.isEmpty()) {return}
                const take = currentTake.unwrap()
                const {regionBox, collection} = take
                editing.modify(() => {
                    const notePosition = writePosition - regionBox.position.getValue()
                    if (notePosition < -PPQN.SemiQuaver) {return}
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
                activeNotes.delete(signal.pitch)
            }
        }))
        return terminator
    }
}
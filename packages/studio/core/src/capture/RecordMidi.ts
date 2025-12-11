import {byte, Notifier, Option, quantizeCeil, quantizeRound, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
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

    const MIN_NOTE_DURATION = PPQN.fromSignature(1, 128)

    export const start = ({notifier, project, capture}: RecordMidiContext): Terminable => {
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, boxGraph, engine, env: {audioContext}, timelineBox: {bpm}} = project
        const {position, isRecording} = engine
        const trackBox: TrackBox = RecordTrack.findOrCreate(editing, capture.audioUnitBox, TrackType.Notes)
        const terminator = new Terminator()
        const activeNotes = new Map<byte, NoteEventBox>()
        const latency = PPQN.secondsToPulses(audioContext.outputLatency ?? 10.0, bpm.getValue())
        let writing: Option<{ region: NoteRegionBox, collection: NoteEventCollectionBox }> = Option.None
        const createRegion = () => {
            const writePosition = position.getValue() + latency
            editing.modify(() => {
                const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                const region = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.regions.refer(trackBox.regions)
                    box.events.refer(collection.owners)
                    box.position.setValue(Math.max(quantizeRound(writePosition, beats), 0))
                    box.hue.setValue(ColorCodes.forTrackType(TrackType.Notes))
                })
                engine.ignoreNoteRegion(region.address.uuid)
                writing = Option.wrap({region, collection})
            }, false)
        }
        terminator.own(position.catchupAndSubscribe(owner => {
            if (writing.isEmpty()) {
                if (isRecording.getValue()) {createRegion()} else {return}
            }
            const writePosition = owner.getValue() + latency
            const {region, collection} = writing.unwrap()
            editing.modify(() => {
                if (region.isAttached() && collection.isAttached()) {
                    const {position, duration, loopDuration} = region
                    const newDuration = quantizeCeil(writePosition, beats) - position.getValue()
                    duration.setValue(newDuration)
                    loopDuration.setValue(newDuration)
                    for (const event of activeNotes.values()) {
                        if (event.isAttached()) {
                            event.duration.setValue(Math.max(MIN_NOTE_DURATION,
                                writePosition - region.position.getValue() - event.position.getValue()))
                        } else {
                            activeNotes.delete(event.pitch.getValue())
                        }
                    }
                } else {
                    terminator.terminate()
                    writing = Option.None
                }
            }, false)
        }))
        terminator.ownAll(notifier.subscribe((signal: NoteSignal) => {
            const writePosition = position.getValue() + latency
            if (NoteSignal.isOn(signal)) {
                const {pitch, velocity} = signal
                if (writing.isEmpty()) {createRegion()}
                const {region, collection} = writing.unwrap()
                editing.modify(() => {
                    const position = writePosition - region.position.getValue()
                    if (position < -PPQN.SemiQuaver) {return}
                    activeNotes.set(pitch, NoteEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(Math.max(0, position))
                        box.duration.setValue(MIN_NOTE_DURATION)
                        box.pitch.setValue(pitch)
                        box.velocity.setValue(velocity)
                        box.events.refer(collection.events)
                    }))
                }, false)
            } else if (NoteSignal.isOff(signal)) {
                activeNotes.delete(signal.pitch)
            }
        }))
        return terminator
    }
}
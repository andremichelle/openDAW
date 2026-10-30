import {
    byte,
    int,
    isDefined,
    Notifier,
    Nullable,
    Option,
    Optional,
    quantizeCeil,
    quantizeFloor,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ColorCodes, NoteSignal, TrackType, TransportAnchor} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {ContextClock} from "../io"
import {Capture} from "./Capture"
import {RecordTrack} from "./RecordTrack"
import {TakePolicy} from "./TakePolicy"
import {TransportLog} from "./TransportLog"

export namespace RecordMidi {
    type RecordMidiContext = {
        notifier: Notifier<NoteSignal>,
        project: Project,
        capture: Capture,
        clock: ContextClock
    }

    type TakeData = {
        trackBox: TrackBox
        regionBox: NoteRegionBox
        collection: NoteEventCollectionBox
    }

    // a take covers the transport from the context time `from` (at `position`) until the next lap begins
    type Lap = {
        take: TakeData
        from: number
        position: ppqn
    }

    type ActiveNote = {
        event: NoteEventBox
        take: TakeData
        time: number
    }

    const MIN_NOTE_DURATION = PPQN.fromSignature(1, 128)

    export const start = ({notifier, project, capture, clock}: RecordMidiContext): Terminable => {
        const beats = PPQN.fromSignature(1, project.timelineBox.signature.denominator.getValue())
        const {editing, boxGraph, engine, timelineBox, tempoMap} = project
        const {isRecording, preferences: {settings: {recording}}} = engine
        const {loopArea} = timelineBox
        const terminator = new Terminator()
        const transport = new TransportLog(tempoMap)
        const laps: Array<Lap> = []
        const activeNotes = new Map<byte, ActiveNote>()
        const pendingNotes = new Map<byte, byte>()
        // notes heard past the loop end before the engine's wrap arrived, replayed once it has
        const lateSignals: Array<NoteSignal> = []
        let takeCount: int = RecordTrack.lastTakeNumber(capture.audioUnitBox)

        // the context time a note was heard at, on the timeline the engine rendered before the delay compensation
        const timeOf = (timeStamp: Optional<number>): number => {
            const now = performance.now()
            const stamp = isDefined(timeStamp) ? Math.min(timeStamp, now) : now
            return clock.audibleTimeAt(stamp) - engine.compensationLatency.getValue()
        }

        const lapAt = (time: number): Option<Lap> => {
            for (let index = laps.length - 1; index >= 0; index--) {
                if (laps[index].from <= time) {return Option.wrap(laps[index])}
            }
            return Option.None
        }

        const takesWrap = (): boolean => loopArea.enabled.getValue() && recording.allowTakes

        const writeDuration = ({event, time}: ActiveNote, until: number): void =>
            event.duration.setValue(Math.max(MIN_NOTE_DURATION, Math.round(transport.advance(time, until))))

        const takeDuration = (regionPosition: ppqn, writePosition: ppqn): ppqn => {
            const loopTo = loopArea.to.getValue()
            const capped = takesWrap() && regionPosition < loopTo
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
            const {regionBox} = take
            if (regionBox.isAttached()) {
                regionBox.duration.setValue(loopDurationPPQN)
                regionBox.loopDuration.setValue(loopDurationPPQN)
            }
            TakePolicy.applyOlderTakeAction(recording, capture.audioUnitBox, take)
        }

        const flushPendingNotes = (take: TakeData, time: number) => {
            for (const [pitch, velocity] of pendingNotes) {
                const event = NoteEventBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(0)
                    box.duration.setValue(MIN_NOTE_DURATION)
                    box.pitch.setValue(pitch)
                    box.velocity.setValue(velocity)
                    box.events.refer(take.collection.events)
                })
                activeNotes.set(pitch, {event, take, time})
            }
            pendingNotes.clear()
        }

        const openFirstTake = (): void => {
            if (laps.length > 0) {return}
            engine.recordingStart.ifSome(({contextTime, position}) => {
                transport.append({kind: "start", contextTime, position, recording: true})
                editing.modify(() => {
                    const take = createTakeRegion(quantizeFloor(position, beats), position, null)
                    laps.push({take, from: contextTime, position})
                    flushPendingNotes(take, contextTime)
                }, false)
            })
        }

        const wrap = (anchor: TransportAnchor): void => {
            const lap = laps.at(-1)
            if (!isDefined(lap) || anchor.contextTime <= lap.from || !takesWrap()) {return}
            editing.modify(() => {
                const {take} = lap
                const endPosition = lap.position + transport.advance(lap.from, anchor.contextTime)
                finalizeTake(take, takeDuration(take.regionBox.position.getValue(), endPosition))
                const next = createTakeRegion(anchor.position, anchor.position, take.trackBox)
                laps.push({take: next, from: anchor.contextTime, position: anchor.position})
            }, false)
        }

        // past the loop end while the lap began before it: the engine wrapped, its anchor is still on the way
        const awaitsWrap = (lap: Lap, writePosition: ppqn): boolean =>
            takesWrap() && lap.position < loopArea.to.getValue() && writePosition >= loopArea.to.getValue()

        const handleSignal = (signal: NoteSignal): void => {
            const time = timeOf(NoteSignal.isAudition(signal) ? undefined : signal.timeStamp)
            const lap = lapAt(time)
            if (NoteSignal.isOn(signal)) {
                const {pitch, velocity} = signal
                if (lap.isEmpty()) {
                    pendingNotes.set(pitch, velocity)
                    return
                }
                const {take} = lap.unwrap()
                const writePosition = transport.positionAt(time).unwrap()
                if (awaitsWrap(lap.unwrap(), writePosition)) {
                    lateSignals.push(signal)
                    return
                }
                const {regionBox, collection} = take
                editing.modify(() => {
                    const notePosition = writePosition - regionBox.position.getValue()
                    if (notePosition < -PPQN.SemiQuaver) {return}
                    growTake(regionBox, writePosition)
                    const event = NoteEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(Math.max(0, Math.round(notePosition)))
                        box.duration.setValue(MIN_NOTE_DURATION)
                        box.pitch.setValue(pitch)
                        box.velocity.setValue(velocity)
                        box.events.refer(collection.events)
                    })
                    activeNotes.set(pitch, {event, take, time})
                }, false)
            } else if (NoteSignal.isOff(signal)) {
                if (pendingNotes.has(signal.pitch)) {
                    pendingNotes.delete(signal.pitch)
                    return
                }
                if (lap.nonEmpty() && awaitsWrap(lap.unwrap(), transport.positionAt(time).unwrap())) {
                    lateSignals.push(signal)
                    return
                }
                const note = activeNotes.get(signal.pitch)
                activeNotes.delete(signal.pitch)
                if (isDefined(note) && note.event.isAttached()) {
                    editing.modify(() => {
                        writeDuration(note, time)
                        lap.ifSome(({take: {regionBox}}) => growTake(regionBox, transport.positionAt(time).unwrap()))
                    }, false)
                }
            }
        }

        const replayLateSignals = (): void => lateSignals.splice(0).forEach(handleSignal)

        terminator.ownAll(
            engine.recordingStart.subscribe(() => openFirstTake()),
            engine.subscribeTransportAnchors(anchors => anchors.forEach(anchor => {
                transport.append(anchor)
                if (anchor.kind === "jump" && anchor.recording) {
                    openFirstTake()
                    wrap(anchor)
                    replayLateSignals()
                }
            })),
            engine.position.catchupAndSubscribe(() => {
                if (!isRecording.getValue()) {return}
                openFirstTake()
                const time = timeOf(undefined)
                lapAt(time).ifSome(({take: {regionBox, collection}}) => editing.modify(() => {
                    if (regionBox.isAttached() && collection.isAttached()) {
                        growTake(regionBox, transport.positionAt(time).unwrap())
                        for (const note of activeNotes.values()) {
                            if (note.event.isAttached()) {
                                writeDuration(note, time)
                            } else {
                                activeNotes.delete(note.event.pitch.getValue())
                            }
                        }
                    } else {
                        terminator.terminate()
                    }
                }, false))
            }),
            notifier.subscribe(handleSignal),
            Terminable.create(() => lateSignals.length = 0)
        )
        return terminator
    }
}

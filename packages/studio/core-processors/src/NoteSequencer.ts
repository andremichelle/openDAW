import {EngineContext} from "./EngineContext"
import {
    AudioUnitBoxAdapter,
    NoteClipBoxAdapter,
    NoteEventCollectionBoxAdapter,
    NoteRegionBoxAdapter,
    TrackBoxAdapter,
    TrackType
} from "@moises-ai/studio-adapters"
import {EventSpanRetainer, LoopableRegion, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {
    Bits,
    byte,
    clamp,
    Id,
    int,
    isInstanceOf,
    Option,
    quantizeFloor,
    Random,
    Terminable,
    Terminator,
    unitValue,
    UUID
} from "@moises-ai/lib-std"
import {NoteCompleteEvent, NoteEventSource, NoteLifecycleEvent} from "./NoteEventSource"
import {BlockFlag, ProcessPhase} from "./processing"

type RawNote = {
    readonly pitch: byte
    readonly velocity: unitValue

    gate: boolean
    running: Option<Id<NoteEvent>>
}

type ScheduledNote = {
    readonly pitch: byte
    readonly duration: ppqn
    readonly velocity: unitValue
}

export class NoteSequencer implements NoteEventSource, Terminable {
    readonly #terminator = new Terminator()
    readonly #context: EngineContext
    readonly #adapter: AudioUnitBoxAdapter

    readonly #random: Random
    readonly #rawNotes: Set<RawNote>
    readonly #auditionNotes: Array<ScheduledNote>
    readonly #auditionRetainer: EventSpanRetainer<Id<NoteEvent>>
    readonly #retainer: EventSpanRetainer<Id<NoteEvent>>

    constructor(context: EngineContext, adapter: AudioUnitBoxAdapter) {
        this.#context = context
        this.#adapter = adapter

        this.#random = Random.create(0xFFFF123)
        this.#rawNotes = new Set<RawNote>()
        this.#auditionNotes = []
        this.#auditionRetainer = new EventSpanRetainer<Id<NoteEvent>>()
        this.#retainer = new EventSpanRetainer<Id<NoteEvent>>()

        this.#terminator.ownAll(
            this.#context.subscribeProcessPhase((phase: ProcessPhase) => {
                if (phase === ProcessPhase.After) {
                    for (const note of this.#rawNotes) {
                        if (!note.gate) {this.#rawNotes.delete(note)}
                    }
                }
            })
        )
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}

    terminate(): void {this.#terminator.terminate()}

    pushRawNoteOn(pitch: byte, velocity: unitValue): void {
        this.#rawNotes.add({pitch, velocity, gate: true, running: Option.None})
    }

    pushRawNoteOff(pitch: byte): void {
        for (const entry of this.#rawNotes) {
            if (entry.running.isEmpty()) {
                // never started
                this.#rawNotes.delete(entry)
            } else if (entry.pitch === pitch) {
                entry.gate = false
                return
            }
        }
    }

    auditionNote(pitch: byte, duration: ppqn, velocity: unitValue): void {
        this.#auditionNotes.push({pitch, duration, velocity})
    }

    * processNotes(from: ppqn, to: ppqn, flags: int): IterableIterator<NoteLifecycleEvent> {
        const read = Bits.every(flags, BlockFlag.transporting | BlockFlag.playing)
        const discontinuous = Bits.every(flags, BlockFlag.discontinuous)
        if (this.#retainer.nonEmpty()) {
            const releaseAll = !read || discontinuous
            if (releaseAll) {
                yield* this.#releaseAll(from)
            } else {
                yield* this.#releaseCompleted(from, to)
            }
        }
        if (this.#auditionRetainer.nonEmpty()) {
            if (discontinuous) {
                for (const event of this.#auditionRetainer.releaseAll()) {
                    yield NoteLifecycleEvent.stop(event, from)
                }
            } else {
                for (const event of this.#auditionRetainer.releaseLinearCompleted(to)) {
                    yield NoteLifecycleEvent.stop(event, event.position + event.duration)
                }
            }
        }
        if (this.#rawNotes.size > 0) {
            for (const note of this.#rawNotes) {
                if (note.running.isEmpty()) {
                    const {pitch, velocity} = note
                    const duration = Number.POSITIVE_INFINITY
                    const event = NoteLifecycleEvent.start(from, duration, pitch, velocity)
                    note.running = Option.wrap(event)
                    yield event
                }
                if (!note.gate) {
                    this.#rawNotes.delete(note)
                    yield NoteLifecycleEvent.stop(note.running.unwrap("raw note never started"), from)
                }
            }
        }
        if (this.#auditionNotes.length > 0) {
            for (const removed of this.#auditionRetainer.releaseAll()) {
                yield NoteLifecycleEvent.stop(removed, from)
            }
            for (const {pitch, duration, velocity} of this.#auditionNotes) {
                const event = NoteLifecycleEvent.start(from, duration, pitch, velocity)
                this.#auditionRetainer.addAndRetain({...event})
                yield event
            }
            this.#auditionNotes.length = 0
        }
        if (read) {
            const tracks = this.#adapter.tracks.collection.adapters()
                .filter(adapter => adapter.type === TrackType.Notes && adapter.enabled.getValue())
            for (const track of tracks) {
                const clipSections = this.#context.clipSequencing.iterate(track.uuid, from, to)
                for (const {optClip, sectionFrom, sectionTo} of clipSections) {
                    if (optClip.isEmpty()) {
                        yield* this.#processRegions(track, sectionFrom, sectionTo)
                    } else {
                        yield* this.#processClip(optClip.unwrap() as NoteClipBoxAdapter, sectionFrom, sectionTo)
                    }
                }
            }
            yield* this.#releaseCompleted(from, to) // in case they complete in the same block
        }
    }

    * iterateActiveNotesAt(position: ppqn, onlyEnternal: boolean): IterableIterator<NoteEvent> {
        if (this.#rawNotes.size > 0) {
            for (const {pitch, velocity} of this.#rawNotes) {
                yield {
                    type: "note-event",
                    position,
                    duration: Number.POSITIVE_INFINITY,
                    pitch,
                    velocity,
                    cent: 0.0
                }
            }
        }
        yield* this.#auditionRetainer.overlapping(position, NoteEvent.Comparator)
        if (onlyEnternal) {return}
        yield* this.#retainer.overlapping(position, NoteEvent.Comparator)
    }

    reset(): void {
        this.#rawNotes.clear()
        this.#retainer.clear()
        this.#auditionNotes.length = 0
        this.#auditionRetainer.clear()
    }

    toString(): string {return `{${this.constructor.name}}`}

    * #processClip(clip: NoteClipBoxAdapter, p0: ppqn, p1: ppqn): IterableIterator<Id<NoteEvent>> {
        if (clip.optCollection.isEmpty()) {return}
        const truncateNotesAtRegionEnd = this.#context.preferences.settings.playback.truncateNotesAtRegionEnd
        const collection = clip.optCollection.unwrap()
        const clipDuration = clip.duration
        const clipStart = quantizeFloor(p0, clipDuration)
        const clipEnd = clipStart + clipDuration
        const truncateEnd = truncateNotesAtRegionEnd ? clipDuration : Number.POSITIVE_INFINITY
        if (p1 > clipEnd) {
            yield* this.#processCollection(collection, p0 - clipStart, clipEnd - clipStart, clipStart, truncateEnd)
            yield* this.#processCollection(collection, 0, p1 - clipEnd, clipEnd, truncateEnd)
        } else {
            yield* this.#processCollection(collection, p0 - clipStart, p1 - clipStart, clipStart, truncateEnd)
        }
    }

    * #processRegions(trackBoxAdapter: TrackBoxAdapter, p0: ppqn, p1: ppqn): IterableIterator<Id<NoteEvent>> {
        const truncateNotesAtRegionEnd = this.#context.preferences.settings.playback.truncateNotesAtRegionEnd
        for (const region of trackBoxAdapter.regions.collection.iterateRange(p0, p1)) {
            if (this.#context.ignoresRegion(region.address.uuid)
                || region.mute || !isInstanceOf(region, NoteRegionBoxAdapter)) {continue}
            const optCollection = region.optCollection
            if (optCollection.isEmpty()) {continue}
            const collection = optCollection.unwrap()
            for (const {resultStart, resultEnd, rawStart, rawEnd} of LoopableRegion.locateLoops(region, p0, p1)) {
                const end = truncateNotesAtRegionEnd
                    ? Math.min(rawEnd, region.complete)
                    : Number.POSITIVE_INFINITY
                yield* this.#processCollection(collection, resultStart - rawStart, resultEnd - rawStart, rawStart, end - rawStart)
            }
        }
    }

    * #processCollection(collection: NoteEventCollectionBoxAdapter, localStart: ppqn, localEnd: ppqn, delta: ppqn, end: ppqn): IterableIterator<Id<NoteEvent>> {
        for (const source of collection.events.iterateRange(localStart - collection.maxDuration, localEnd)) {
            if (!NoteEvent.isOfType(source)) {continue}
            const {position, duration, chance, playCount, playCurve} = source
            if (chance < 100.0 && this.#random.nextDouble(0.0, 100.0) > chance) {continue}
            if (playCount > 1) {
                const searchStart = NoteEvent.inverseCurveFunc((localStart - position) / duration, playCurve)
                const searchLimit = NoteEvent.inverseCurveFunc((localEnd - position) / duration, playCurve)
                let searchIndex = Math.floor(searchStart * playCount)
                let searchPosition = searchIndex / playCount
                while (searchPosition < searchLimit) {
                    if (searchPosition >= searchStart) {
                        const a = NoteEvent.curveFunc(searchPosition, playCurve) * duration
                        if (a >= duration) {break}
                        const b = NoteEvent.curveFunc((searchPosition + 1.0 / playCount), playCurve) * duration
                        const event: Id<NoteEvent> = NoteLifecycleEvent.startWith(source, position + a + delta, b - a)
                        this.#retainer.addAndRetain({...event})
                        yield event
                    }
                    searchPosition = ++searchIndex / playCount
                }
            } else {
                if (localStart <= position && position < localEnd) {
                    const duration = Math.min(source.duration, end - position)
                    const event: Id<NoteEvent> = NoteLifecycleEvent.startWith(source, position + delta, duration)
                    this.#retainer.addAndRetain({...event})
                    yield event
                }
            }
        }
    }

    * #releaseAll(from: ppqn): IterableIterator<NoteCompleteEvent> {
        for (const event of this.#retainer.releaseAll()) {
            yield NoteLifecycleEvent.stop(event, from)
        }
    }

    * #releaseCompleted(from: ppqn, to: ppqn): IterableIterator<NoteCompleteEvent> {
        for (const event of this.#retainer.releaseLinearCompleted(to)) {
            // We need to clamp the value in case the time-domain has been changed between note-start and note-complete
            const position = clamp(event.position + event.duration, from, to)
            yield NoteLifecycleEvent.stop(event, position)
        }
    }
}
import {
    Arrays,
    asInstanceOf,
    assert,
    Bits,
    byte,
    float,
    Id,
    int,
    isDefined, isNotNull,
    Nullable,
    Option,
    SetMultimap,
    Terminable,
    UUID
} from "@moises-ai/lib-std"
import {EngineToClient, SpielwerkDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {WerkstattParameterBox} from "@moises-ai/studio-boxes"
import {Event, EventSpanRetainer, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {EventProcessor} from "../../EventProcessor"
import {Block, BlockFlag, Processor} from "../../processing"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteEventTarget, NoteLifecycleEvent} from "../../NoteEventSource"
import {MidiEffectProcessor} from "../../MidiEffectProcessor"

const HEADER_PATTERN = /^\/\/ @spielwerk (\w+) (\d+) (\d+)\n/

const MAX_NOTES_PER_BLOCK: int = 128
const MAX_SCHEDULED_NOTES: int = 128

const parseUpdate = (code: string): int => {
    const match = code.match(HEADER_PATTERN)
    return match !== null ? parseInt(match[3]) : -1
}

interface ScheduledNote {
    readonly position: ppqn
    readonly duration: ppqn
    readonly pitch: byte
    readonly velocity: float
    readonly cent: number
}

type UserEvent =
    | {readonly gate: true, readonly id: int, readonly position: ppqn, readonly duration: ppqn, readonly pitch: byte, readonly velocity: float, readonly cent: number}
    | {readonly gate: false, readonly id: int, readonly position: ppqn, readonly pitch: byte}

type UserOutput = {
    readonly position: ppqn
    readonly duration: ppqn
    readonly pitch: byte
    readonly velocity: float
    readonly cent: number
}

interface UserBlock {
    readonly from: ppqn
    readonly to: ppqn
    readonly bpm: number
    readonly s0: int
    readonly s1: int
    readonly flags: int
}

interface UserProcessor {
    process(block: UserBlock, events: Iterable<UserEvent>): IterableIterator<UserOutput>
    paramChanged?(label: string, value: number): void
    reset?(): void
}

const validateNote = (note: any, from: ppqn): Nullable<string> => {
    if (!isDefined(note)) {return "process yielded undefined"}
    if (typeof note.pitch !== "number" || note.pitch !== note.pitch) {return `Invalid pitch: ${note.pitch}`}
    if (note.pitch < 0 || note.pitch > 127) {return `Pitch out of range: ${note.pitch} (must be 0–127)`}
    if (typeof note.velocity !== "number" || note.velocity !== note.velocity) {return `Invalid velocity: ${note.velocity}`}
    if (note.velocity < 0 || note.velocity > 1) {return `Velocity out of range: ${note.velocity} (must be 0–1)`}
    if (typeof note.duration !== "number" || note.duration !== note.duration) {return `Invalid duration: ${note.duration}`}
    if (note.duration <= 0) {return `Duration must be positive: ${note.duration}`}
    if (typeof note.position !== "number" || note.position !== note.position) {return `Invalid position: ${note.position}`}
    if (note.position < from) {return `Position ${note.position} is in the past (block starts at ${from})`}
    return null
}

export class SpielwerkDeviceProcessor extends EventProcessor implements MidiEffectProcessor {
    readonly #adapter: SpielwerkDeviceBoxAdapter
    readonly #engineToClient: EngineToClient
    readonly #retainer: EventSpanRetainer<Id<NoteEvent>>
    readonly #scheduled: Array<ScheduledNote>
    readonly #sourceToOutput: SetMultimap<int, int>
    readonly #uuid: string
    readonly #boundParameters: Array<AutomatableParameter<number>>

    #source: Option<NoteEventSource> = Option.None
    #userProcessor: Option<UserProcessor> = Option.None
    #currentUpdate: int = -1
    #silenced: boolean = false
    #wasPlaying: boolean = false

    constructor(context: EngineContext, adapter: SpielwerkDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#engineToClient = context.engineToClient
        this.#retainer = new EventSpanRetainer<Id<NoteEvent>>()
        this.#scheduled = []
        this.#sourceToOutput = new SetMultimap()
        this.#uuid = UUID.toString(adapter.uuid)
        this.#boundParameters = []
        const {parameters, box} = adapter
        this.ownAll(
            box.code.catchupAndSubscribe(owner => {
                const newUpdate = parseUpdate(owner.getValue())
                if (newUpdate > 0 && newUpdate !== this.#currentUpdate) {
                    this.#silenced = true
                    this.#userProcessor = Option.None
                    this.#tryLoad(newUpdate)
                }
            }),
            box.parameters.pointerHub.catchupAndSubscribe({
                onAdded: (({box}) => {
                    const paramBox = asInstanceOf(box, WerkstattParameterBox)
                    const bound = this.bindParameter(parameters.parameterAt(paramBox.value.address))
                    this.#boundParameters.push(bound)
                    this.parameterChanged(bound)
                }),
                onRemoved: (({box}) => {
                    const paramBox = asInstanceOf(box, WerkstattParameterBox)
                    Arrays.removeIf(this.#boundParameters, parameter =>
                        parameter.address === paramBox.value.address)
                })
            }),
            context.registerProcessor(this)
        )
        this.readAllParameters()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get noteEventTarget(): Option<NoteEventTarget> {return Option.wrap(this)}

    setNoteEventSource(source: NoteEventSource): Terminable {
        assert(this.#source.isEmpty(), "NoteEventSource already set")
        this.#source = Option.wrap(source)
        return Terminable.create(() => this.#source = Option.None)
    }

    * processNotes(from: ppqn, to: ppqn, flags: int): IterableIterator<NoteLifecycleEvent> {
        const playing = Bits.every(flags, BlockFlag.transporting | BlockFlag.playing)
        if (this.#retainer.nonEmpty()) {
            if (Bits.every(flags, BlockFlag.discontinuous) || (this.#wasPlaying && !playing)) {
                for (const event of this.#retainer.releaseAll()) {
                    yield NoteLifecycleEvent.stop(event, from)
                }
                Arrays.clear(this.#scheduled)
                this.#sourceToOutput.clear()
                this.#userProcessor.ifSome(proc => {
                    if (isDefined(proc.reset)) {proc.reset()}
                })
            } else {
                for (const event of this.#retainer.releaseLinearCompleted(to)) {
                    yield NoteLifecycleEvent.stop(event, event.position + event.duration)
                }
            }
        }
        this.#wasPlaying = playing
        if (this.#silenced) {
            const expectedUpdate = parseUpdate(this.#adapter.box.code.getValue())
            if (expectedUpdate > 0 && expectedUpdate !== this.#currentUpdate) {
                this.#tryLoad(expectedUpdate)
            }
        }
        if (this.#source.nonEmpty() && this.#userProcessor.nonEmpty() && !this.#silenced) {
            const source = this.#source.unwrap()
            const proc = this.#userProcessor.unwrap()
            const events: Array<UserEvent> = []
            for (const event of source.processNotes(from, to, flags)) {
                if (NoteLifecycleEvent.isStart(event)) {
                    events.push({
                        gate: true,
                        id: event.id,
                        position: event.position,
                        duration: event.duration,
                        pitch: event.pitch,
                        velocity: event.velocity,
                        cent: event.cent
                    })
                } else {
                    for (const outputId of this.#sourceToOutput.get(event.id)) {
                        for (const released of this.#retainer.release(note => note.id === outputId)) {
                            yield NoteLifecycleEvent.stop(released, event.position)
                        }
                    }
                    this.#sourceToOutput.removeKey(event.id)
                    events.push({
                        gate: false,
                        id: event.id,
                        position: event.position,
                        pitch: event.pitch
                    })
                }
            }
            for (let i = this.#scheduled.length - 1; i >= 0; i--) {
                const note = this.#scheduled[i]
                if (note.position >= from && note.position < to) {
                    this.#scheduled.splice(i, 1)
                    yield* this.#emitNote(note)
                }
            }
            let currentSourceId: int = -1
            const trackedEvents: Iterable<UserEvent> = {
                [Symbol.iterator](): Iterator<UserEvent> {
                    const inner = events[Symbol.iterator]()
                    return {
                        next(): IteratorResult<UserEvent> {
                            const result = inner.next()
                            if (result.done) {
                                currentSourceId = -1
                            } else if (result.value.gate) {
                                currentSourceId = result.value.id
                            }
                            return result
                        }
                    }
                }
            }
            const userBlock: UserBlock = {from, to, bpm: 0, s0: 0, s1: 0, flags}
            try {
                let noteCount: int = 0
                for (const yielded of proc.process(userBlock, trackedEvents)) {
                    if (++noteCount > MAX_NOTES_PER_BLOCK) {
                        this.#silence(`Note flood: exceeded ${MAX_NOTES_PER_BLOCK} notes per block`)
                        return
                    }
                    const error = validateNote(yielded, from)
                    if (isNotNull(error)) {
                        this.#silence(error)
                        return
                    }
                    if (yielded.position >= to) {
                        if (this.#scheduled.length >= MAX_SCHEDULED_NOTES) {
                            this.#silence(`Scheduler full: exceeded ${MAX_SCHEDULED_NOTES} scheduled notes`)
                            return
                        }
                        this.#scheduled.push({
                            position: yielded.position,
                            duration: yielded.duration,
                            pitch: yielded.pitch,
                            velocity: yielded.velocity,
                            cent: yielded.cent ?? 0
                        })
                    } else {
                        yield* this.#emitNote(yielded, currentSourceId >= 0 ? currentSourceId : undefined)
                    }
                }
            } catch (err) {
                this.#silence(`Runtime error: ${err}`)
                return
            }
            for (const event of this.#retainer.releaseLinearCompleted(to)) {
                yield NoteLifecycleEvent.stop(event, event.position + event.duration)
            }
        }
    }

    * iterateActiveNotesAt(position: ppqn, _onlyExternal: boolean): IterableIterator<NoteEvent> {
        yield* this.#retainer.overlapping(position, NoteEvent.Comparator)
    }

    reset(): void {
        this.#retainer.clear()
        Arrays.clear(this.#scheduled)
        this.#sourceToOutput.clear()
        this.eventInput.clear()
    }

    processEvents(_block: Block, _from: ppqn, _to: ppqn): void {}

    parameterChanged(parameter: AutomatableParameter): void {
        this.#userProcessor.ifSome(proc => {
            if (isDefined(proc.paramChanged)) {
                const paramBox = asInstanceOf(parameter.adapter.field.box, WerkstattParameterBox)
                proc.paramChanged(paramBox.label.getValue(), parameter.getValue())
            }
        })
    }

    handleEvent(_block: Block, _event: Event): void {}

    index(): number {return this.#adapter.indexField.getValue()}
    adapter(): SpielwerkDeviceBoxAdapter {return this.#adapter}

    #tryLoad(update: int): void {
        const registry = (globalThis as any).openDAW?.spielwerkProcessors?.[this.#uuid]
        if (isDefined(registry) && registry.update === update) {
            this.#swapProcessor(registry.create, update)
        }
    }

    #swapProcessor(ProcessorClass: any, update: int): void {
        try {
            this.#userProcessor = Option.wrap(new ProcessorClass() as UserProcessor)
            this.#currentUpdate = update
            this.#silenced = false
            this.#pushAllParameters()
        } catch (error) {
            this.#silence(`Failed to instantiate Processor: ${error}`)
        }
    }

    #pushAllParameters(): void {
        this.#userProcessor.ifSome(proc => {
            if (isDefined(proc.paramChanged)) {
                for (const bound of this.#boundParameters) {
                    const paramBox = asInstanceOf(bound.adapter.field.box, WerkstattParameterBox)
                    proc.paramChanged(paramBox.label.getValue(), bound.getValue())
                }
            }
        })
    }

    #reportError(message: string): void {
        this.#engineToClient.deviceMessage(this.#uuid, message)
    }

    #silence(message: string): void {
        this.#silenced = true
        Arrays.clear(this.#scheduled)
        this.#sourceToOutput.clear()
        this.#reportError(message)
    }

    * #emitNote(note: ScheduledNote, sourceId?: int): IterableIterator<NoteLifecycleEvent> {
        const lifecycle = NoteLifecycleEvent.start(note.position, note.duration, note.pitch, note.velocity, note.cent)
        this.#retainer.addAndRetain({...lifecycle})
        if (isDefined(sourceId)) {this.#sourceToOutput.add(sourceId, lifecycle.id)}
        yield lifecycle
    }
}

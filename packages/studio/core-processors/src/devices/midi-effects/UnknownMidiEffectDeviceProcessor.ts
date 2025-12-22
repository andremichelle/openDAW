import {assert, int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {NoteBroadcaster, UnknownMidiEffectDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Event, NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {EventProcessor} from "../../EventProcessor"
import {Block, Processor} from "../../processing"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteLifecycleEvent} from "../../NoteEventSource"
import {MidiEffectProcessor} from "../../MidiEffectProcessor"

export class UnknownMidiEffectDeviceProcessor extends EventProcessor implements MidiEffectProcessor {
    readonly #adapter: UnknownMidiEffectDeviceBoxAdapter

    readonly #noteBroadcaster: NoteBroadcaster

    #source: Option<NoteEventSource> = Option.None

    constructor(context: EngineContext, adapter: UnknownMidiEffectDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#noteBroadcaster = this.own(new NoteBroadcaster(context.broadcaster, adapter.address))
        this.own(context.registerProcessor(this))
        this.readAllParameters()
    }

    setNoteEventSource(source: NoteEventSource): Terminable {
        assert(this.#source.isEmpty(), "NoteEventSource already set")
        this.#source = Option.wrap(source)
        return Terminable.create(() => this.#source = Option.None)
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    * processNotes(from: ppqn, to: ppqn, flags: int): IterableIterator<NoteLifecycleEvent> {
        if (this.#source.isEmpty()) {return}
        for (const event of this.#source.unwrap().processNotes(from, to, flags)) {
            yield event
        }
    }

    * iterateActiveNotesAt(position: ppqn, onlyExternal: boolean): IterableIterator<NoteEvent> {
        if (this.#source.isEmpty()) {return}
        for (const event of this.#source.unwrap().iterateActiveNotesAt(position, onlyExternal)) {
            yield event
        }
    }

    reset(): void {this.eventInput.clear()}

    processEvents(_block: Block, _from: ppqn, _to: ppqn): void {}

    parameterChanged(_parameter: AutomatableParameter): void {}

    handleEvent(_block: Block, _event: Event): void {}

    index(): number {return this.#adapter.indexField.getValue()}
    adapter(): UnknownMidiEffectDeviceBoxAdapter {return this.#adapter}
}
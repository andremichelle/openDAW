import {assert, clamp, identity, int, Objects, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {Event, Groove, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteLifecycleEvent} from "../../NoteEventSource"
import {GrooveAdapter, NoteBroadcaster, ZeitgeistDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {EventProcessor} from "../../EventProcessor"
import {Block} from "../../processing"
import {EngineContext} from "../../EngineContext"
import {MidiEffectProcessor} from "../../MidiEffectProcessor"

export class ZeitgeistDeviceProcessor extends EventProcessor implements MidiEffectProcessor {
    readonly #adapter: ZeitgeistDeviceBoxAdapter

    readonly #noteBroadcaster: NoteBroadcaster

    #groove: Option<GrooveAdapter> = Option.None
    #source: Option<NoteEventSource> = Option.None

    constructor(context: EngineContext, adapter: ZeitgeistDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#noteBroadcaster = this.own(new NoteBroadcaster(context.broadcaster, adapter.address))

        this.ownAll(
            adapter.box.groove.catchupAndSubscribe(pointer => {
                this.#groove.ifSome(adapter => adapter.terminate())
                this.#groove = Option.wrap(pointer.targetVertex.isEmpty()
                    ? null
                    : context.boxAdapters.adapterFor(pointer.targetVertex.unwrap().box, GrooveAdapter.checkType))
            }),
            Terminable.create(() => {
                this.#groove.ifSome(adapter => adapter.terminate()) // FIXME This processor does not OWN that adapter!
                this.#groove = Option.None
            }),
            context.registerProcessor(this)
        )
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): ZeitgeistDeviceBoxAdapter {return this.#adapter}

    setNoteEventSource(source: NoteEventSource): Terminable {
        assert(this.#source.isEmpty(), "NoteEventSource already set")
        this.#source = Option.wrap(source)
        return Terminable.create(() => this.#source = Option.None)
    }

    * processNotes(from: ppqn, to: ppqn, flags: int): IterableIterator<NoteLifecycleEvent> {
        if (this.#source.isEmpty()) {return}
        const source = this.#source.unwrap()
        const groove: Groove = this.#groove.mapOr(identity, Groove.Identity)
        for (const event of source.processNotes(groove.unwarp(from), groove.unwarp(to), flags)) {
            if (NoteLifecycleEvent.isStart(event)) {
                this.#noteBroadcaster.noteOn(event.pitch)
            } else {
                this.#noteBroadcaster.noteOff(event.pitch)
            }
            yield Objects.overwrite(event, {position: clamp(groove.warp(event.position), from, to)})
        }
    }

    * iterateActiveNotesAt(position: ppqn, onlyExternal: boolean): IterableIterator<NoteEvent> {
        if (this.#source.isEmpty()) {return}
        const source = this.#source.unwrap()
        const groove: Groove = this.#groove.mapOr(identity, Groove.Identity)
        for (const event of source.iterateActiveNotesAt(groove.unwarp(position), onlyExternal)) {
            yield Objects.overwrite(event, {position: groove.warp(event.position)})
        }
    }

    reset(): void {this.eventInput.clear()}

    parameterChanged(_parameter: AutomatableParameter): void {}

    handleEvent(_block: Readonly<Block>, _event: Event): void {}
    processEvents(_block: Readonly<Block>, _from: number, _to: number): void {}
}

import {assert, int, Objects, Option, Terminable, UUID} from "@opendaw/lib-std"
import {NoteBroadcaster, PitchDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Event, NoteEvent, ppqn} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {EventProcessor} from "../../EventProcessor"
import {Block, Processor} from "../../processing"
import {AutomatableParameter} from "../../AutomatableParameter"
import {NoteEventSource, NoteLifecycleEvent} from "../../NoteEventSource"
import {MidiEffectProcessor} from "../../MidiEffectProcessor"

export class PitchDeviceProcessor extends EventProcessor implements MidiEffectProcessor {
    readonly #adapter: PitchDeviceBoxAdapter

    readonly #noteBroadcaster: NoteBroadcaster
    // TODO We do not need this system in midi-effects, but we cannot remove it without losing ui-updates
    readonly #octavesParameter: AutomatableParameter<int>
    readonly #semiTonesParameter: AutomatableParameter<int>
    readonly #centParameter: AutomatableParameter<number>

    #source: Option<NoteEventSource> = Option.None

    constructor(context: EngineContext, adapter: PitchDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#noteBroadcaster = this.own(new NoteBroadcaster(context.broadcaster, adapter.address))
        this.#octavesParameter = this.own(this.bindParameter(adapter.namedParameter.octaves))
        this.#semiTonesParameter = this.own(this.bindParameter(adapter.namedParameter.semiTones))
        this.#centParameter = this.own(this.bindParameter(adapter.namedParameter.cent))
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
            if (NoteLifecycleEvent.isStart(event)) {
                this.#noteBroadcaster.noteOn(event.pitch)
                const {cent, octaves, semiTones} = this.#adapter.namedParameter
                yield Objects.overwrite(event, {
                    pitch: event.pitch + octaves.valueAt(event.position) * 12 + semiTones.valueAt(event.position),
                    cent: event.cent + cent.valueAt(event.position)
                })
            } else {
                this.#noteBroadcaster.noteOff(event.pitch)
                yield event
            }
        }
    }

    * iterateActiveNotesAt(position: ppqn, onlyExternal: boolean): IterableIterator<NoteEvent> {
        if (this.#source.isEmpty()) {return}
        for (const event of this.#source.unwrap().iterateActiveNotesAt(position, onlyExternal)) {
            if (event.type === "note-event") {
                const {cent, octaves, semiTones} = this.#adapter.namedParameter
                yield Objects.overwrite(event, {
                    pitch: event.pitch + octaves.valueAt(event.position) * 12 + semiTones.valueAt(event.position),
                    cent: event.cent + cent.valueAt(event.position)
                })
            }
        }
    }

    reset(): void {
        this.eventInput.clear()
    }

    processEvents(_block: Block, _from: ppqn, _to: ppqn): void {}

    parameterChanged(parameter: AutomatableParameter): void {}

    handleEvent(_block: Block, _event: Event): void {}

    index(): number {return this.#adapter.indexField.getValue()}
    adapter(): PitchDeviceBoxAdapter {return this.#adapter}
}
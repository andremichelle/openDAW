import {Block, Processor} from "./processing"
import {Event} from "@moises-ai/lib-dsp"
import {NoteEventSource, NoteLifecycleEvent} from "./NoteEventSource"
import {assert, Option, Terminable, Terminator} from "@moises-ai/lib-std"
import {NoteBroadcaster} from "@moises-ai/studio-adapters"
import {Address} from "@moises-ai/lib-box"
import {LiveStreamBroadcaster} from "@moises-ai/lib-fusion"

export class NoteEventInstrument implements Terminable {
    readonly #terminator = new Terminator()
    readonly #receiver: Processor
    readonly #broadcaster: NoteBroadcaster
    readonly #buffer: Array<NoteLifecycleEvent>

    #source: Option<NoteEventSource> = Option.None

    constructor(receiver: Processor, broadcaster: LiveStreamBroadcaster, address: Address) {
        this.#receiver = receiver

        this.#broadcaster = this.#terminator.own(new NoteBroadcaster(broadcaster, address))
        this.#buffer = new Array(16)
    }

    setNoteEventSource(source: NoteEventSource): Terminable {
        assert(this.#source.isEmpty(), "NoteEventSource already set")
        this.#source = Option.wrap(source)
        this.#receiver.reset()
        return Terminable.create(() => {
            this.#source = Option.None
            this.#receiver.reset()
        })
    }

    introduceBlock({index, p0, p1, flags}: Block): void {
        if (this.#source.isEmpty()) {return}
        for (const event of this.#source.unwrap().processNotes(p0, p1, flags)) {
            this.#buffer.push(event)
        }
        this.#buffer
            .sort(NoteLifecycleEvent.Comparator)
            .forEach(event => {
                if (event.pitch >= 0 && event.pitch <= 127) {
                    this.#receiver.eventInput.add(index, event)
                    this.#showEvent(event)
                }
            })
        this.#buffer.length = 0
    }

    clear(): void {}

    terminate(): void {this.#terminator.terminate()}

    #showEvent(event: Event): void {
        if (NoteLifecycleEvent.isStart(event)) {
            this.#broadcaster.noteOn(event.pitch)
        } else if (NoteLifecycleEvent.isStop(event)) {
            this.#broadcaster.noteOff(event.pitch)
        }
    }
}
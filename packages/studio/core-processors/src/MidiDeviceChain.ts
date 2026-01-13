import {assert, SortedSet, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {NoteSequencer} from "./NoteSequencer"
import {ProcessPhase} from "./processing"
import {AudioUnit} from "./AudioUnit"
import {DeviceChain} from "./DeviceChain"
import {MidiEffectDeviceAdapter} from "@moises-ai/studio-adapters"
import {MidiEffectDeviceProcessorFactory} from "./DeviceProcessorFactory"
import {NoteEventSource} from "./NoteEventSource"
import {MidiEffectProcessor} from "./MidiEffectProcessor"

type MidiEffectDeviceEntry = {
    device: MidiEffectProcessor
    subscription: Subscription
}

export class MidiDeviceChain implements DeviceChain {
    readonly #terminator = new Terminator()

    readonly #audioUnit: AudioUnit

    readonly #noteSequencer: NoteSequencer
    readonly #effects: SortedSet<UUID.Bytes, MidiEffectDeviceEntry>

    readonly #disconnector: Terminator

    #needsWiring = false

    constructor(audioUnit: AudioUnit) {
        this.#audioUnit = audioUnit

        this.#noteSequencer = this.#terminator.own(new NoteSequencer(this.#audioUnit.context, this.#audioUnit.adapter))
        this.#effects = UUID.newSet(({device}) => device.uuid)
        this.#disconnector = this.#terminator.own(new Terminator())

        this.#terminator.ownAll(
            this.#audioUnit.adapter.midiEffects.catchupAndSubscribe({
                onAdd: (adapter: MidiEffectDeviceAdapter) => {
                    this.invalidateWiring()
                    const processor = MidiEffectDeviceProcessorFactory.create(this.#audioUnit.context, adapter.box)
                    const added = this.#effects.add({
                        device: processor, subscription: processor.adapter().enabledField.subscribe(() => {
                            processor.reset()
                            this.invalidateWiring()
                        })
                    })
                    assert(added, "Could not add.")
                },
                onRemove: (adapter: MidiEffectDeviceAdapter) => {
                    this.invalidateWiring()
                    const {device, subscription} = this.#effects.removeByKey(adapter.uuid)
                    subscription.terminate()
                    device.terminate()
                },
                onReorder: (_adapter: MidiEffectDeviceAdapter) => this.invalidateWiring()
            }),
            this.#audioUnit.context.subscribeProcessPhase(phase => {
                if (phase === ProcessPhase.Before && this.#needsWiring) {
                    this.#wire()
                    this.#needsWiring = false
                }
            })
        )
    }

    get noteSequencer(): NoteSequencer {return this.#noteSequencer}

    invalidateWiring(): void {
        this.#disconnector.terminate()
        this.#needsWiring = true
    }

    terminate() {this.#terminator.terminate()}

    toString(): string {return `{${this.constructor.name}}`}

    #wire(): void {
        const optInput = this.#audioUnit.input().flatMap(unit => unit.noteEventTarget)
        if (optInput.isEmpty()) {return}
        const input = optInput.unwrap()
        let source: NoteEventSource = this.#noteSequencer
        this.#audioUnit.adapter.midiEffects.adapters()
            .map(adapter => this.#effects.get(adapter.uuid).device)
            .forEach((target: MidiEffectProcessor) => {
                if (target.adapter().enabledField.getValue()) {
                    this.#disconnector.ownAll(
                        target.setNoteEventSource(source),
                        // Makes sure, automation is applied before the actual instrument
                        // This is really ugly, but I won't refactor this now and just move on...
                        this.#audioUnit.context.registerEdge(target, input.incoming)
                    )
                    source = target
                }
            })
        this.#disconnector.own(input.setNoteEventSource(source))
    }
}
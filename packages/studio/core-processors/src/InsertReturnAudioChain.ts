import {Arrays, assert, SortedSet, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {AudioEffectDeviceAdapter, IndexedBoxAdapterCollection} from "@moises-ai/studio-adapters"
import {AudioEffectDeviceProcessorFactory} from "./DeviceProcessorFactory"
import {AudioInput, ProcessPhase} from "./processing"
import {DeviceChain} from "./DeviceChain"
import {EngineContext} from "./EngineContext"
import {Pointers} from "@moises-ai/studio-enums"
import {DeviceProcessor} from "./DeviceProcessor"
import {AudioDeviceProcessor} from "./AudioDeviceProcessor"
import {AudioEffectDeviceProcessor} from "./AudioEffectDeviceProcessor"

// TODO Open this to MidiEffects as well

type EffectDeviceEntry = {
    device: AudioEffectDeviceProcessor
    subscription: Subscription
}

export interface AudioTarget extends AudioInput, DeviceProcessor {}

export class InsertReturnAudioChain implements DeviceChain {
    static create(context: EngineContext,
                  collection: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>,
                  sourceProcessor: AudioDeviceProcessor,
                  targetProcessor: AudioTarget) {
        return new InsertReturnAudioChain(context, collection, sourceProcessor, targetProcessor)
    }

    readonly #terminator = new Terminator()

    readonly #effects: SortedSet<UUID.Bytes, EffectDeviceEntry>
    readonly #disconnector: Terminator

    #orderedEffects: Array<AudioEffectDeviceProcessor> = []
    #needsWiring = true

    private constructor(context: EngineContext,
                        collection: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>,
                        sourceProcessor: AudioDeviceProcessor,
                        targetProcessor: AudioTarget) {
        this.#effects = UUID.newSet(({device}) => device.uuid)
        this.#disconnector = this.#terminator.own(new Terminator())

        this.#terminator.ownAll(
            collection.catchupAndSubscribe({
                onAdd: (adapter: AudioEffectDeviceAdapter) => {
                    this.invalidateWiring()
                    const device = AudioEffectDeviceProcessorFactory.create(context, adapter.box)
                    const added = this.#effects.add({
                        device, subscription: device.adapter().enabledField.subscribe(() => this.invalidateWiring())
                    })
                    assert(added, "Could not add.")
                },
                onRemove: (adapter: AudioEffectDeviceAdapter) => {
                    this.invalidateWiring()
                    const {device, subscription} = this.#effects.removeByKey(adapter.uuid)
                    subscription.terminate()
                    device.terminate()
                },
                onReorder: (_adapter: AudioEffectDeviceAdapter) => this.invalidateWiring()
            }),
            context.subscribeProcessPhase(phase => {
                if (phase === ProcessPhase.Before && this.#needsWiring) {
                    let source = sourceProcessor
                    Arrays.replace(this.#orderedEffects, collection.adapters().map(({uuid}) => this.#effects.get(uuid).device))
                    for (const target of this.#orderedEffects) {
                        if (target.adapter().enabledField.getValue()) {
                            this.#disconnector.own(target.setAudioSource(source.audioOutput))
                            this.#disconnector.own(context.registerEdge(source.outgoing, target.incoming))
                            source = target
                        }
                    }
                    this.#disconnector.own(targetProcessor.setAudioSource(source.audioOutput))
                    this.#disconnector.own(context.registerEdge(source.outgoing, targetProcessor.incoming))
                    this.#needsWiring = false
                }
            })
        )
    }

    invalidateWiring(): void {
        this.#disconnector.terminate()
        this.#needsWiring = true
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#effects.forEach(({device}) => device.terminate())
        this.#effects.clear()
        this.#orderedEffects = []
    }

    toString(): string {return `{${this.constructor.name}}`}
}
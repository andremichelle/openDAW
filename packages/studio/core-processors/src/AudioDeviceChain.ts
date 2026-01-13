import {Arrays, assert, SortedSet, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {AuxSendProcessor} from "./AuxSendProcessor"
import {ChannelStripProcessor} from "./ChannelStripProcessor"
import {AudioEffectDeviceAdapter, AuxSendBoxAdapter} from "@moises-ai/studio-adapters"
import {AudioEffectDeviceProcessorFactory} from "./DeviceProcessorFactory"
import {ProcessPhase} from "./processing"
import {AudioUnit} from "./AudioUnit"
import {DeviceChain} from "./DeviceChain"
import {AudioUnitOptions} from "./AudioUnitOptions"
import {AudioDeviceProcessor} from "./AudioDeviceProcessor"
import {AudioEffectDeviceProcessor} from "./AudioEffectDeviceProcessor"

type AudioEffectDeviceEntry = {
    device: AudioEffectDeviceProcessor
    subscription: Subscription
}

export class AudioDeviceChain implements DeviceChain {
    readonly #terminator = new Terminator()

    readonly #audioUnit: AudioUnit
    readonly #options: AudioUnitOptions

    readonly #auxSends: SortedSet<UUID.Bytes, AuxSendProcessor>
    readonly #channelStrip: ChannelStripProcessor
    readonly #effects: SortedSet<UUID.Bytes, AudioEffectDeviceEntry>
    readonly #disconnector: Terminator

    #orderedEffects: Array<AudioEffectDeviceProcessor> = []
    #needsWiring = false

    constructor(audioUnit: AudioUnit, options: AudioUnitOptions) {
        this.#audioUnit = audioUnit
        this.#options = options

        this.#auxSends = UUID.newSet(device => device.adapter.uuid)
        this.#channelStrip = this.#terminator.own(new ChannelStripProcessor(this.#audioUnit.context, this.#audioUnit.adapter))
        this.#effects = UUID.newSet(({device}) => device.uuid)
        this.#disconnector = this.#terminator.own(new Terminator())

        this.#terminator.ownAll(
            this.#audioUnit.adapter.audioEffects.catchupAndSubscribe({
                onAdd: (adapter: AudioEffectDeviceAdapter) => {
                    this.invalidateWiring()
                    const processor = AudioEffectDeviceProcessorFactory.create(this.#audioUnit.context, adapter.box)
                    const added = this.#effects.add({
                        device: processor, subscription: processor.adapter().enabledField.subscribe(() => {
                            processor.incoming.reset()
                            processor.outgoing.reset()
                            this.invalidateWiring()
                        })
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
            this.#audioUnit.adapter.auxSends.catchupAndSubscribe({
                onAdd: (adapter: AuxSendBoxAdapter) => {
                    this.invalidateWiring()
                    const added = this.#auxSends.add(new AuxSendProcessor(this.#audioUnit.context, adapter))
                    assert(added, "Could not add.")
                },
                onRemove: ({uuid}: AuxSendBoxAdapter) => {
                    this.invalidateWiring()
                    this.#auxSends.removeByKey(uuid).terminate()
                },
                onReorder: (_adapter: AuxSendBoxAdapter) => {/*The index has no effect on the audio processing*/}
            }),
            this.#audioUnit.adapter.output.catchupAndSubscribe(_owner => this.invalidateWiring()),
            this.#audioUnit.context.subscribeProcessPhase(phase => {
                if (phase === ProcessPhase.Before && this.#needsWiring) {
                    this.#wire()
                    this.#needsWiring = false
                }
            })
        )
    }

    get channelStrip(): ChannelStripProcessor {return this.#channelStrip}

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

    #wire(): void {
        const isOutputUnit = this.#audioUnit.adapter.isOutput
        const context = this.#audioUnit.context
        const optInput = this.#audioUnit.input()
        const optOutput = this.#audioUnit.adapter.output.adapter.map(adapter =>
            context.getAudioUnit(adapter.deviceHost().uuid).inputAsAudioBus())
        if (optInput.isEmpty() || (optOutput.isEmpty() && !isOutputUnit)) {return}
        let source: AudioDeviceProcessor = optInput.unwrap()
        if (this.#options.includeAudioEffects) {
            Arrays.replace(this.#orderedEffects, this.#audioUnit.adapter.audioEffects
                .adapters().map(({uuid}) => this.#effects.get(uuid).device))
            for (const target of this.#orderedEffects) {
                if (target.adapter().enabledField.getValue()) {
                    this.#disconnector.own(target.setAudioSource(source.audioOutput))
                    this.#disconnector.own(context.registerEdge(source.outgoing, target.incoming))
                    source = target
                }
            }
        }
        if (this.#options.includeSends) {
            // Connect with aux sends (pre-mode) TODO Post-Mode
            this.#auxSends.forEach(auxSend => {
                const target = context.getAudioUnit(auxSend.adapter.targetBus.deviceHost().uuid)
                this.#disconnector.own(auxSend.setAudioSource(source.audioOutput))
                this.#disconnector.own(target.inputAsAudioBus().addAudioSource(auxSend.audioOutput))
                this.#disconnector.own(context.registerEdge(source.outgoing, auxSend))
                this.#disconnector.own(context.registerEdge(auxSend, target.inputAsAudioBus()))
            })
        }
        this.#disconnector.own(this.#channelStrip.setAudioSource(source.audioOutput))
        this.#disconnector.own(context.registerEdge(source.outgoing, this.#channelStrip))
        if (optOutput.nonEmpty() && !isOutputUnit) {
            const audioBus = optOutput.unwrap()
            this.#disconnector.own(audioBus.addAudioSource(this.#channelStrip.audioOutput))
            this.#disconnector.own(context.registerEdge(this.#channelStrip, audioBus))
        }
    }
}
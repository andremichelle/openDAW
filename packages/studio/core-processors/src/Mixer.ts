import {ChannelStripProcessor} from "./ChannelStripProcessor"
import {asDefined, SortedSet, Terminable, UUID} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"
import {AudioUnitBox, AuxSendBox, BoxVisitor} from "@moises-ai/studio-boxes"

export class Mixer {
    readonly #channelStrips: SortedSet<UUID.Bytes, ChannelStripProcessor>
    readonly #solo: Set<ChannelStripProcessor>
    readonly #virtualSolo: Set<ChannelStripProcessor>

    #needsUpdate: boolean = false

    constructor() {
        this.#channelStrips = UUID.newSet(processor => processor.adapter.uuid)
        this.#solo = new Set<ChannelStripProcessor>()
        this.#virtualSolo = new Set<ChannelStripProcessor>()
    }

    attachChannelStrip(channelStrip: ChannelStripProcessor): Terminable {
        this.#channelStrips.add(channelStrip)
        return Terminable.many(
            channelStrip.adapter.input.subscribe(() => this.#requestUpdateSolo()),
            channelStrip.adapter.output.subscribe(() => this.#requestUpdateSolo()),
            {
                terminate: () => {
                    this.#solo.delete(channelStrip)
                    this.#channelStrips.removeByValue(channelStrip)
                    this.#requestUpdateSolo()
                }
            }
        )
    }

    onChannelStripSoloChanged(channelStrip: ChannelStripProcessor): void {
        if (channelStrip.isSolo) {
            this.#solo.add(channelStrip)
        } else {
            this.#solo.delete(channelStrip)
        }
        this.#requestUpdateSolo()
    }

    hasChannelSolo() {return this.#solo.size > 0}

    isVirtualSolo(channelStrip: ChannelStripProcessor): boolean {
        return this.#virtualSolo.has(channelStrip)
    }

    #requestUpdateSolo(): void {
        if (this.#needsUpdate) {return}
        this.#needsUpdate = true
        this.#channelStrips.forEach(channelStrip => channelStrip.requestSoloUpdate())
    }

    // called by Channelstrip when moving on
    updateSolo(): void {
        if (!this.#needsUpdate) {return}
        this.#virtualSolo.clear()
        const touchedInputs = new Set<ChannelStripProcessor>()
        const touchedOutputs = new Set<ChannelStripProcessor>()
        const visitInputs = (channelStrip: ChannelStripProcessor) => {
            if (touchedInputs.has(channelStrip)) {return}
            touchedInputs.add(channelStrip)
            channelStrip.adapter.input.getValue().ifSome(input => {
                if (input.type === "bus") {
                    input.box.input.pointerHub
                        .filter(Pointers.AudioOutput)
                        .map(pointer => asDefined(pointer.box.accept<BoxVisitor<ChannelStripProcessor>>({
                            visitAudioUnitBox: ({address: {uuid}}: AudioUnitBox) =>
                                this.#channelStrips.get(uuid),
                            visitAuxSendBox: ({audioUnit: {targetVertex}}: AuxSendBox) =>
                                this.#channelStrips.get(targetVertex.unwrap().address.uuid)
                        }), "Could not resolve channel-strip"))
                        .forEach(channelStrip => {
                            if (!channelStrip.isSolo) {this.#virtualSolo.add(channelStrip)}
                            visitInputs(channelStrip)
                        })
                }
            })
        }
        const visitOutputs = (channelStrip: ChannelStripProcessor) => {
            if (touchedOutputs.has(channelStrip)) {return}
            touchedOutputs.add(channelStrip)
            channelStrip.adapter.output.adapter.ifSome(bus => {
                const outputChannelStrip = this.#channelStrips.get(bus.audioUnitBoxAdapter().uuid)
                if (!outputChannelStrip.isSolo) {
                    this.#virtualSolo.add(outputChannelStrip)
                    visitOutputs(outputChannelStrip)
                }
            })
        }
        this.#channelStrips.forEach((channelStrip) => {
            if (channelStrip.isSolo) {
                visitInputs(channelStrip)
                visitOutputs(channelStrip)
            }
        })
        this.#needsUpdate = false
    }
}
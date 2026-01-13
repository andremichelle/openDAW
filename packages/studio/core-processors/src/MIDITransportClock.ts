import {BlockFlag, ProcessInfo} from "./processing"
import {Fragmentor, PPQN} from "@moises-ai/lib-dsp"
import {EngineContext} from "./EngineContext"
import {Bits} from "@moises-ai/lib-std"
import {AbstractProcessor} from "./AbstractProcessor"
import {RootBoxAdapter} from "@moises-ai/studio-adapters"
import {MidiData} from "@moises-ai/lib-midi"

export class MIDITransportClock extends AbstractProcessor {
    static readonly ClockRate = PPQN.fromSignature(1, 24 * 4) // 24 pulses per quarter note

    readonly #adapter: RootBoxAdapter
    readonly #nextBlockDelivery: Array<Uint8Array>

    constructor(context: EngineContext, adapter: RootBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#nextBlockDelivery = []

        this.own(this.context.registerProcessor(this))
    }

    schedule(message: Uint8Array): void {
        this.#nextBlockDelivery.push(message)
    }

    reset(): void {this.eventInput.clear()}

    process({blocks}: ProcessInfo): void {
        const midiOutputBoxes = this.#adapter.midiOutputDevices
        if (midiOutputBoxes.length === 0) {
            this.#nextBlockDelivery.length = 0
            return
        }
        const filteredBoxes = midiOutputBoxes
            .filter(box => box.sendTransportMessages.getValue() && box.id.getValue() !== "")
        if (filteredBoxes.length === 0) {
            this.#nextBlockDelivery.length = 0
            return
        }
        filteredBoxes.forEach(box => {
            const id = box.id.getValue()
            const relativeTimeInMs = box.delayInMs.getValue()
            this.#nextBlockDelivery.forEach(message =>
                this.context.sendMIDIData(id, message, relativeTimeInMs))
            this.#nextBlockDelivery.length = 0
        })
        blocks.forEach(({p0, p1, s0, bpm, flags}) => {
            const blockOffsetInSeconds = s0 / sampleRate
            if (!Bits.every(flags, BlockFlag.transporting)) {return}
            for (const position of Fragmentor.iterate(p0, p1, MIDITransportClock.ClockRate)) {
                const eventOffsetInSeconds = PPQN.pulsesToSeconds(position - p0, bpm)
                filteredBoxes.forEach(box => {
                    const id = box.id.getValue()
                    const delayInMs = box.delayInMs.getValue()
                    const relativeTimeInMs = (blockOffsetInSeconds + eventOffsetInSeconds) * 1000.0 + delayInMs
                    this.context.sendMIDIData(id, MidiData.Clock, relativeTimeInMs)
                })
            }
        })
    }

    toString(): string {return `{${this.constructor.name}}`}
}
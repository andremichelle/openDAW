import {Arrays, Id, int} from "@moises-ai/lib-std"
import {AudioBuffer, NoteEvent} from "@moises-ai/lib-dsp"
import {Voice} from "./Voice"
import {VoicingHost} from "./VoicingHost"
import {VoicingStrategy} from "./VoicingStrategy"
import {Block} from "../processing"

export class PolyphonicStrategy implements VoicingStrategy {
    readonly #host: VoicingHost
    readonly #processing: Array<Voice> = []
    readonly #availableForGlide: Array<Voice> = []

    constructor(host: VoicingHost) {this.#host = host}

    start(event: Id<NoteEvent>): void {
        let lastFrequency: number = NaN
        for (let index = 0; index < this.#availableForGlide.length; index++) {
            const voice = this.#availableForGlide[index]
            if (!voice.gate) {
                lastFrequency = voice.currentFrequency
                this.#availableForGlide.splice(index, 1)
                break
            }
        }
        const targetFrequency = this.#host.computeFrequency(event)
        const voice = this.#host.create()
        if (isNaN(lastFrequency)) {
            voice.start(event, targetFrequency, 1.0, 0.0)
        } else {
            voice.start(event, lastFrequency, 1.0, 0.0)
            voice.startGlide(targetFrequency, this.#host.glideTime)
        }
        this.#availableForGlide.push(voice)
        this.#processing.push(voice)
    }

    stop(id: int): void {
        this.#processing.find(voice => voice.id === id)?.stop()
    }

    forceStop(): void {this.#processing.forEach(voice => voice.forceStop())}

    reset(): void {
        this.#processing.length = 0
        this.#availableForGlide.length = 0
    }

    process(output: AudioBuffer, block: Block, fromIndex: int, toIndex: int): boolean {
        output.clear(fromIndex, toIndex)
        for (let i = this.#processing.length - 1; i >= 0; i--) {
            const voice = this.#processing[i]
            if (voice.process(output, block, fromIndex, toIndex)) {
                Arrays.removeIf(this.#availableForGlide, other => other === voice)
                this.#processing.splice(i, 1)
            }
        }
        return this.#processing.length === 0
    }

    processing(): ReadonlyArray<Voice> {return this.#processing}
}
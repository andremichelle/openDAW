import {Id, int, isDefined, Nullable} from "@moises-ai/lib-std"
import {AudioBuffer, NoteEvent} from "@moises-ai/lib-dsp"
import {Voice} from "./Voice"
import {VoicingHost} from "./VoicingHost"
import {VoicingStrategy} from "./VoicingStrategy"
import {Block} from "../processing"

export class MonophonicStrategy implements VoicingStrategy {
    readonly #host: VoicingHost
    readonly #processing: Array<Voice> = []
    readonly #stack: Array<Id<NoteEvent>> = []

    #triggered: Nullable<Voice> = null // voice with the gate on
    #sounding: Nullable<Voice> = null // voice currently producing sound

    constructor(host: VoicingHost) {this.#host = host}

    start(event: Id<NoteEvent>): void {
        this.#stack.push(event)

        if (isDefined(this.#triggered)) {
            if (this.#triggered.gate) {
                this.#triggered.startGlide(this.#host.computeFrequency(event), this.#host.glideTime)
                return
            }
        }
        let lastFrequency: number = NaN
        if (isDefined(this.#sounding)) {
            lastFrequency = this.#sounding.currentFrequency
            this.#sounding.forceStop()
        }
        const voice = this.#host.create()
        const targetFrequency = this.#host.computeFrequency(event)
        if (isNaN(lastFrequency)) {
            voice.start(event, targetFrequency, 1.0, 0.0)
        } else {
            voice.start(event, lastFrequency, 1.0, 0.0)
            voice.startGlide(targetFrequency, this.#host.glideTime)
        }
        this.#triggered = voice
        this.#sounding = voice
        this.#processing.push(voice)
    }

    stop(id: int): void {
        const index = this.#stack.findIndex(event => event.id === id)
        if (index === -1) {return}
        this.#stack.splice(index, 1)
        if (!isDefined(this.#triggered)) return
        // released the topmost key and glide back if another note held
        if (index === this.#stack.length) {
            const prev = this.#stack.at(-1)
            if (isDefined(prev)) {
                this.#triggered.startGlide(this.#host.computeFrequency(prev), this.#host.glideTime)
                return
            }
        }
        if (this.#stack.length === 0) {
            this.#triggered.stop()
            this.#triggered = null
        }
    }

    forceStop(): void {this.#processing.forEach(voice => voice.forceStop())}

    reset(): void {
        this.#stack.length = 0
        this.#processing.length = 0
        this.#triggered = null
        this.#sounding = null
    }

    process(output: AudioBuffer, block: Block, fromIndex: int, toIndex: int): boolean {
        output.clear(fromIndex, toIndex)
        for (let i = this.#processing.length - 1; i >= 0; i--) {
            const voice = this.#processing[i]
            if (voice.process(output, block, fromIndex, toIndex)) {
                this.#processing.splice(i, 1)
                if (voice === this.#triggered) {this.#triggered = null}
                if (voice === this.#sounding) {this.#sounding = null}
            }
        }
        return this.#processing.length === 0
    }

    processing(): ReadonlyArray<Voice> {return this.#processing}
}
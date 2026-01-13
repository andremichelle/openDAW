import {Voice} from "./Voice"
import {bipolar, Id, int, Provider, unitValue} from "@moises-ai/lib-std"
import {AudioBuffer, Glide, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {Block} from "../processing"

export class VoiceUnison implements Voice {
    readonly #voiceFactory: Provider<Voice>
    readonly #processing: Array<Voice> = []
    readonly #glide: Glide = new Glide()
    readonly #numVoices: int

    gate: boolean = true
    id: int = -1

    constructor(voiceFactory: Provider<Voice>, numVoices: int) {
        this.#voiceFactory = voiceFactory
        this.#numVoices = numVoices
    }

    get currentFrequency(): number {return this.#glide.currentFrequency()}

    start(event: Id<NoteEvent>, frequency: number, gain: unitValue, parentSpread: bipolar): void {
        this.id = event.id
        this.#glide.init(frequency)
        if (this.#numVoices === 1) {
            const voice = this.#voiceFactory()
            voice.start(event, frequency, gain, parentSpread)
            this.#processing.push(voice)
        } else {
            for (let index = 0; index < this.#numVoices; ++index) {
                const spread = index / (this.#numVoices - 1) * 2.0 - 1.0 // [-1...+1]
                const voice = this.#voiceFactory()
                const voiceSpread = (1.0 - Math.abs(parentSpread)) * spread + parentSpread // pushes the voice to the edge
                voice.start(event, frequency, gain / Math.sqrt(this.#numVoices), voiceSpread)
                this.#processing.push(voice)
            }
        }
    }

    startGlide(targetFrequency: number, glideDuration: ppqn): void {
        this.#glide.glideTo(targetFrequency, glideDuration)
        this.#processing.forEach((voice) => voice.startGlide(targetFrequency, glideDuration))
    }

    process(output: AudioBuffer, block: Block, fromIndex: int, toIndex: int): boolean {
        this.#glide.advance(block.bpm, fromIndex, toIndex)
        for (let i = this.#processing.length - 1; i >= 0; i--) {
            const voice = this.#processing[i]
            if (voice.process(output, block, fromIndex, toIndex)) {
                this.#processing.splice(i, 1)
            }
        }
        return this.#processing.length === 0
    }

    stop(): void {
        this.#processing.forEach((voice) => voice.stop())
        this.gate = false
    }

    forceStop(): void {
        this.#processing.forEach((voice) => voice.forceStop())
        this.gate = false
    }

    processing(): ReadonlyArray<Voice> {return this.#processing}
}
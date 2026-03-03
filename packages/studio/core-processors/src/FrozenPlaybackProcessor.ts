import {int, Terminable} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {EngineContext} from "./EngineContext"
import {Block, BlockFlag, ProcessInfo, Processor} from "./processing"
import {EventBuffer} from "./EventBuffer"

export class FrozenPlaybackProcessor implements Processor, Terminable {
    readonly #context: EngineContext
    readonly #data: AudioData
    readonly #audioOutput: AudioBuffer = new AudioBuffer()
    readonly #eventInput: EventBuffer = new EventBuffer()

    #readPosition: int = -1
    #registration: Terminable

    constructor(context: EngineContext, data: AudioData) {
        this.#context = context
        this.#data = data
        this.#registration = context.registerProcessor(this)
    }

    get audioOutput(): AudioBuffer {return this.#audioOutput}
    get eventInput(): EventBuffer {return this.#eventInput}

    reset(): void {
        this.#readPosition = -1
        this.#audioOutput.clear()
    }

    process({blocks}: ProcessInfo): void {
        this.#audioOutput.clear()
        const {frames, numberOfFrames, sampleRate: dataSampleRate} = this.#data
        const framesL = frames[0]
        const framesR = frames.length > 1 ? frames[1] : frames[0]
        const [outL, outR] = this.#audioOutput.channels()
        for (const block of blocks) {
            if (!((block.flags & BlockFlag.transporting) && (block.flags & BlockFlag.playing))) {continue}
            if ((block.flags & BlockFlag.discontinuous) || this.#readPosition < 0) {
                this.#readPosition = Math.round(
                    this.#context.tempoMap.intervalToSeconds(0, block.p0) * dataSampleRate)
            }
            this.#processBlock(block, framesL, framesR, outL, outR, numberOfFrames)
        }
        this.#eventInput.clear()
    }

    #processBlock(block: Block, framesL: Float32Array, framesR: Float32Array,
                  outL: Float32Array, outR: Float32Array, numberOfFrames: int): void {
        const {s0, s1} = block
        let readPosition = this.#readPosition
        for (let i = s0; i < s1; i++) {
            if (readPosition >= 0 && readPosition < numberOfFrames) {
                outL[i] = framesL[readPosition]
                outR[i] = framesR[readPosition]
            }
            readPosition++
        }
        this.#readPosition = readPosition
    }

    terminate(): void {this.#registration.terminate()}

    toString(): string {return `{${this.constructor.name}}`}
}